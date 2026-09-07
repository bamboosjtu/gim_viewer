import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { LineParserWorkerResult } from './lineParserWorkerClient.js';
import type { LineParserWorkerFile } from './lineParserWorker.js';
import type { GimRuntimeOpenContext } from './gimOpenCore.js';
import { currentPerfSession, getDevLineBatchOptions, getDevLineCatenaryMode, hideLoading, showLoading } from './gimOpenCore.js';
import { emptyTipEl } from '../ui/dom.js';
import { isTauri } from '@desktop/runtime.js';
import { DEBUG_GIM_CACHE, DEBUG_RUNTIME_LOGS } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import {
  perfBegin,
  perfMark,
} from '../utils/perfTimings.js';
import { setProjectIdentity, refreshNavigatorTitle } from '../ui/shell/projectBar.js';
import { validateGimCache } from '@desktop/database.js';

export async function commitLineParserResult(
  state: AppState,
  result: LineParserWorkerResult,
  files: Map<string, File>,
  session: ProjectLoadSession,
): Promise<boolean> {
  // 动态 import 也属于异步边界；必须在任何 AppState 写入前完成，避免
  // 工程切换恰好发生在 import 期间时留下“图已是 A、属性仍是 B”的半提交。
  const { restoreLineAttributesToState } = await import('./lineAttrRestoreService.js');
  if (!state.isCurrentSession(session)) return false;
  state.currentGimGraph = result.graph;
  state.currentFiles = files;
  restoreLineAttributesToState({
    fam_properties: result.attributes.famPayloads,
    dev_properties: result.attributes.devPayloads,
  }, state);
  return state.isCurrentSession(session);
}

export function buildLineSemanticWarmFiles(
  projectId: number,
  items: Array<{ entry_path: string; packed: boolean; size: number; bytes: Uint8Array | null }>,
  createDiskFile: (projectId: number, entryPath: string, size: number, semanticPackBacked?: boolean) => File,
): { files: Map<string, File>; workerFiles: LineParserWorkerFile[] } {
  const files = new Map<string, File>();
  const workerFiles: LineParserWorkerFile[] = [];
  for (const item of items) {
    const path = item.entry_path;
    // currentFiles 永远保持 lazy；即使语义 bytes 已返回给 Worker，也不再
    // 复制到 Blob/File。大 MOD/STL 的 metadata-only 条目同样可按需来源追溯。
    files.set(path, createDiskFile(projectId, path, item.size, item.packed));
    if (item.packed && item.bytes) {
      const bytes = item.bytes;
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer as ArrayBuffer
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      workerFiles.push({ path, bytes: buffer });
    } else {
      // Worker 只需要路径元数据来保持 filesByType（尤其 MOD/STL）统计，
      // 不把大几何文件送入解析线程。
      workerFiles.push({ path, bytes: new ArrayBuffer(0) });
    }
  }
  return { files, workerFiles };
}

