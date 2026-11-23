import type { GimRuntimeOpenContext } from '../../../services/project/gimOpenCore.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import type { PerfSession } from '../../../utils/perfTimings.js';
import type { LineParserWorkerResult } from './lineParserWorkerClient.js';
import { commitLineParserResult, publishPowerlineIdentity } from './lineSourceState.js';
import { isTauri } from '@desktop/runtime.js';
import { DEBUG_GIM_CACHE } from '../../../config/debug.js';
import { perfBegin, perfMark, perfMarkProductMoment } from '../../../utils/perfTimings.js';
import { debugLog, logger } from '../../../utils/logger.js';
import { reportBackgroundError } from '../../../utils/backgroundErrors.js';
import { showLoading } from '../../../services/project/gimOpenCore.js';

function getDevLineBatchOptions(): { maxFiles?: number; maxBytes?: number } {
  if (!import.meta.env.DEV) return {};
  const globals = globalThis as {
    __GIM_DEV_LINE_BATCH_MAX_FILES__?: unknown;
    __GIM_DEV_LINE_BATCH_MAX_BYTES__?: unknown;
  };
  const asPositiveInt = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const integer = Math.floor(value);
    return integer > 0 ? integer : undefined;
  };
  return {
    maxFiles: asPositiveInt(globals.__GIM_DEV_LINE_BATCH_MAX_FILES__),
    maxBytes: asPositiveInt(globals.__GIM_DEV_LINE_BATCH_MAX_BYTES__),
  };
}

export async function loadColdPowerlineProject(
  context: GimRuntimeOpenContext,
  scope: SessionScope,
  perfSession: PerfSession,
) {
  const { state, session } = context;
  const extractedSource = await scope.read(() => context.getExtracted());
  if (extractedSource.status === 'cancelled') return;
  if (!scope.isCurrent()) return;
  const extracted = extractedSource.files;
  publishPowerlineIdentity(state, context.projectName);
  // 线路工程流程：先按批次准备可转移的文本输入，再由 Line Parser Worker
  // 一次完成 GimGraph + FAM/DEV 属性解析；不走 IFC/Viewer 流程。
  showLoading('正在批量读取线路 CBM/FAM/DEV 文件...');
  const endInput = perfBegin('线路解析输入', undefined, perfSession);
  const { readLineParserInput } = await scope.read(() => import('./lineParserInput.js'));
  const lineBatchOptions = getDevLineBatchOptions();
  const parserInput = await readLineParserInput(extracted, session.projectId, {
    ...lineBatchOptions,
    isCurrent: scope.isCurrent,
  });
  if (parserInput.cancelled || !scope.isCurrent()) return;
  endInput(undefined, {
    files: parserInput.files.length,
    requested: parserInput.requested,
    bytes: parserInput.bytes,
    batches: parserInput.batches,
    semanticPackReads: parserInput.semanticPackReads,
    skippedLargeModFiles: parserInput.skippedLargeModFiles,
    skippedLargeModBytes: parserInput.skippedLargeModBytes,
    maxFiles: lineBatchOptions.maxFiles ?? 1024,
    maxBytes: lineBatchOptions.maxBytes ?? 8 * 1024 * 1024,
  });
  showLoading('正在后台解析线路 CBM 与属性...');
  const endGraph = perfBegin('线路图构建+属性解析', undefined, perfSession);
  const { parseLineInWorker } = await scope.read(() => import('./lineParserWorkerClient.js'));
  const workerResult = await scope.read(() => parseLineInWorker(parserInput.files, scope));
  if (!scope.isCurrent()) return;
  const graph = workerResult.graph;
  endGraph(undefined, {
    nodes: graph.stats.total,
    files: parserInput.files.length,
    bytes: parserInput.bytes,
    batches: parserInput.batches,
    worker: workerResult.timings.worker,
    workerMs: Math.round(workerResult.timings.totalMs),
    graphMs: Math.round(workerResult.timings.graphMs),
    attributesMs: Math.round(workerResult.timings.attributesMs),
  });
  perfMark('线路图就绪', { nodes: graph.stats.total }, perfSession);
  // Worker 的属性结果与缓存命中结构同构；cold/warm 共用同一提交边界。
  if (!(await commitLineParserResult(state, workerResult, extracted, scope))) return;

  scheduleLinePersistence(context, scope, perfSession, workerResult);
  return graph;
}

