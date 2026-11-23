import { logger } from '../../../utils/logger.js';
import * as statusPresentation from '../../../services/presentation/shell_statusBar.js';
import { reportBackgroundError } from '../../../utils/backgroundErrors.js';

/** DEV post-IFC LOD startup. The legacy MOD/STL fallback pipeline is removed. */
import type { AppState, ProjectLoadSession } from '../../../app/state.js';
import type { ViewerContext } from '../../../viewer/viewerEngine.js';
import { perfCurrentSession, perfBegin } from '../../../utils/perfTimings.js';
import { hideLoading } from '../../../services/project/gimOpenCore.js';
import { observeFirstGeometry } from '../../../services/presentation/geometryPresentationService.js';

export async function autoLoadModStlPostIfc(
  state: AppState,
  showMessage: (text: string) => void,
  existingCtx?: ViewerContext,
  options?: { session?: ProjectLoadSession },
): Promise<void> {
  let endModStl: ((labelSuffix?: string, endMeta?: Record<string, unknown>) => void) | null = null;
  let modStlEnded = false;
  try {
    const session = options?.session ?? state.captureProjectSession();
    const perfSession = perfCurrentSession();
    if (!state.isCurrentSession(session)) return;
    endModStl = perfBegin('变电 MOD/STL', undefined, perfSession);
    const finishModStl = (suffix?: string, meta?: Record<string, unknown>): void => {
      if (modStlEnded) return;
      modStlEnded = true;
      endModStl?.(suffix, meta);
    };

    let resourceCtx: ViewerContext | null = existingCtx ?? null;
    if (!resourceCtx) {
      const { getViewerRuntimeWithUI } =
        await import('../../../services/presentation/viewerUIBinding.js');
      if (!state.isCurrentSession(session)) return;
      const runtime = await getViewerRuntimeWithUI(state, showMessage);
      if (!state.isCurrentSession(session)) return;
      resourceCtx = runtime.ctx;
    }

    if (!(state.currentProjectType === 'substation' && typeof Worker !== 'undefined')) {
      logger.warn('[GIM] 当前运行环境不支持设备 LOD Worker，跳过 DEV 几何加载');
      finishModStl('（跳过）', { path: 'unsupported-runtime' });
      return;
    }

    const { startDeviceLod } = await import('../../../services/dev-geometry/devLodRuntime.js');
    if (!state.isCurrentSession(session)) return;
    if (!state.currentIfcEntries.length && !state.projectSourceToViewerMatrix) {
      const THREE = await import('three');
      if (!state.isCurrentSession(session)) return;
      state.projectSourceToViewerMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    }
    await startDeviceLod(state, resourceCtx, session, (text, detail) => {
      if (state.isCurrentSession(session)) {
        void Promise.resolve(
          Promise.resolve(statusPresentation).then(({ setDeviceStatus }) => {
            if (state.isCurrentSession(session)) setDeviceStatus(text, detail);
          }),
        ).catch(reportBackgroundError);
      }
    });
    if (!state.isCurrentSession(session)) return;
    finishModStl(undefined, { path: 'device-lod-directory', onDemand: true });
    if (state.modRootGroup) {
      void observeFirstGeometry(
        state,
        resourceCtx,
        state.modRootGroup,
        session,
        hideLoading,
        perfSession,
      ).catch(reportBackgroundError);
    }
  } catch (err) {
    if (!modStlEnded) {
      endModStl?.('（失败）', { error: err instanceof Error ? err.message : String(err) });
      modStlEnded = true;
    }
    logger.warn('[GIM] MOD/STL 自动加载失败:', err);
  }
}
