import {selectionPresentation} from './selectionPresentationPort.js';
import type {AppState, SelectionRequest} from '../app/state.js';
import type {CbmNode} from '../gim/types.js';
import type {ViewerContext} from '../viewer/viewerEngine.js';
import {setSelectionStatus} from './presentation/shell_statusBar.js';

export async function selectViewportDev(ctx: ViewerContext, state: AppState, rootOccurrence: string,
  instanceKey: string, request: SelectionRequest, showMessage: (text: string) => void,
  hint: import('../engineering/representations.js').DevRepresentationHint = {}): Promise<void> {
  const guard = state.selectionGuard(request);
  if (!guard.isCurrent()) return;
  request.origin = 'viewport';
  if (state.currentProjectType === 'substation' || state.engineering.snapshot) {
    const { selectEngineeringDevPick } = await import('./engineeringViewportSelection.js');
    if (!guard.isCurrent() || await selectEngineeringDevPick(state, rootOccurrence, hint, request)) return;
  }
  const candidates: {node: CbmNode; label: string}[] = [];
  const visit = (node: CbmNode, parents: string[]): void => {
    const trail = [...parents, node.name || node.path];
    if (node.path === rootOccurrence) candidates.push({node, label: trail.join(' / ')});
    node.children.forEach(child => visit(child, trail));
  };
  if (state.currentCbmTree) visit(state.currentCbmTree, []);
  if (candidates.length === 1) {
    const {handleNodeClick} = await import('./nodeInteractionService.js');
    if (guard.isCurrent()) await handleNodeClick(state, candidates[0].node, showMessage, request);
    return;
  }
  const {commitSelectionHighlight,highlightModGroups}=await import('../viewer/highlight.js');
  const highlightPicked = async (selected: SelectionRequest): Promise<void> => {
    const selectedGuard = state.selectionGuard(selected);
    await commitSelectionHighlight(ctx, state, selectedGuard, () => {
      const group = state.loadedXmlModGroups.get(instanceKey);
      if (group?.userData.rootOccurrence === rootOccurrence) highlightModGroups(state, [group]);
    });
  };
  await highlightPicked(request);
  if (!guard.isCurrent()) return;
  const message = candidates.length ? '请选择对应的模型节点；当前拾取设备与节点的自动关联尚未确认。' : '此设备没有对应的模型导航节点。';
  state.selectionMessage = message;
  setSelectionStatus(message);
  await selectionPresentation().chooseSources(message, candidates.map(candidate => ({label: candidate.label, choose: () => {
    if (!guard.isCurrent()) return;
    const selected = state.beginSelection({kind: 'cbm', key: candidate.node.path});
    state.selectionGeometry = {status: 'ambiguous', detail: '已显示您选择的节点属性；与当前拾取设备的自动关联尚未确认。'};
    void Promise.all([highlightPicked(selected), selectionPresentation().nodeInspector(state,selected).then(inspector=>inspector.show(candidate.node))]).catch(error => console.warn('[DEV source choice]', error));
  }})), guard.isCurrent);
}
