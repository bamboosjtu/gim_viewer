import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { loadPresentation } from './presentationPort.js';
import type { AppState, SelectionRequest } from '../app/state.js';
import type { DevRepresentationHint, RepresentationResolution } from '../engineering/representations.js';
import { getEngineeringRepresentations } from './engineeringRepresentationService.js';
import { selectEngineeringTarget, clearEngineeringHighlight } from './engineeringSelection.js';

async function showUnboundSource(state: AppState, request: SelectionRequest): Promise<boolean> {
  const guard = state.selectionGuard(request);
  await clearEngineeringHighlight(state, request); if (!guard.isCurrent()) return true;
  const { showSelectionSources } = await loadPresentation('selectionSources');
  if (!guard.isCurrent()) return true;
  state.selectionMessage = state.engineeringSnapshot ? '当前表示的来源尚未可靠关联，请在来源视图查看。' : '工程来源正在解析，暂不能确认此表示对应的整体。';
  state.selectionGeometry = { status: 'unassociated', detail: state.selectionMessage };
  showSelectionSources(state.selectionMessage, [], guard.isCurrent);
  return true;
}

async function selectResolution(state: AppState, resolved: RepresentationResolution, request: SelectionRequest): Promise<boolean> {
  const guard = state.selectionGuard(request);
  if (!guard.isCurrent()) return true;
  if (resolved.ownerIds.length === 1) return selectEngineeringTarget(state, { kind: 'engineering', key: resolved.ownerIds[0] }, request, { fit: false, load: false });
  if (resolved.ownerIds.length > 1) {
    await clearEngineeringHighlight(state, request); if (!guard.isCurrent()) return true;
    const { showSelectionSources } = await loadPresentation('selectionSources');
    if (!guard.isCurrent()) return true;
    state.selectionGeometry = { status: 'ambiguous', detail: '当前粗表示包含多个工程整体，范围尚未分离。' };
    state.selectionMessage = state.selectionGeometry.detail;
    const snapshot = state.engineeringSnapshot;
    showSelectionSources(state.selectionMessage, resolved.ownerIds.map(key => ({
      label: snapshot?.entities.find(e => e.id === key)?.name ?? '待归整体集合',
      choose: () => { if (guard.isCurrent()) void Promise.resolve(selectEngineeringTarget(state, { kind: 'engineering', key }, undefined, { fit: false, load: false })).catch(reportBackgroundError); },
    })), guard.isCurrent);
    return true;
  }
  if (resolved.sourceIds.length === 1) return selectEngineeringTarget(state, { kind: 'engineering-source', key: resolved.sourceIds[0] }, request, { fit: false, load: false });
  return showUnboundSource(state, request);
}

export async function selectEngineeringDevPick(state: AppState, rootOccurrence: string, hint: DevRepresentationHint, request: SelectionRequest): Promise<boolean> {
  const representation = getEngineeringRepresentations(state);
  if (!representation) return showUnboundSource(state, request);
  return selectResolution(state, representation.index.resolveDev(rootOccurrence, hint), request);
}

export async function selectEngineeringIfcPick(state: AppState, modelId: string, expressId: number, request: SelectionRequest): Promise<boolean> {
  const representation = getEngineeringRepresentations(state);
  if (!representation) return showUnboundSource(state, request);
  return selectResolution(state, representation.index.resolveIfc(modelId, expressId), request);
}

export async function selectEngineeringFragmentPick(state: AppState, runtimeId: string, localId: number, request: SelectionRequest,
  model: { getGuidsByLocalIds(ids: number[]): Promise<Array<string | null>> }): Promise<boolean> {
  if (!state.engineeringSources) return showUnboundSource(state, request);
  const modelId = state.resolveLogicalModelId(runtimeId) ?? runtimeId;
  const [guid] = await model.getGuidsByLocalIds([localId]);
  if (!state.isCurrentSelection(request)) return true;
  if (!guid) return showUnboundSource(state, request);
  const rows = state.engineeringSources.ifcRecords.filter(row => row.ifcOccurrence?.modelId === modelId && row.ifcOccurrence.globalId === guid);
  const representation = getEngineeringRepresentations(state);
  return representation ? selectResolution(state, representation.index.resolveSources(rows.map(row => row.id)), request) : showUnboundSource(state, request);
}
