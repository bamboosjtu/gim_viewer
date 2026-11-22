import type { GimRuntimeOpenContext } from '../../../services/gimOpenCore.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import type { PerfSession } from '../../../utils/perfTimings.js';
import type { GimGraph } from '@gim/powerline-core/gimGraphTypes.js';
import { validateGimCache } from '@desktop/database.js';
import { isTauri } from '@desktop/runtime.js';
import { projectPresentation } from '../../../services/projectPresentationPort.js';
import { linePresentation } from '../presentation/linePresentationPort.js';
import { buildLineProjectProjection } from '../presentation/lineProjectProjection.js';
import { restorePowerlineProject } from '../runtime/powerlineWarmRestore.js';
import { loadColdPowerlineProject } from '../runtime/powerlineColdLoad.js';
import { publishPowerlineIdentity } from '../runtime/lineSourceState.js';
import {
  currentPerfSession,
  hideLoading,
  showLoading,
  scheduleHideLoading,
} from '../../../services/gimOpenCore.js';
import { DEBUG_GIM_CACHE, DEBUG_RUNTIME_LOGS } from '../../../config/debug.js';
import { debugLog, logger } from '../../../utils/logger.js';
import { observeMap } from '../../../measurement/mapMeasurement.js';
import { perfBegin, perfMark, perfMarkProductMoment } from '../../../utils/perfTimings.js';

function getDevLineCatenaryMode(): boolean | undefined {
  if (!import.meta.env.DEV) return undefined;
  const value = (globalThis as { __GIM_DEV_CATENARY_MODE__?: unknown }).__GIM_DEV_CATENARY_MODE__;
  return typeof value === 'boolean' ? value : undefined;
}

async function presentLineProject(
  context: GimRuntimeOpenContext,
  scope: SessionScope,
  graph: GimGraph,
  perfSession: PerfSession,
): Promise<boolean> {
  if (!scope.isCurrent()) return false;
  const { state, showMessage } = context;
  const view = await linePresentation().present(
    state,
    () => buildLineProjectProjection(state, graph, perfSession),
    showMessage,
    { perfSession, enableCatenary: getDevLineCatenaryMode(), observeMapFrames: observeMap },
    scope.isCurrent,
  );
  if (view) scope.own(() => view.destroy());
  return view !== undefined && scope.isCurrent();
}

export async function openPowerlineProject(context: GimRuntimeOpenContext): Promise<void> {
  const { state, session, projectId } = context;
  const scope = state.sessionScope(session);
  if (!scope.isCurrent()) return;
  const perfSession = currentPerfSession();
  publishPowerlineIdentity(state, context.projectName);

  if (projectId != null && isTauri()) {
    try {
      const validation = await scope.read(() => validateGimCache(projectId, 'transmission_line'));
      if (!scope.isCurrent()) return;
      if (validation.valid) {
        const restored = await restorePowerlineProject(
          state,
          projectId,
          scope,
          validation,
          perfSession,
        );
        if (!restored || !scope.isCurrent()) return;
        await publishWarmLineProject(context, scope, perfSession, restored);
        return;
      }
    } catch (error) {
      if (!scope.isCurrent()) return;
      logger.warn(
        '[Powerline Runtime] warm cache restore failed, falling back to cold path:',
        error,
      );
    }
  }

  try {
    const graph = await loadColdPowerlineProject(context, scope, perfSession);
    if (!graph || !scope.isCurrent()) return;
    const endRender = perfBegin('线路面板+地图渲染', undefined, perfSession);
    if (!(await presentLineProject(context, scope, graph, perfSession)) || !scope.isCurrent())
      return;
    endRender();
    perfMarkProductMoment('navigationUiReady', { domain: 'line', cache: false }, perfSession);
    perfMarkProductMoment('interactive', { domain: 'line', cache: false }, perfSession);
    perfMark('线路工程可交互', undefined, perfSession);

    hideLoading();
    // 轻量状态提示
    showLoading('线路工程已加载，当前为地图浏览模式');
    scheduleHideLoading(scope.isCurrent, 3000);
    debugLog(DEBUG_RUNTIME_LOGS, '[GIM] 线路工程已加载（地图浏览模式），跳过 IFC 模态框');
  } catch (error) {
    if (scope.isCurrent()) throw error;
  }
}

async function publishWarmLineProject(
  context: GimRuntimeOpenContext,
  scope: SessionScope,
  perfSession: PerfSession,
  {
    graph,
    attrStats,
    usedSemanticFastPath,
  }: NonNullable<Awaited<ReturnType<typeof restorePowerlineProject>>>,
): Promise<void> {
  const { state } = context;
  const endRestoreMap = perfBegin(
    usedSemanticFastPath
      ? '线路面板+地图渲染（semantic warm）'
      : '线路面板+地图渲染（SQLite 缓存命中）',
    undefined,
    perfSession,
  );
  if (!(await presentLineProject(context, scope, graph, perfSession)) || !scope.isCurrent()) return;
  endRestoreMap(undefined, {
    nodes: graph.stats.total,
    towers: graph.stats.Tower_Device,
    wires: graph.stats.WIRE,
    crosses: graph.stats.CROSS,
  });
  perfMarkProductMoment('navigationUiReady', { domain: 'line', cache: true }, perfSession);
  perfMarkProductMoment('interactive', { domain: 'line', cache: true }, perfSession);
  perfMark(
    usedSemanticFastPath ? '线路工程可交互（semantic warm）' : '线路工程可交互（SQLite 缓存命中）',
    undefined,
    perfSession,
  );
  projectPresentation().hideEmptyState();

  hideLoading();
  state.lineCachePersistence = 'saved';
  perfMarkProductMoment(
    'lineCachePersistenceReady',
    { source: 'warm', status: 'saved' },
    perfSession,
  );
  showLoading(
    usedSemanticFastPath ? '已从 semantic pack 恢复线路工程' : '已从本地缓存恢复线路工程索引',
  );
  scheduleHideLoading(scope.isCurrent, 3000);
  if (import.meta.env.DEV) {
    (
      globalThis as { __GIM_DEV_LINE_CACHE_PERSIST_DONE__?: boolean }
    ).__GIM_DEV_LINE_CACHE_PERSIST_DONE__ = true;
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
}
