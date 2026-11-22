import type { AppState } from '../../../app/state.js';
import { hasErrorCode } from '@desktop/contracts.js';
import type { validateGimCache } from '@desktop/database.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import { perfBegin, type PerfSession } from '../../../utils/perfTimings.js';
import { showLoading } from '../../../services/gimOpenCore.js';
import { logger } from '../../../utils/logger.js';
import { buildLineSemanticWarmFiles, commitLineParserResult } from './lineSourceState.js';

export async function restorePowerlineProject(
  state: AppState,
  projectId: number,
  scope: SessionScope,
  validation: Awaited<ReturnType<typeof validateGimCache>>,
  perfSession: PerfSession,
) {
  if (!scope.isCurrent()) return;

  if (validation.line_semantic_pack_status === 'valid') {
    try {
      showLoading('正在读取线路 semantic pack...');
      const endPack = perfBegin('线路 semantic pack 读取（缓存命中）', undefined, perfSession);
      const { readLineSemanticPackAll } = await scope.read(
        () => import('../../../infrastructure/native/projectFiles.js'),
      );
      const full = await scope.read(() => readLineSemanticPackAll(projectId, scope.isCurrent));
      if (!scope.isCurrent()) return;
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

      const { createDiskBackedFile } = await scope.read(
        () => import('../../../infrastructure/native/gimExtract.js'),
      );
      if (!scope.isCurrent()) return;
      const prepared = buildLineSemanticWarmFiles(projectId, full.items, (id, path, size, packed) =>
        createDiskBackedFile(id, path, size, packed, scope.isCurrent),
      );
      showLoading('正在由 Worker 恢复线路图与属性...');
      const endWorker = perfBegin(
        '线路图构建+属性解析（semantic warm Worker）',
        undefined,
        perfSession,
      );
      const { parseLineInWorker } = await scope.read(() => import('./lineParserWorkerClient.js'));
      const workerResult = await scope.read(() => parseLineInWorker(prepared.workerFiles, scope));
      if (!scope.isCurrent()) return;
      endWorker(undefined, {
        nodes: workerResult.graph.stats.total,
        worker: workerResult.timings.worker,
        workerMs: Math.round(workerResult.timings.totalMs),
        graphMs: Math.round(workerResult.timings.graphMs),
        attributesMs: Math.round(workerResult.timings.attributesMs),
      });
      if (!(await commitLineParserResult(state, workerResult, prepared.files, scope))) return;
      const attrStats = {
        famCount: workerResult.attributes.famPayloads.length,
        devCount: workerResult.attributes.devPayloads.length,
        famSources: new Set(workerResult.attributes.famPayloads.map((item) => item.normalized_path))
          .size,
        devSources: new Set(workerResult.attributes.devPayloads.map((item) => item.normalized_path))
          .size,
      };
      if (import.meta.env.DEV) {
        (
          globalThis as { __GIM_DEV_LINE_SEMANTIC_FAST_PATH__?: boolean }
        ).__GIM_DEV_LINE_SEMANTIC_FAST_PATH__ = true;
      }
      return { graph: workerResult.graph, attrStats, usedSemanticFastPath: true };
    } catch (error) {
      if (!scope.isCurrent()) return;
      const integrityFailure = hasErrorCode(
        error,
        'PACK_INVALID',
        'INDEX_INVALID',
        'PACK_TRUNCATED',
        'PROTOCOL_INVALID',
        'SOURCE_CHANGED',
        'SESSION_SUPERSEDED',
        'CANCELLED',
        'RESOURCE_LIMIT',
        'INVALID_PATH',
        'UNAUTHORIZED',
      );
      if (integrityFailure) {
        // validation 后 pack 仍可能被外部删除/截断；整体失效，
        // 交给外层回退完整解压重建，禁止 SQLite partial Runtime。
        throw error;
      }
      logger.warn('[Tauri] semantic pack fast path 不可用，回退 SQLite 线路缓存:', error);
    }
  }

  showLoading('正在从本地缓存恢复线路工程索引...');
  const endRestoreGraph = perfBegin('线路图恢复（SQLite 缓存命中）', undefined, perfSession);
  const { getLineGraph, getLineAttributes } = await scope.read(
    () => import('@desktop/database.js'),
  );
  const { buildLineGraphFromCache, publishRestoredLineGraph } = await scope.read(
    () => import('../../../services/lineGraphRestoreService.js'),
  );
  const { restoreLineAttributesToState } = await scope.read(
    () => import('../../../services/lineAttrRestoreService.js'),
  );
  const result = await scope.read(() => getLineGraph(projectId));
  if (!scope.isCurrent()) return;
  const restored = buildLineGraphFromCache(result);
  endRestoreGraph(undefined, { nodes: restored.stats.total });
  showLoading('正在从本地缓存恢复线路 FAM/DEV 属性...');
  const endRestoreAttrs = perfBegin('线路属性恢复（SQLite 缓存命中）', undefined, perfSession);
  const attrResult = await scope.read(() => getLineAttributes(projectId));
  if (!scope.isCurrent()) return;
  const attrStats = restoreLineAttributesToState(attrResult, state);
  publishRestoredLineGraph(state, restored);
  endRestoreAttrs(undefined, { fam: attrStats.famCount, dev: attrStats.devCount });
  if (import.meta.env.DEV) {
    (
      globalThis as { __GIM_DEV_LINE_SEMANTIC_FAST_PATH__?: boolean }
    ).__GIM_DEV_LINE_SEMANTIC_FAST_PATH__ = false;
  }
  return { graph: restored, attrStats, usedSemanticFastPath: false };
}
