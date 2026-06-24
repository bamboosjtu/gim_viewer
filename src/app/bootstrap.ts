import { AppState } from './state.js';
import { setupTabs } from '../ui/tabs.js';
import { setupIfcSelectModal } from '../ui/ifcSelectModal.js';
import { btnLoadGim, btnLoadLocal, btnClear, loadingEl } from '../ui/dom.js';
import { isTauri } from '../desktop/runtime.js';

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

  // 打开 GIM：对话框立即弹出，3D 延迟到需要时
  btnLoadGim.addEventListener('click', async () => {
    try {
      const { openGimWithDialog } = await import('../services/openGimService.js');
      await openGimWithDialog(state, (text) => showLoading(text));
    } catch (err) {
      console.error(err);
      showLoading(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    }
  });

  // 打开 IFC：对话框立即弹出，3D 延迟到需要时
  btnLoadLocal.addEventListener('click', async () => {
    try {
      const { openIfcWithDialog } = await import('../services/openIfcService.js');
      await openIfcWithDialog(state, (text) => showLoading(text));
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

  // 首屏 UI 就绪，隐藏 loading
  hideLoading();

  // Tauri 模式：显示窗口（配置了 visible:false，消除白屏）
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().show();
    } catch (err) {
      console.warn('[Tauri] 显示窗口失败:', err);
    }
  }
}

/** 应用启动入口（同步包装） */
export function bootstrap(): void {
  bootstrapAsync();
}
