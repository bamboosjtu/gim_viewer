import type { GimRuntimeOpenContext } from './gimOpenCore.js';
import { hideLoading, showLoading } from './gimOpenCore.js';
import { findEquipmentEntry, prepareEquipmentFiles } from '../gim/equipmentModel.js';
import { buildCbmTree, buildCbmNodeIndex } from '../gim/cbmParser.js';
import {equipmentPresentationFor, type EquipmentPresentationPort} from './equipmentPresentationPort.js';
import { perfMarkProductMoment } from '../utils/perfTimings.js';
import { isUsableAffineMatrix } from '../gim/geometry/affineMatrix.js';
import {observeFirstGeometry} from './geometryPresentationService.js';

/** Standalone equipment uses the existing DEV browser/cache/selection owner.
 * It has no IFC coordinate barrier or station semantic-cache completion flag. */
export async function openEquipmentProject(
  context: GimRuntimeOpenContext,
  presentation: EquipmentPresentationPort = equipmentPresentationFor(context.state),
): Promise<void> {
  const { state, session, showMessage } = context;
  const scope = state.sessionScope(session), current = scope.isCurrent;
  if (!current()) return;
  const source = await context.getExtracted();
  if (source.status === 'cancelled') return;
  if (!current()) return;
  showLoading('正在解析设备模型...');
  const files = await prepareEquipmentFiles(source.files, current);
  if (!current()) return;
  const entry = await findEquipmentEntry(files);
  if (!current()) return;
  if (!entry) throw new Error('设备包缺少唯一、有效的 Device CBM 或 DEV 装配入口');
  const tree = await buildCbmTree(files, undefined, entry);
  if (!current()) return;
  if (!tree) throw new Error('无法构建设备模型层级');
  const { createNodeClickHandler } = await import('./substationPresentation.js');
  scope.withSession(() => {
    state.currentProjectType = 'equipment';
    state.currentFiles = files;
    state.substationEntryPaths = [...files.keys()];
    state.substationEntrySizes = new Map([...files].map(([path, file]) => [path, file.size]));
    state.currentCbmTree = tree;
    state.cbmNodeIndex = buildCbmNodeIndex(tree);
    (state.ifcLoading.pending = false);
    scope.own(presentation.navigation({name:context.projectName || tree.name,tree,
      onSelect:createNodeClickHandler(state,showMessage),signal:scope.signal}));
    perfMarkProductMoment('coreSemanticReady', { kind: 'equipment', cbmNodes: state.cbmNodeIndex.size });
    perfMarkProductMoment('navigationUiReady', { kind: 'equipment', scope: 'navigation-dom' });
  });
  if (current()) await startGeometryOnlyView(context,presentation);
}

/** Also used by valid project trees whose representation is entirely DEV. */
export async function startGeometryOnlyView(
  context: GimRuntimeOpenContext,
  presentation: EquipmentPresentationPort = equipmentPresentationFor(context.state),
): Promise<void> {
  const { state, session, showMessage } = context;
  const scope = state.sessionScope(session), current = scope.isCurrent;
  if (!current()) return;
  const [{ getViewerRuntimeWithUI }, { startDeviceLod }, { fitCameraToScene }, THREE] = await Promise.all([
    import('./viewerUIBinding.js'), import('./devLodRuntime.js'), import('../viewer/camera.js'), import('three'),
  ]);
  if (!current()) return;
  const { ctx } = await getViewerRuntimeWithUI(state, showMessage);
  if (!current()) return;
  // MOD compilation already converts millimetres to metres. The device has
  // no IFC anchor: only the source Z-up → viewer Y-up rotation is required.
  scope.withSession(() => {
    state.projectSourceToViewerMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    state.initialized = true;
    state.stationOverview = () => { scope.withSession(() => { fitCameraToScene(ctx, state.viewState, { force: true }); }); };
  });
  let interactive = false, fitted = false;
  const rawPlacement = state.currentCbmTree?.transformMatrix;
  const placementWarning = rawPlacement && !isUsableAffineMatrix(rawPlacement.split(',').map(Number))
    ? '入口变换矩阵无效，按单位阵浏览；源矩阵保留，位置未经确认。' : '';
  await startDeviceLod(state, ctx, session, (text, detail) => {
    scope.withSession(() => {
      presentation.deviceStatus(placementWarning ? `${text} · 入口变换已回退` : text,
        placementWarning ? `${detail ?? ''} · ${placementWarning}` : detail);
      const d = state.deviceLodRuntime?.diagnostics;
      if (Number(d?.shown) > 0 && !interactive) {
        interactive = true;
        perfMarkProductMoment('firstUsableGeometryReady', { kind: state.currentProjectType });
        if (!state.selection.selectionRequest?.target && !state.viewState.viewerUserInteracted) fitCameraToScene(ctx, state.viewState, {force: true});
        if (state.modRootGroup) {
          void observeFirstGeometry(state, ctx, state.modRootGroup, session, hideLoading).catch(error => {
            if (current()) console.warn('[Geometry presentation]', error);
          });
        }
      }
      if (d?.baseRepresentationsSettled && !fitted) {
        fitted = true;
        if (!state.selection.selectionRequest?.target && !state.viewState.viewerUserInteracted) fitCameraToScene(ctx, state.viewState, {force: true});
        if (!interactive) { hideLoading(); showMessage('设备模型没有可显示几何，请查看几何诊断。'); }
      }
    });
  });
}
