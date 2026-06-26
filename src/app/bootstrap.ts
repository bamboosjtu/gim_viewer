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

  // 全局 unhandledrejection 诊断（仅 Fragments 相关，避免控制台红屏）
  // 这不是根本修复，只是确认错误来源；长期应依赖 ifcLoader.ts 里的 safeFragmentsUpdate
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes('Malformed tile') || msg.includes('Fragments')) {
      console.warn('[Global] caught fragments unhandled rejection', reason);
      event.preventDefault();
    }
  });

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
    // 统一走 cleanupBeforeOpenNewProject：销毁线路地图 + dispose 所有 fragments 模型
    // （合并 state.loadedModels 与 ctx.fragments.list，避免 state 与 ctx 不同步）+
    // 重置高亮 + 清空所有 UI 面板 + resetAll（state.reset 含 loadedModels.clear）
    const { cleanupBeforeOpenNewProject } = await import('../services/projectCleanupService.js');
    await cleanupBeforeOpenNewProject(state, { resetAll: true });
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

    // 诊断快捷键：Ctrl+Shift+D → 复制诊断 JSON 到剪贴板
    document.addEventListener('keydown', async (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        try {
          showLoading('正在生成数据库诊断...');
          const { getDbPath, getLatestProjectCacheDiagnostic } = await import('../desktop/database.js');
          const dbPath = await getDbPath();
          const diagnostic = await getLatestProjectCacheDiagnostic();
          const payload = JSON.stringify({ dbPath, diagnostic }, null, 2);
          await navigator.clipboard.writeText(payload);
          console.log('[诊断] 数据库诊断信息已复制到剪贴板:\n', payload);
          showLoading('数据库诊断信息已复制到剪贴板');
          setTimeout(hideLoading, 2000);
        } catch (err) {
          console.error('[诊断] 生成诊断信息失败:', err);
          showLoading(`诊断失败: ${err instanceof Error ? err.message : String(err)}`);
          setTimeout(hideLoading, 3000);
        }
      }
    });
  }
}

/** 应用启动入口（同步包装） */
export function bootstrap(): void {
  bootstrapAsync();
}
