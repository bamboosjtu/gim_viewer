import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { selectionPresentation } from './selectionPresentationPort.js';
import { projectPresentation } from './projectPresentationPort.js';
import { perfMark } from '../utils/perfTimings.js';
import {
  isSubstationSourceMaterializing,
  substationSourcePreparationMessage,
} from './projectSourcePreparation.js';
import type { CbmNode } from '../gim/types.js';
import type { AppState, SelectionRequest } from '../app/state.js';
import { collectIfcRefs } from '../gim/cbmParser.js';
import { resolveIfcModelId } from '../gim/modelIdentity.js';
import { describeNodeSelectionGeometry, loadModStlForNode } from './nodeGeometrySelection.js';
import { getIfcBufferForEntry } from './ifcGeometrySource.js';
import { selectionMessage } from './nodeSelectionFeedback.js';
import { syncSelectionNavigation } from './selectionNavigation.js';

/** Clear selection effects without creating a viewer just for an empty object. */
export async function clearSelectionHighlight(
  state: AppState,
  request: SelectionRequest,
  showMessage: (text: string) => void,
): Promise<void> {
  if (!state.selection.isCurrentSelection(request)) return;
  if (
    !state.initialized &&
    !state.selection.highlightedItems &&
    !state.selection.highlightedModState
  )
    return;
  const { getViewerRuntimeWithUI } = await import('./viewerUIBinding.js');
  const { ctx } = await getViewerRuntimeWithUI(state, showMessage);
  const { commitSelectionHighlight } = await import('../viewer/highlight.js');
  await commitSelectionHighlight(ctx, state, state.selection.selectionGuard(request));
}

export async function handleNodeClick(
  state: AppState,
  node: CbmNode,
  showMessage: (text: string) => void,
  request: SelectionRequest = state.selection.beginSelection({ kind: 'cbm', key: node.path }),
): Promise<void> {
  const session = request.session;
  const isSessionCurrent = () => state.isCurrentSession(session);
  const isSelected = () => state.selection.isCurrentSelection(request);
  if (!isSessionCurrent()) return;
  const message = selectionMessage(state, request);
  const inspector = await selectionPresentation().nodeInspector(state, request);
  if (!isSessionCurrent()) return;
  if (isSelected()) {
    state.selection.selectionGeometry = describeNodeSelectionGeometry(state, node);
  }
  const basic = inspector.show(node);
  // Resource loading and property reads are concurrent. Only the short visual
  // reset/apply commit waits behind an already-started external operation.
  const cleared = clearSelectionHighlight(state, request, message);
  await syncSelectionNavigation(state, request);
  if (isSubstationSourceMaterializing(state)) {
    await Promise.all([basic, cleared]);
    if (isSelected()) {
      message(substationSourcePreparationMessage(state));
      perfMark('cold selected device geometry pending', {
        path: node.path,
        devPath: node.devPath,
        reason: 'source-materializing',
      });
    }
    return;
  }

  const refs = collectIfcRefs(node, state.currentIfcEntries);
  const ifcModelId = node.ifcFile
    ? resolveIfcModelId(node.ifcFile, state.currentIfcEntries)
    : state.deviceToIfcFile.get(node.path.split('/').pop() || '');
  try {
    if (refs.size === 0 && node.devPath) {
      await loadModStlForNode(state, node, session, request);
      await basic;
      if (isSelected()) await inspector.show(node);
      return;
    }
    const modelsToLoad = new Set([...refs.keys()].filter((id) => !state.ifc.loadedModels.has(id)));
    if (ifcModelId && !state.ifc.loadedModels.has(ifcModelId)) modelsToLoad.add(ifcModelId);
    if (modelsToLoad.size === 0 && refs.size === 0) {
      if (isSelected()) {
        state.selection.selectionGeometry = describeNodeSelectionGeometry(state, node, true);
        message(state.selection.selectionGeometry.detail);
      }
      return;
    }
    const { getViewerRuntimeWithUI } = await import('./viewerUIBinding.js');
    const { ctx, modelCallbacks } = await getViewerRuntimeWithUI(state, message);
    if (!isSessionCurrent()) return;
    let ifcFailure: string | undefined;
    if (modelsToLoad.size > 0) {
      const { ensureEngineReady } = await import('../viewer/ifcLoader.js');
      const { loadIfcEntry } = await import('../viewer/ifcEntryLoader.js');
      await ensureEngineReady(ctx, state, modelCallbacks);
      if (!isSessionCurrent()) return;
      for (const id of modelsToLoad) {
        if (!isSessionCurrent()) return;
        const entry = state.currentIfcEntries.find((e) => e.modelId === id);
        if (!entry) {
          ifcFailure = `IFC 来源引用未找到：${id}`;
          continue;
        }
        message(`正在加载 ${entry.name}…`);
        try {
          await loadIfcEntry(
            ctx,
            state,
            entry,
            () => getIfcBufferForEntry(entry, state, session),
            (p) => message(`${entry.name}: ${Math.round(p * 100)}%`),
            { session },
          );
        } catch {
          ifcFailure = `IFC 加载失败：${entry.name}`;
          if (isSessionCurrent()) message(ifcFailure);
        }
      }
      if (!isSessionCurrent()) return;
      const { buildIfcNameIndex } = await import('./ifcNameIndex.js');
      await buildIfcNameIndex(ctx, state, { session });
      if (!isSessionCurrent()) return;

      // This callback handles future user clicks; it is scoped to the project,
      // not to the old selection which happened to refresh the names.
      const click = (n: CbmNode) => {
        if (isSessionCurrent())
          void Promise.resolve(handleNodeClick(state, n, showMessage)).catch(reportBackgroundError);
      };
      await projectPresentation().renderNavigation(state, click, isSessionCurrent);
    }
    if (!isSelected()) return;
    const { highlightIfcItems } = await import('../viewer/highlight.js');

    const { projectNodeIfcSelection } = await import('./ifcSelectionProjection.js');
    const projected = await projectNodeIfcSelection(ctx, state, node, request);
    if (!isSelected()) return;
    await highlightIfcItems(ctx, state, projected.items, request);
    if (isSelected() && !Object.keys(projected.items).length) message(projected.emptyMessage);
    if (!isSelected()) return;
    state.selection.selectionGeometry =
      refs.size > 0 && state.selection.highlightedItems
        ? ifcFailure
          ? { status: 'partial', detail: `已定位当前可用的直接 GUID 构件；${ifcFailure}` }
          : { status: 'available', detail: '已定位直接 GUID 关联的 IFC 构件。' }
        : ifcFailure
          ? { status: 'failed', detail: ifcFailure }
          : describeNodeSelectionGeometry(state, node, true);
    await basic;
    await inspector.show(node, ctx);
  } finally {
    await Promise.all([basic, cleared]);
  }
}
