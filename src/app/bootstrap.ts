import { AppState } from './state.js';
import { setupTabs } from '../ui/tabs.js';
import { setupIfcSelectModal } from '../ui/ifcSelectModal.js';
import { btnLoadGim, btnLoadLocal, btnClear, loadingEl } from '../ui/dom.js';

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }

/** 异步启动逻辑（轻量，不加载 3D 引擎） */
async function bootstrapAsync(): Promise<void> {
  const state = new AppState();

  // 仅绑定轻量 UI
  setupTabs();
  setupIfcSelectModal({
    onLoadSelected: async () => {
      const { getViewerRuntime } = await import('../viewer/viewerRuntime.js');
      const { loadSelectedIfcFiles } = await import('../services/openGimService.js');
      const runtime = await getViewerRuntime(state, (text) => showLoading(text));
      await loadSelectedIfcFiles(runtime.ctx, state, runtime.modelCallbacks);
    },
  });

  // 打开 GIM：首次点击时才加载 3D 引擎
  btnLoadGim.addEventListener('click', async () => {
    showLoading('正在加载 3D 引擎...');
    try {
      const { getViewerRuntime } = await import('../viewer/viewerRuntime.js');
      const { openGimWithDialog } = await import('../services/openGimService.js');
      const runtime = await getViewerRuntime(state, (text) => showLoading(text));
      await openGimWithDialog(runtime.ctx, state, (text) => showLoading(text));
    } catch (err) {
      console.error(err);
      showLoading(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    }
  });

  // 打开 IFC：首次点击时才加载 3D 引擎
  btnLoadLocal.addEventListener('click', async () => {
    showLoading('正在加载 3D 引擎...');
    try {
      const { getViewerRuntime } = await import('../viewer/viewerRuntime.js');
      const { openIfcWithDialog } = await import('../services/openIfcService.js');
      const runtime = await getViewerRuntime(state, (text) => showLoading(text));
      await openIfcWithDialog(runtime.ctx, state, runtime.modelCallbacks);
    } catch (err) {
      console.error(err);
      showLoading(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    }
  });

  // 清空场景
  btnClear.addEventListener('click', async () => {
    // 如果 viewer runtime 已创建，先清理 fragments 和高亮（reset 前读取 loadedModels）
    const { isViewerRuntimeCreated, getViewerRuntime } = await import('../viewer/viewerRuntime.js');
    if (isViewerRuntimeCreated()) {
      const runtime = await getViewerRuntime(state, () => {});
      for (const [modelId] of state.loadedModels) {
        runtime.ctx.fragments.core.disposeModel(modelId);
      }
      const { resetHighlight } = await import('../viewer/highlight.js');
      await resetHighlight(runtime.ctx, state);
    }
    // 再清空 state 和 UI
    state.reset();
    document.getElementById('model-list')!.innerHTML = '';
    document.getElementById('cbm-tree-panel')!.innerHTML = '';
    document.getElementById('file-dev-panel')!.innerHTML = '';
    document.getElementById('props-drawer-body')!.innerHTML = '<div class="props-empty">选择层级树节点查看属性</div>';
    document.getElementById('empty-tip')!.style.display = '';
  });

  // 首屏立即显示，3D 引擎延迟到首次用户操作
  hideLoading();
}

/** 应用启动入口（同步包装） */
export function bootstrap(): void {
  bootstrapAsync();
}
