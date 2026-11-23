import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { bindMeasurementSession } from '../measurement/runtime.js';
import { configurePresentation } from './composition/presentationBindings.js';
import { AppState } from './state.js';
import { setupTabs } from '../ui/tabs.js';
import { assertShellDom } from '../ui/dom.js';
import { isTauri } from '@desktop/runtime.js';
import { DEBUG_FRAGMENTS } from '../config/debug.js';
import { debugWarn, logger } from '../utils/logger.js';
import { summarizeDiagnostic } from '../shared/diagnosticSummary.js';
import { summarizeBasemapStatus } from '../services/presentation/basemapStatusService.js';
import { setupPropsDrawerInteractions } from '../ui/propsDrawer.js';
import { showLoading, hideLoading } from '../services/project/gimOpenCore.js';
import { setupIfcDetailModeControl } from '../ui/ifcDetailModeControl.js';
import { bindProjectShell } from './composition/bindProjectShell.js';

/** 异步启动逻辑（轻量，不加载 3D 引擎） */
async function bootstrapAsync(): Promise<void> {
  assertShellDom();
  configurePresentation();
  const state = new AppState();
  bindMeasurementSession(() => state.captureProjectSession());

  // 仅供本地 Playwright acceptance harness 读取当前工程所有权计数；
  // 不参与业务判断、缓存键或调度行为。
  if (import.meta.env.DEV || import.meta.env.VITE_GIM_DIAGNOSTICS === '1')
    (globalThis as { __gimAppState?: AppState }).__gimAppState = state;

  // 开发期 A/B 采集需要区分“同一 WebView 连续打开”和“应用重启后打开”。
  // 该标识只暴露给 DEV harness，不参与业务状态或缓存键。
  if (import.meta.env.DEV) {
    const target = globalThis as { __GIM_DEV_BOOT_ID__?: string };
    const webCrypto = globalThis.crypto;
    target.__GIM_DEV_BOOT_ID__ =
      typeof webCrypto?.randomUUID === 'function'
        ? webCrypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // WebView Long Task 统计从首屏开始记录；perfReset 会在工程切换时重建
  // observer，使旧工程迟到的 PerformanceObserver 回调不会污染新 session。
  const { installLongTaskObserver } = await import('../utils/perfTimings.js');
  installLongTaskObserver();

  // 应用设置（天地图密钥、IFC 大文件跳过等）保存在本地 SQLite；
  // 页面启动时先加载，保证地图/工程打开前拿到当前配置。
  try {
    const { loadAppSettings } = await import('../services/project/appSettings.js');
    await loadAppSettings();
  } catch (error) {
    logger.warn('[settings] 加载应用设置失败:', error);
  }

  // 全局 unhandledrejection 监听（仅 Fragments 相关）：
  // - Fragments 内部异常（如 "Malformed tile"）会被 preventDefault() 捕获，避免控制台红屏
  // - 真实错误仍通过 ifcLoader.ts 的 safeFragmentsUpdate 局部 catch / console.error 处理
  // - 开发模式（DEBUG_FRAGMENTS=true）：输出完整 warning 堆栈，便于定位
  // - 生产模式（DEBUG_FRAGMENTS=false）：静默 preventDefault，不刷屏
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes('Malformed tile') || msg.includes('Fragments')) {
      debugWarn(DEBUG_FRAGMENTS, '[Global] caught fragments unhandled rejection', reason);
      event.preventDefault();
    }
  });

  // 仅绑定轻量 UI
  setupTabs();
  setupIfcDetailModeControl();
  // 属性检查器在变电工程会由 Viewer 装配；线路工程不创建 Viewer，
  // 因此必须在轻量启动阶段先安装页签/来源按钮的纯 DOM 事件委托。
  setupPropsDrawerInteractions();
  bindProjectShell(state);

  // 首屏 UI 就绪，隐藏 loading
  hideLoading();

  // Persist tree expansion when the window closes; camera is intentionally not
  // restored for substation (default open is the station overview).
  window.addEventListener('beforeunload', () => {
    void import('../services/project/viewStateStore.js')
      .then(({ saveViewState }) => {
        if (state.currentProjectType !== 'substation') return;
        saveViewState(state);
      })
      .catch(() => {
        /* best effort */
      });
  });

  // Tauri 模式：显示窗口（配置了 visible:false，消除白屏）
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().show();
    } catch (err) {
      logger.warn('[Tauri] 显示窗口失败:', err);
    }

    // 诊断快捷键：Ctrl+Shift+D → 复制诊断 JSON 到剪贴板 + 控制台输出可读摘要
    document.addEventListener('keydown', async (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        const diagnosticSession = state.captureProjectSession();
        try {
          showLoading('正在生成数据库诊断...');
          const { collectProjectDiagnostic } =
            await import('../services/project/projectDiagnosticService.js');
          const snapshot = await collectProjectDiagnostic(state);
          if (!snapshot || !state.isCurrentSession(diagnosticSession)) return;
          const { diagnostic } = snapshot;
          const { perfSummary } = await import('../utils/perfTimings.js');
          if (!state.isCurrentSession(diagnosticSession)) return;
          const payload = JSON.stringify(snapshot, null, 2);
          // Debug-only performance harness: expose the exact diagnostic payload to
          // the local CDP runner.  Production builds intentionally do not publish
          // this global, preserving the existing clipboard-only diagnostic path.
          if (import.meta.env.DEV) {
            (globalThis as { __GIM_LAST_DIAGNOSTIC__?: string }).__GIM_LAST_DIAGNOSTIC__ = payload;
          }
          // Keep the collected evidence available if clipboard access fails.
          logger.log('[诊断] 数据库诊断 JSON:\n', payload);
          await navigator.clipboard.writeText(payload);
          if (!state.isCurrentSession(diagnosticSession)) return;
          // 控制台额外输出人类可读摘要（M4-D1 延伸）
          const summary = summarizeDiagnostic({ diagnostic });
          logger.log('[诊断摘要]\n' + summary);
          // M4-A2 Finalization：附加底图状态人类可读摘要
          logger.log('[底图状态]\n' + summarizeBasemapStatus());
          logger.log('[性能埋点]\n' + perfSummary());
          showLoading(
            Object.keys(snapshot.diagnosticReadErrors).length
              ? '诊断已复制，部分数据未取得；详见诊断内容'
              : '数据库诊断信息已复制到剪贴板',
          );
          setTimeout(() => {
            if (state.isCurrentSession(diagnosticSession)) hideLoading();
          }, 2000);
        } catch (err) {
          if (!state.isCurrentSession(diagnosticSession)) return;
          logger.error('[诊断] 生成诊断信息失败:', err);
          showLoading(`诊断失败: ${err instanceof Error ? err.message : String(err)}`);
          setTimeout(() => {
            if (state.isCurrentSession(diagnosticSession)) hideLoading();
          }, 3000);
        }
      }
    });

    // Desktop acceptance export: Ctrl+Shift+B copies only the stable,
    // path-sanitized benchmark contract (no DB diagnostic or raw spans).
    // The local harness may set __GIM_BENCHMARK_SAMPLE_ID__ and
    // __GIM_BENCHMARK_COLD_WARM__ before opening a sample.
    document.addEventListener('keydown', async (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        try {
          showLoading('正在生成性能验收 JSON...');
          const { perfBenchmarkSnapshot } = await import('../utils/perfTimings.js');
          const payload = JSON.stringify(perfBenchmarkSnapshot(), null, 2);
          if (import.meta.env.DEV) {
            (globalThis as { __GIM_LAST_BENCHMARK__?: string }).__GIM_LAST_BENCHMARK__ = payload;
          }
          // Keep the measured evidence available when WebView clipboard access
          // is denied or its permission dialog remains pending.
          logger.log('[性能验收] benchmark JSON:\n', payload);
          await navigator.clipboard.writeText(payload);
          logger.log('[性能验收] benchmark JSON 已复制到剪贴板');
          showLoading('性能验收 JSON 已复制到剪贴板');
          setTimeout(hideLoading, 2000);
        } catch (err) {
          logger.error('[性能验收] benchmark JSON 导出失败:', err);
          showLoading(`性能验收导出失败: ${err instanceof Error ? err.message : String(err)}`);
          setTimeout(hideLoading, 3000);
        }
      }
    });

    // M4-B3A：悬链线参数审计导出快捷键 Ctrl+Shift+C
    // - 复制完整审计 JSON 到剪贴板（含 report.coverage / kValueSamples / splitSamples /
    //   matrix0FormatSamples / blhaElevationSamples / semanticHypotheses / blockingQuestions）
    // - 控制台输出 Markdown 摘要（前 5 条样本，便于人工核验）
    // - 仅线路工程有数据；变电工程 / 清空场景 / OSM fallback 后仍可调用
    // - 若与系统/DevTools 快捷键冲突，可改为 Ctrl+Alt+C
    document.addEventListener('keydown', async (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        try {
          const { getLatestCatenaryAuditPayload } = await import('../ui/lineProjectView.js');
          const payload = await getLatestCatenaryAuditPayload();
          if (!payload) {
            showLoading('当前没有可导出的线路悬链线参数审计数据');
            setTimeout(hideLoading, 2500);
            return;
          }
          showLoading('正在复制悬链线参数审计 JSON...');
          const jsonStr = JSON.stringify(payload, null, 2);
          await navigator.clipboard.writeText(jsonStr);
          const { formatLineCatenaryAuditMarkdown } =
            await import('../features/powerline/diagnostics/lineCatenaryAuditExportService.js');
          logger.log('[M4-B3A] 悬链线参数审计摘要\n' + formatLineCatenaryAuditMarkdown(payload));
          logger.log('[M4-B3A] 完整 JSON 已复制到剪贴板（' + jsonStr.length + ' 字节）');
          showLoading('悬链线参数审计 JSON 已复制');
          setTimeout(hideLoading, 2500);
        } catch (err) {
          logger.error('[M4-B3A] 悬链线参数审计导出失败:', err);
          showLoading(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
          setTimeout(hideLoading, 3000);
        }
      }
    });
  }
  if (import.meta.env.VITE_GIM_BENCHMARK === '1') {
    const { installBenchmarkHost } = await import('../measurement/benchmarkHost.js');
    installBenchmarkHost(state);
  }
}

/** 应用启动入口（同步包装） */
export function bootstrap(): void {
  void Promise.resolve(bootstrapAsync()).catch(reportBackgroundError);
}
