/**
 * 统一项目切换清理服务。
 *
 * 解决问题：ViewerRuntime 是懒加载单例，AppState.resetGimState() 只清 state
 * 而不清 ctx.fragments / scene 中已加载的模型；线路地图 canvas 也不在 reset 范围内。
 * 这导致线路 ↔ 变电切换时，AppState 与 ViewerRuntime 状态不同步：
 *   - 切到变电后，旧线路 canvas 残留覆盖 IFC viewer
 *   - 切回变电后，旧 fragments 模型仍在 scene 中（可能与新模型重复或冲突）
 *   - hasFittedCamera 未重置，新模型加载后相机不重新 fit，导致中间只有网格
 *
 * 本服务在「打开新 GIM 前」和「清空场景」时统一执行：
 *   1. 销毁线路地图（canvas/tooltip/图层控件/事件监听）
 *   2. dispose ViewerRuntime 中所有 fragments 模型（合并 state.loadedModels 与 ctx.fragments.list）
 *   3. 重置高亮
 *   4. 清空 model-list UI
 *   5. 重置 state（resetGimState + hasFittedCamera，可选 resetAll）
 *
 * 关键顺序：必须先 dispose runtime 中的模型，再 resetGimState（reset 会清空 loadedModels 索引，
 * 但 ctx.fragments.list 中的实际 Three.js 对象不会随之消失）。
 *
 * 分层边界：属于 services 编排层，可 dynamic import viewer/ 与 ui/ 模块。
 */

import type { AppState } from '../app/state.js';

export interface CleanupOptions {
  /**
   * 是否执行完整 state.reset()（含 loadedModels.clear / highlightedItems=null / hasFittedCamera=false）。
   * - 打开新 GIM 前：false（保留 loadedModels，cleanup 内部已 dispose，resetGimState 会清字段）
   * - 清空场景：true（彻底重置）
   * 默认 false。
   */
  resetAll?: boolean;
}

/**
 * 在打开新 GIM 项目前 / 清空场景时执行统一清理。
 *
 * 幂等：ViewerRuntime 未创建时跳过 fragments 清理；无线路地图时跳过地图销毁。
 *
 * @param state 全局 AppState
 * @param options cleanup 选项
 */
export async function cleanupBeforeOpenNewProject(
  state: AppState,
  options: CleanupOptions = {},
): Promise<void> {
  const { resetAll = false } = options;

  // ---- 1. 销毁线路地图 canvas / tooltip / 图层控件 / 事件监听 ----
  // 即使 ViewerRuntime 未创建，线路地图也可能存在（线路工程不创建 Viewer）
  try {
    const { destroyLineMapView } = await import('../ui/lineProjectView.js');
    destroyLineMapView();
  } catch (err) {
    console.warn('[Cleanup] destroyLineMapView failed:', err);
  }

  // ---- 2. dispose ViewerRuntime 中所有 fragments 模型 ----
  // 必须在 resetGimState 之前执行：reset 会清空 state.loadedModels 索引，
  // 但 ctx.fragments.list 中的 Three.js 对象仍残留，需要显式 dispose
  let disposedCount = 0;
  let attemptedCount = 0;
  const { isViewerRuntimeCreated, getViewerRuntime } = await import('../viewer/viewerRuntime.js');
  if (isViewerRuntimeCreated()) {
    try {
      const runtime = await getViewerRuntime(state, () => {});
      const ctx = runtime.ctx;

      // 合并 state.loadedModels 与 ctx.fragments.list 的 modelId
      // - state.loadedModels 可能比 ctx 多（dispose 失败的残留索引）
      // - ctx.fragments.list 可能比 state 多（state 被外部 reset 但 ctx 未清）
      const ids = new Set<string>();
      for (const [modelId] of state.loadedModels) ids.add(modelId);
      for (const modelId of ctx.fragments.list.keys()) ids.add(modelId);

      attemptedCount = ids.size;
      for (const modelId of ids) {
        try {
          ctx.fragments.core.disposeModel(modelId);
          disposedCount++;
        } catch (err) {
          console.warn('[Cleanup] dispose model failed:', modelId, err);
        }
      }

      // ---- 3. 重置高亮 ----
      try {
        const { resetHighlight } = await import('../viewer/highlight.js');
        await resetHighlight(ctx, state);
      } catch (err) {
        console.warn('[Cleanup] resetHighlight failed:', err);
      }
    } catch (err) {
      console.warn('[Cleanup] ViewerRuntime cleanup failed:', err);
    }
  }
  console.log('[Cleanup] disposed viewer models:', disposedCount, '(attempted:', attemptedCount, ')');

  // ---- 4. 清空 UI 残留 ----
  // disposeModel 会触发 onItemDeleted → removeModelFromUI，但保险起见再清一次
  // 同步清空其他面板，避免上一个工程（如线路 TOWER 属性）残留到下一个工程
  const uiClearTargets: { id: string; html?: string; styleDisplay?: string }[] = [
    { id: 'model-list', html: '' },
    { id: 'cbm-tree-panel', html: '' },
    { id: 'file-dev-panel', html: '' },
    { id: 'props-drawer-body', html: '<div class="props-empty">选择层级树节点查看属性</div>' },
    { id: 'empty-tip', styleDisplay: '' },
  ];
  for (const t of uiClearTargets) {
    try {
      const el = document.getElementById(t.id);
      if (!el) continue;
      if (t.html !== undefined) el.innerHTML = t.html;
      if (t.styleDisplay !== undefined) el.style.display = t.styleDisplay;
    } catch (err) {
      console.warn(`[Cleanup] clear UI ${t.id} failed:`, err);
    }
  }

  // ---- 5. 重置 state ----
  // 必须在 dispose 之后执行：reset 会清空 state.loadedModels 索引
  if (resetAll) {
    state.reset();
  } else {
    state.resetGimState();
    // 相机状态也重置，确保新模型加载后 fitCameraToScene 能重新执行
    state.hasFittedCamera = false;
    // 显式清空 loadedModels 和 highlightedItems：
    // resetGimState 不清这两项，若 dispose 未触发 onItemDeleted，
    // state.loadedModels 会残留 stale modelId，导致 loadIfcEntry 误判"模型已加载，跳过"
    state.loadedModels.clear();
    state.highlightedItems = null;
  }
}