export async function openPowerlineProject(context: GimRuntimeOpenContext): Promise<void> {
  const { state, session, showMessage } = context;
  const perfSession = currentPerfSession();
  state.currentProjectType = 'transmission_line';
  state.projectName = context.projectName;
  setProjectIdentity(context.projectName || null, 'transmission_line');
  refreshNavigatorTitle();
  let validation: Awaited<ReturnType<typeof validateGimCache>> | null = null;

  if (context.projectId != null && isTauri()) {
    try {
      validation = await validateGimCache(context.projectId, 'transmission_line');
    } catch (error) {
      console.warn('[Powerline Runtime] cache validation failed, falling back to cold path:', error);
    }
    if (!state.isCurrentSession(session)) return;
  }

  if (validation?.valid) {
    try {
            state.currentProjectType = 'transmission_line';
            setProjectIdentity(context.projectName || null, 'transmission_line');
            refreshNavigatorTitle();
            let graph!: Awaited<ReturnType<typeof import('./lineParserWorkerClient.js').parseLineInWorker>>['graph'];
            let attrStats!: { famCount: number; devCount: number; famSources: number; devSources: number };
            let usedSemanticFastPath = false;

            if (validation.line_semantic_pack_status === 'valid') {
              try {
                showLoading('正在读取线路 semantic pack...');
                const endPack = perfBegin('线路 semantic pack 读取（缓存命中）', undefined, perfSession);
                const { readLineSemanticPackAll } = await import('@desktop/database.js');
                const full = await readLineSemanticPackAll(context.projectId!);
                if (!state.isCurrentSession(session)) return;
                endPack(undefined, {
                  entries: full.profile.entryCount,
                  packed: full.profile.packedCount,
                  bytes: full.profile.bytes,
                  indexMs: full.profile.indexMs,
                  resolveMs: full.profile.resolveMs,
                  readMs: full.profile.readMs,
                  encodeMs: full.profile.encodeMs,
                  totalMs: full.profile.totalMs,
                });

                const { createDiskBackedFile } = await import('@desktop/gimExtract.js');
                const prepared = buildLineSemanticWarmFiles(context.projectId!, full.items, createDiskBackedFile);
                showLoading('正在由 Worker 恢复线路图与属性...');
                const endWorker = perfBegin('线路图构建+属性解析（semantic warm Worker）', undefined, perfSession);
                const { parseLineInWorker } = await import('./lineParserWorkerClient.js');
                const workerResult = await parseLineInWorker(prepared.workerFiles, session);
                if (!state.isCurrentSession(session)) return;
                endWorker(undefined, {
                  nodes: workerResult.graph.stats.total,
                  worker: workerResult.timings.worker,
                  workerMs: Math.round(workerResult.timings.totalMs),
                  graphMs: Math.round(workerResult.timings.graphMs),
                  attributesMs: Math.round(workerResult.timings.attributesMs),
                });
                if (!await commitLineParserResult(state, workerResult, prepared.files, session)) return;
                graph = workerResult.graph;
                attrStats = {
                  famCount: workerResult.attributes.famPayloads.length,
                  devCount: workerResult.attributes.devPayloads.length,
                  famSources: new Set(workerResult.attributes.famPayloads.map((item) => item.normalized_path)).size,
                  devSources: new Set(workerResult.attributes.devPayloads.map((item) => item.normalized_path)).size,
                };
                usedSemanticFastPath = true;
                if (import.meta.env.DEV) {
                  (globalThis as { __GIM_DEV_LINE_SEMANTIC_FAST_PATH__?: boolean }).__GIM_DEV_LINE_SEMANTIC_FAST_PATH__ = true;
                }
              } catch (error) {
                const kind = (error as { kind?: unknown } | null)?.kind;
                const message = error instanceof Error ? error.message : String(error);
                const integrityFailure = kind === 'PACK_INVALID'
                  || kind === 'INDEX_INVALID'
                  || kind === 'PACK_TRUNCATED'
                  || /^(PACK_INVALID|INDEX_INVALID|PACK_TRUNCATED)\s*:/i.test(message);
                if (integrityFailure) {
                  // validation 后 pack 仍可能被外部删除/截断；整体失效，
                  // 交给外层回退完整解压重建，禁止 SQLite partial Runtime。
                  throw error;
                }
                console.warn('[Tauri] semantic pack fast path 不可用，回退 SQLite 线路缓存:', error);
              }
            }

            if (!usedSemanticFastPath) {
              showLoading('正在从本地缓存恢复线路工程索引...');
              const endRestoreGraph = perfBegin('线路图恢复（SQLite 缓存命中）', undefined, perfSession);
              const { getLineGraph, getLineAttributes } = await import('@desktop/database.js');
              const { restoreLineGraphToState } = await import('./lineGraphRestoreService.js');
              const { restoreLineAttributesToState } = await import('./lineAttrRestoreService.js');
              const result = await getLineGraph(context.projectId!);
              if (!state.isCurrentSession(session)) return;
              graph = restoreLineGraphToState(state, result);
              endRestoreGraph(undefined, { nodes: graph.stats.total });
              showLoading('正在从本地缓存恢复线路 FAM/DEV 属性...');
              const endRestoreAttrs = perfBegin('线路属性恢复（SQLite 缓存命中）', undefined, perfSession);
              const attrResult = await getLineAttributes(context.projectId!);
              if (!state.isCurrentSession(session)) return;
              attrStats = restoreLineAttributesToState(attrResult, state);
              endRestoreAttrs(undefined, { fam: attrStats.famCount, dev: attrStats.devCount });
              if (import.meta.env.DEV) {
                (globalThis as { __GIM_DEV_LINE_SEMANTIC_FAST_PATH__?: boolean }).__GIM_DEV_LINE_SEMANTIC_FAST_PATH__ = false;
              }
            }

            const { renderLineProjectPanels } = await import('../ui/lineProjectView.js');
            if (!state.isCurrentSession(session)) return;
            const endRestoreMap = perfBegin(
              usedSemanticFastPath ? '线路面板+地图渲染（semantic warm）' : '线路面板+地图渲染（SQLite 缓存命中）',
              undefined,
              perfSession,
            );
            renderLineProjectPanels(state, graph, showMessage, {
              perfSession,
              enableCatenary: getDevLineCatenaryMode(),
            });
            endRestoreMap(undefined, {
              nodes: graph.stats.total,
              towers: graph.stats.Tower_Device,
              wires: graph.stats.WIRE,
              crosses: graph.stats.CROSS,
            });
            perfMark(
              usedSemanticFastPath ? '线路工程可交互（semantic warm）' : '线路工程可交互（SQLite 缓存命中）',
              undefined,
              perfSession,
            );
            emptyTipEl.style.display = 'none';

            hideLoading();
            showLoading(usedSemanticFastPath ? '已从 semantic pack 恢复线路工程' : '已从本地缓存恢复线路工程索引');
            setTimeout(hideLoading, 3000);
            if (import.meta.env.DEV) {
              (globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = true;
            }
            debugLog(DEBUG_GIM_CACHE, '[Tauri] 线路工程缓存短路生效：未读取原始 GIM，未执行解压', {
              project_id: context.projectId!,
              nodes: graph.stats.total,
              famProperties: attrStats.famCount,
              devProperties: attrStats.devCount,
              famSources: attrStats.famSources,
              devSources: attrStats.devSources,
              semanticFastPath: usedSemanticFastPath,
            });
             return; // 线路工程缓存命中，短路完成
    } catch (error) {
      if (!state.isCurrentSession(session)) return;
      console.warn('[Powerline Runtime] warm cache restore failed, falling back to cold path:', error);
    }
  }

  const extractedSource = await context.getExtracted();
  if (!state.isCurrentSession(session)) return;
  const extracted = extractedSource.files;
  state.projectName = context.projectName;
  setProjectIdentity(context.projectName || null, 'transmission_line');
  refreshNavigatorTitle();
    // 线路工程流程：先按批次准备可转移的文本输入，再由 Line Parser Worker
    // 一次完成 GimGraph + FAM/DEV 属性解析；不走 IFC/Viewer 流程。
    showLoading('正在批量读取线路 CBM/FAM/DEV 文件...');
    const endInput = perfBegin('线路解析输入', undefined, perfSession);
    const { readLineParserInput } = await import('./lineParserInput.js');
    const lineBatchOptions = getDevLineBatchOptions();
    const parserInput = await readLineParserInput(extracted, session.projectId, {
      ...lineBatchOptions,
      isCurrent: () => state.isCurrentSession(session),
    });
    if (parserInput.cancelled || !state.isCurrentSession(session)) return;
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
    const { parseLineInWorker } = await import('./lineParserWorkerClient.js');
    let workerResult: Awaited<ReturnType<typeof parseLineInWorker>>;
    try {
      workerResult = await parseLineInWorker(parserInput.files, session);
    } catch (error) {
      // 清理工程时主动终止旧 Worker 会拒绝其 promise；这是正常的取消，
      // 不应被外层打开流程误报为“GIM 解析失败”。当前工程的真实错误仍上抛。
      if (!state.isCurrentSession(session)) return;
      throw error;
    }
    if (!state.isCurrentSession(session)) return;
    const graph = workerResult.graph;
    const attrResult = workerResult.attributes;
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
    if (!await commitLineParserResult(state, workerResult, extracted, session)) return;

    // v5: 首次导入 → 解析 FAM/DEV 属性 → 恢复到 state → 渲染面板。
    // 注意：render 必须在 restore attrs 之后，否则 extractLineMapData 拿不到
    //       FAM/DEV 属性，塔位编号/塔型/呼高/转角等 tooltip 字段会缺失。
    // SQLite 事务写入移到首帧之后，避免数万节点/属性的 JSON + IPC 把“可交互”
    // 阻塞数秒；save_line_project_finish 仍是缓存提交点，写入失败不会把
    // 半成品标记为有效缓存。
    if (context.projectId != null && isTauri()) {
      if (import.meta.env.DEV) {
        // 真实 Tauri 性能采集需要知道后台入库何时完成，才能在诊断快照中
        // 同时看到该 span，并避免下一次 cold run 删除缓存时与旧写入交错。
        (globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = false;
      }
      const persistLineCache = async (): Promise<void> => {
        if (!state.isCurrentSession(session)) return;
        try {
          const { estimatePayloadSizeMB } = await import('./lineAttrPersistenceService.js');
          const { buildLineGraphPayload } = await import('./lineGraphPersistenceService.js');
          const { saveLineProjectCache } = await import('@desktop/database.js');
          if (!state.isCurrentSession(session)) return;

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
            console.warn(
              `[LineCache] payload 较大 (${Math.round(estimatedMB * 100) / 100} MB)，后台一次性 invoke 可能较慢`,
            );
          }

          const endSave = perfBegin('线路 SQLite 入库（后台）', undefined, perfSession);
          const t0 = performance.now();
          if (!state.isCurrentSession(session)) return;
          await saveLineProjectCache(
            context.projectId!,
            graphPayload,
            attrResult.famPayloads,
            attrResult.devPayloads,
            undefined,
            session.sourceSha256,
            graphPayloadBytes,
          );
          if (!state.isCurrentSession(session)) return;
          const elapsedMs = Math.round(performance.now() - t0);
          endSave(undefined, { ms: elapsedMs, background: true });
          debugLog(DEBUG_GIM_CACHE, '[LineCache] 后台 save_line_project_cache 完成，耗时', elapsedMs, 'ms');
        } catch (err) {
          // 工程切换后的旧任务不应在新工程控制台制造错误噪声。
          if (state.isCurrentSession(session)) {
            console.error('[Tauri] 线路工程缓存后台写入失败:', err);
          }
        } finally {
          if (import.meta.env.DEV && state.isCurrentSession(session)) {
            (globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = true;
          }
        }
      };
      // 让浏览器先完成首帧绘制并返回可交互状态，再开始 JSON/SQLite IPC。
      window.setTimeout(() => { void persistLineCache(); }, 0);
    } else if (import.meta.env.DEV) {
      (globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = true;
    }

    // 渲染面板（在属性恢复之后，确保地图 tooltip/标签有完整 FAM/DEV 属性）
    if (!state.isCurrentSession(session)) return;
    const endRender = perfBegin('线路面板+地图渲染', undefined, perfSession);
    const { renderLineProjectPanels } = await import('../ui/lineProjectView.js');
    renderLineProjectPanels(state, graph, showMessage, {
      perfSession,
      enableCatenary: getDevLineCatenaryMode(),
    });
    endRender();
    perfMark('线路工程可交互', undefined, perfSession);

    hideLoading();
    // 轻量状态提示
    showLoading('线路工程已加载，当前为地图浏览模式');
    setTimeout(hideLoading, 3000);
    debugLog(DEBUG_RUNTIME_LOGS, '[GIM] 线路工程已加载（地图浏览模式），跳过 IFC 模态框');
    return;

}