function scheduleLinePersistence(
  context: GimRuntimeOpenContext,
  scope: SessionScope,
  perfSession: PerfSession,
  workerResult: LineParserWorkerResult,
) {
  const { state, session } = context;
  const { graph, attributes: attrResult } = workerResult;
  if (context.projectId != null && isTauri()) {
    state.lineCachePersistence = 'saving';
    if (import.meta.env.DEV) {
      // 真实 Tauri 性能采集需要知道后台入库何时完成，才能在诊断快照中
      // 同时看到该 span，并避免下一次 cold run 删除缓存时与旧写入交错。
      (
        globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }
      ).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = false;
    }
    const persistLineCache = async (): Promise<void> => {
      if (!scope.isCurrent()) return;
      try {
        const { estimatePayloadSizeMB } = await import('./lineAttrPersistenceService.js');
        const { buildLineGraphPayload } = await import('./lineGraphPersistenceService.js');
        const { saveLineProjectCache } = await import('@desktop/database.js');
        if (!scope.isCurrent()) return;

        const graphPayload = buildLineGraphPayload(context.projectId!, graph, session.sourceSha256);

        // 性能日志：payload 统计 + 风险评估。graphPayloadJson 同时作为
        // invokeTimed 的已知 requestBytes，避免监控再次 JSON.stringify。
        const graphPayloadJson = JSON.stringify(graphPayload);
        const graphPayloadBytes = new TextEncoder().encode(graphPayloadJson).byteLength;
        const estimatedMB = estimatePayloadSizeMB(
          graphPayloadJson,
          attrResult.famPayloads,
          attrResult.devPayloads,
        );
        debugLog(DEBUG_GIM_CACHE, '[LineCache] 线路后台入库 payload 统计:', {
          nodes: graphPayload.nodes.length,
          children: graphPayload.children.length,
          refs: graphPayload.refs.length,
          fam_props: attrResult.famPayloads.length,
          dev_props: attrResult.devPayloads.length,
          estimatedJsonSizeMB: Math.round(estimatedMB * 100) / 100,
        });
        if (estimatedMB > 50) {
          logger.warn(
            `[LineCache] payload 较大 (${Math.round(estimatedMB * 100) / 100} MB)，后台一次性 invoke 可能较慢`,
          );
        }

        const endSave = perfBegin('线路 SQLite 入库（后台）', undefined, perfSession);
        const t0 = performance.now();
        if (!scope.isCurrent()) return;
        await saveLineProjectCache(
          context.projectId!,
          graphPayload,
          attrResult.famPayloads,
          attrResult.devPayloads,
          undefined,
          session.sourceSha256,
          graphPayloadBytes,
        );
        if (!scope.isCurrent()) return;
        state.lineCachePersistence = 'saved';
        perfMarkProductMoment(
          'lineCachePersistenceReady',
          { source: 'cold', status: 'saved' },
          perfSession,
        );
        const elapsedMs = Math.round(performance.now() - t0);
        endSave(undefined, { ms: elapsedMs, background: true });
        debugLog(
          DEBUG_GIM_CACHE,
          '[LineCache] 后台 save_line_project_cache 完成，耗时',
          elapsedMs,
          'ms',
        );
      } catch (err) {
        // 工程切换后的旧任务不应在新工程控制台制造错误噪声。
        if (scope.isCurrent()) {
          state.lineCachePersistence = 'failed';
          perfMarkProductMoment(
            'lineCachePersistenceReady',
            { source: 'cold', status: 'failed' },
            perfSession,
          );
          logger.error('[Tauri] 线路工程缓存后台写入失败:', err);
        }
      } finally {
        if (import.meta.env.DEV && scope.isCurrent()) {
          (
            globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }
          ).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = true;
        }
      }
    };
    // 让浏览器先完成首帧绘制并返回可交互状态，再开始 JSON/SQLite IPC。
    const timer = window.setTimeout(() => {
      releaseTimer();
      void persistLineCache().catch(reportBackgroundError);
    }, 0);
    const releaseTimer = scope.own(() => window.clearTimeout(timer));
  } else {
    state.lineCachePersistence = 'not-applicable';
    if (import.meta.env.DEV)
      (
        globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }
      ).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = true;
  }
}
