import { AppState } from './state.js';
import { setupTabs } from '../ui/tabs.js';
import { setupIfcSelectModal } from '../ui/ifcSelectModal.js';
import { btnLoadGim, btnLoadLocal, btnClear, btnCacheManager, loadingEl } from '../ui/dom.js';
import { isTauri } from '../desktop/runtime.js';
import { DEBUG_FRAGMENTS, getDebugConfigSnapshot } from '../config/debug.js';
import { debugWarn } from '../utils/logger.js';
import { summarizeDiagnostic } from '../services/diagnosticSummaryService.js';
import { getBasemapStatusSnapshot, summarizeBasemapStatus } from '../services/basemapStatusService.js';

function showLoading(text: string) { loadingEl.textContent = text; loadingEl.style.display = 'block'; }
function hideLoading() { loadingEl.style.display = 'none'; }

/** 异步启动逻辑（轻量，不加载 3D 引擎） */
async function bootstrapAsync(): Promise<void> {
  const state = new AppState();

  // 全局 unhandledrejection 监听（仅 Fragments 相关）：
  // - Fragments 内部异常（如 "Malformed tile"）会被 preventDefault() 捕获，避免控制台红屏
  // - 真实错误仍通过 ifcLoader.ts 的 safeFragmentsUpdate 局部 catch / console.error 处理
  // - 开发模式（DEBUG_FRAGMENTS=true）：输出完整 warning 堆栈，便于定位
  // - 生产模式（DEBUG_FRAGMENTS=false）：静默 preventDefault，不刷屏
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes('Malformed tile') || msg.includes('Fragments')) {
      debugWarn(DEBUG_FRAGMENTS, '[Global] caught fragments unhandled rejection', reason);
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

  // 缓存管理（M4-D2）：仅 Tauri 模式可用
  btnCacheManager.addEventListener('click', async () => {
    if (!isTauri()) {
      showLoading('缓存管理仅在桌面版可用');
      setTimeout(hideLoading, 2000);
      return;
    }
    try {
      const { openCacheManager } = await import('../ui/cacheManagerView.js');
      await openCacheManager();
    } catch (err) {
      console.error('[缓存管理] 打开失败:', err);
      showLoading(`打开缓存管理失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(hideLoading, 3000);
    }
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

    // 诊断快捷键：Ctrl+Shift+D → 复制诊断 JSON 到剪贴板 + 控制台输出可读摘要
    document.addEventListener('keydown', async (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        try {
          showLoading('正在生成数据库诊断...');
          const { getDbPath, getLatestProjectCacheDiagnostic } = await import('../desktop/database.js');
          const dbPath = await getDbPath();
          const diagnostic = await getLatestProjectCacheDiagnostic();
          const debug = getDebugConfigSnapshot();
          // M4-A2 Finalization：附带底图运行状态（仅在线路工程场景有意义，无工程时为初始 'canvas-only'）
          const basemap = getBasemapStatusSnapshot();
          const payload = JSON.stringify({ dbPath, diagnostic, debug, basemap }, null, 2);
          await navigator.clipboard.writeText(payload);
          // 完整 JSON 仍输出到控制台（便于排障）
          console.log('[诊断] 数据库诊断信息已复制到剪贴板:\n', payload);
          // 控制台额外输出人类可读摘要（M4-D1 延伸）
          const summary = summarizeDiagnostic({ diagnostic });
          console.log('[诊断摘要]\n' + summary);
          // M4-A2 Finalization：附加底图状态人类可读摘要
          console.log('[底图状态]\n' + summarizeBasemapStatus());
          showLoading('数据库诊断信息已复制到剪贴板');
          setTimeout(hideLoading, 2000);
        } catch (err) {
          console.error('[诊断] 生成诊断信息失败:', err);
          showLoading(`诊断失败: ${err instanceof Error ? err.message : String(err)}`);
          setTimeout(hideLoading, 3000);
        }
      }
    });

    // M4-B3A：悬链线参数审计导出快捷键 Ctrl+Shift+C
    // - 复制完整审计 JSON 到剪贴板（含 report.coverage / kValueSamples / splitSamples /
    //   matrix0FormatSamples / blhaElevationSamples / semanticHypotheses / blockingQuestions）
    // - 控制台输出 Markdown 摘要（前 5 条样本，便于人工核验）
    // - 仅线路工程有数据；变电工程 / 清空场景 / OSM fallback 后仍可调用
    // - 若与系统/DevTools 快捷键冲突，可改为 Ctrl+Alt+C（需同步更新 docs/dev-log.md）
    document.addEventListener('keydown', async (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        try {
          const { getLatestCatenaryAuditPayload, formatLatestCatenaryAuditMarkdown } =
            await import('../ui/lineProjectView.js');
          const payload = getLatestCatenaryAuditPayload();
          if (!payload) {
            showLoading('当前没有可导出的线路悬链线参数审计数据');
            setTimeout(hideLoading, 2500);
            return;
          }
          showLoading('正在复制悬链线参数审计 JSON...');
          const jsonStr = JSON.stringify(payload, null, 2);
          await navigator.clipboard.writeText(jsonStr);
          const markdown = formatLatestCatenaryAuditMarkdown();
          console.log('[M4-B3A] 悬链线参数审计摘要\n' + (markdown || ''));
          console.log('[M4-B3A] 完整 JSON 已复制到剪贴板（' + jsonStr.length + ' 字节）');
          showLoading('悬链线参数审计 JSON 已复制');
          setTimeout(hideLoading, 2500);
        } catch (err) {
          console.error('[M4-B3A] 悬链线参数审计导出失败:', err);
          showLoading(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
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
