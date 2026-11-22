import type { GimRuntimeOpenContext } from './gimOpenCore.js';
import { hideLoading } from './gimOpenCore.js';
import { setDeviceStatus } from './presentation/shell_statusBar.js';
import { perfCurrentSession, perfMarkProductMoment } from '../utils/perfTimings.js';
import { isUsableAffineMatrix } from '../gim/geometry/affineMatrix.js';
import { observeFirstGeometry } from './geometryPresentationService.js';
import { logger } from '../utils/logger.js';

/** Start shared DEV geometry from a source tree already published by its feature. */
export async function startGeometryOnlyView({
  state,
  session,
  showMessage,
}: Pick<GimRuntimeOpenContext, 'state' | 'session' | 'showMessage'>): Promise<void> {
  const scope = state.sessionScope(session),
    current = scope.isCurrent;
  if (!current()) return;
  const perf = perfCurrentSession();
  let releasePresentation: (() => void) | undefined;
  try {
    const [{ getViewerRuntimeWithUI }, { startDeviceLod }, { fitCameraToScene }, THREE] =
      await Promise.all([
        import('./viewerUIBinding.js'),
        import('./devLodRuntime.js'),
        import('../viewer/camera.js'),
        import('three'),
      ]);
    if (!current()) return;
    const { ctx } = await getViewerRuntimeWithUI(state, showMessage);
    if (!current()) return;
    // MOD compilation already converts millimetres to metres. The device has
    // no IFC anchor: only the source Z-up → viewer Y-up rotation is required.
    const anchor = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const overview = () => {
      scope.withSession(() => {
        fitCameraToScene(ctx, state.viewState, { force: true });
      });
    };
    if (
      !scope.withSession(() => {
        state.projectSourceToViewerMatrix = anchor;
        state.initialized = true;
        state.viewState.stationOverview = overview;
      })
    )
      return;
    let active = true;
    releasePresentation = scope.own(() => {
      active = false;
      if (state.projectSourceToViewerMatrix === anchor) state.projectSourceToViewerMatrix = null;
      if (state.viewState.stationOverview === overview) state.viewState.stationOverview = null;
    });
    let interactive = false,
      fitted = false;
    const rawPlacement = state.currentCbmTree?.transformMatrix;
    const placementWarning =
      rawPlacement && !isUsableAffineMatrix(rawPlacement.split(',').map(Number))
        ? '入口变换矩阵无效，按单位阵浏览；源矩阵保留，位置未经确认。'
        : '';
    const publishStatus = (text: string, detail?: string) => {
      if (!active) return;
      scope.withSession(() => {
        setDeviceStatus(
          placementWarning ? `${text} · 入口变换已回退` : text,
          placementWarning ? `${detail ?? ''} · ${placementWarning}` : detail,
        );
        const d = state.deviceLodRuntime?.diagnostics;
        if (Number(d?.shown) > 0 && !interactive) {
          interactive = true;
          perfMarkProductMoment(
            'firstUsableGeometryReady',
            { kind: state.currentProjectType },
            perf,
          );
          if (!state.selection.selectionRequest?.target && !state.viewState.viewerUserInteracted)
            fitCameraToScene(ctx, state.viewState, { force: true });
          if (state.modRootGroup) {
            void observeFirstGeometry(
              state,
              ctx,
              state.modRootGroup,
              session,
              () => {
                if (active && current()) hideLoading();
              },
              perf,
              'dev',
            ).catch((error) => {
              if (current()) logger.warn('[Geometry presentation]', error);
            });
          }
        }
        if (d?.baseRepresentationsSettled && !fitted) {
          fitted = true;
          if (!state.selection.selectionRequest?.target && !state.viewState.viewerUserInteracted)
            fitCameraToScene(ctx, state.viewState, { force: true });
          if (!interactive) {
            hideLoading();
            showMessage('设备模型没有可显示几何，请查看几何诊断。');
          }
        }
      });
    };
    await startDeviceLod(state, ctx, session, publishStatus);
  } catch (error) {
    releasePresentation?.();
    if (current()) throw error;
  }
}
