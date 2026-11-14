import type { GimRuntimeOpenContext } from './gimOpenCore.js';
import { hideLoading, showLoading } from './gimOpenCore.js';
import { findEquipmentEntry, prepareEquipmentFiles } from '../gim/equipmentModel.js';
import { buildCbmTree, buildCbmNodeIndex } from '../gim/cbmParser.js';
import { setProjectIdentity, refreshNavigatorTitle } from './presentation/shell_projectBar.js';
import { setDeviceStatus, setIfcStatus } from './presentation/shell_statusBar.js';
import { emptyTipEl } from './presentation/dom.js';
import { buildAndRenderCbmTree } from './presentation/cbmTreeView.js';
import { perfMarkProductMoment } from '../utils/perfTimings.js';
import { isUsableAffineMatrix } from '../gim/geometry/affineMatrix.js';
import {observeFirstGeometry} from './geometryPresentationService.js';

/** Standalone equipment uses the existing DEV browser/cache/selection owner.
 * It has no IFC coordinate barrier or station semantic-cache completion flag. */
export async function openEquipmentProject(context: GimRuntimeOpenContext): Promise<void> {
  const { state, session, showMessage } = context;
  const current = () => state.isCurrentSession(session);
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
  state.currentProjectType = 'equipment';
  state.currentFiles = files;
  state.substationEntryPaths = [...files.keys()];
  state.substationEntrySizes = new Map([...files].map(([path, file]) => [path, file.size]));
  state.currentCbmTree = tree;
  state.cbmNodeIndex = buildCbmNodeIndex(tree);
  state.endIfcBackgroundLoading();
  setProjectIdentity(context.projectName || tree.name, 'equipment');
  refreshNavigatorTitle();
  setIfcStatus('');
  const { createNodeClickHandler } = await import('./substationRuntime.js');
  if (!current()) return;
  buildAndRenderCbmTree(state, createNodeClickHandler(state, showMessage));
  if (emptyTipEl) emptyTipEl.style.display = 'none';
  perfMarkProductMoment('coreSemanticReady', { kind: 'equipment', cbmNodes: state.cbmNodeIndex.size });
  perfMarkProductMoment('navigationUiReady', { kind: 'equipment', scope: 'navigation-dom' });
  await startGeometryOnlyView(context);
}

/** Also used by valid project trees whose representation is entirely DEV. */
export async function startGeometryOnlyView(context: GimRuntimeOpenContext): Promise<void> {
  const { state, session, showMessage } = context;
  const current = () => state.isCurrentSession(session);
  const [{ getViewerRuntimeWithUI }, { startDeviceLod }, { fitCameraToScene }, THREE] = await Promise.all([
    import('./viewerUIBinding.js'), import('./devLodRuntime.js'), import('../viewer/camera.js'), import('three'),
  ]);
  if (!current()) return;
  const { ctx } = await getViewerRuntimeWithUI(state, showMessage);
  if (!current()) return;
  // MOD compilation already converts millimetres to metres. The device has
  // no IFC anchor: only the source Z-up → viewer Y-up rotation is required.
  state.projectSourceToViewerMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  state.initialized = true;
  state.stationOverview = () => { if (current()) fitCameraToScene(ctx, state, { force: true }); };
  let interactive = false, fitted = false;
  const rawPlacement = state.currentCbmTree?.transformMatrix;
  const placementWarning = rawPlacement && !isUsableAffineMatrix(rawPlacement.split(',').map(Number))
    ? '入口变换矩阵无效，按单位阵浏览；源矩阵保留，位置未经确认。' : '';
  await startDeviceLod(state, ctx, session, (text, detail) => {
    if (!current()) return;
    setDeviceStatus(placementWarning ? `${text} · 入口变换已回退` : text,
      placementWarning ? `${detail ?? ''} · ${placementWarning}` : detail);
    const d = state.deviceLodRuntime?.diagnostics;
    if (Number(d?.shown) > 0 && !interactive) {
      interactive = true;
      perfMarkProductMoment('firstUsableGeometryReady', { kind: state.currentProjectType });
      if(!state.selectionRequest?.target&&!state.viewerUserInteracted)fitCameraToScene(ctx,state,{force:true});
      if(state.modRootGroup)void observeFirstGeometry(state,ctx,state.modRootGroup,session,hideLoading).catch(error=>{if(current())console.warn('[Geometry presentation]',error);});
    }
    if (d?.baseRepresentationsSettled && !fitted) {
      fitted = true;
      if (!state.selectionRequest?.target && !state.viewerUserInteracted) fitCameraToScene(ctx, state, { force: true });
      if (!interactive) {hideLoading();showMessage('设备模型没有可显示几何，请查看几何诊断。');}
    }
  });
}
