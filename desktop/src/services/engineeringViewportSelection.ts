import { reportBackgroundError } from '../utils/backgroundErrors.js';
import {selectionPresentation} from './selectionPresentationPort.js';
import type { AppState, SelectionRequest } from '../app/state.js';
import type { DevRepresentationHint, RepresentationResolution } from '../engineering/representations.js';
import { getEngineeringRepresentations } from './engineeringRepresentationService.js';
import { selectEngineeringTarget, clearEngineeringHighlight } from './engineeringSelection.js';

async function showUnboundSource(state: AppState, request: SelectionRequest, detail?: string): Promise<boolean> {
  const guard = state.selection.selectionGuard(request);
  await clearEngineeringHighlight(state, request); if (!guard.isCurrent()) return true;
  if (!guard.isCurrent()) return true;
  state.selection.selectionMessage = detail ?? (state.engineering.snapshot ? '当前表示的来源尚未可靠关联，请在来源视图查看。' : '工程来源正在解析，暂不能确认此表示对应的整体。');
  state.selection.selectionGeometry = { status: 'unassociated', detail: state.selection.selectionMessage };
  await selectionPresentation().chooseSources(state.selection.selectionMessage, [], guard.isCurrent);
  return true;
}

async function selectResolution(state: AppState, resolved: RepresentationResolution, request: SelectionRequest): Promise<boolean> {
  const guard = state.selection.selectionGuard(request);
  if (!guard.isCurrent()) return true;
  if (resolved.status === 'bound') return selectEngineeringTarget(state, { kind: 'engineering', key: resolved.ownerIds[0] }, request, { fit: false, load: false });
  if (resolved.status === 'ambiguous') {
    await clearEngineeringHighlight(state, request); if (!guard.isCurrent()) return true;
    if (!guard.isCurrent()) return true;
    state.selection.selectionGeometry = { status: 'ambiguous', detail: resolved.ownerIds.length > 1 ? '当前粗表示包含多个工程整体，范围尚未分离。' : '当前表示包含归属待确认的构件，请先选择要查看的整体。' };
    state.selection.selectionMessage = state.selection.selectionGeometry.detail;
    const snapshot = state.engineering.snapshot;
    await selectionPresentation().chooseSources(state.selection.selectionMessage, resolved.ownerIds.map(key => ({
      label: snapshot?.entities.find(e => e.id === key)?.name ?? '待归整体集合',
      choose: () => { if (guard.isCurrent()) void Promise.resolve(selectEngineeringTarget(state, { kind: 'engineering', key }, undefined, { fit: false, load: false })).catch(reportBackgroundError); },
    })), guard.isCurrent);
    return true;
  }
  if (resolved.pendingIds?.length === 1) {
    const members = getEngineeringRepresentations(state)?.index.sourcesForOwners(new Set(resolved.pendingIds));
    if (members && resolved.sourceIds.every(id => members.has(id))) {
      return selectEngineeringTarget(state, {kind:'engineering', key:resolved.pendingIds[0]}, request, {fit:false, load:false});
    }
  }
  if (resolved.sourceIds.length === 1 && !resolved.unknownSourceIds?.length) return selectEngineeringTarget(state, { kind: 'engineering-source', key: resolved.sourceIds[0] }, request, { fit: false, load: false });
  return showUnboundSource(state, request,resolved.pendingIds?.length?'当前表示含待归构件，尚无唯一工程整体。':undefined);
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
  if (!state.engineering.sources) return showUnboundSource(state, request);
  const modelId = state.ifc.resolveLogicalModelId(runtimeId) ?? runtimeId;
  const [guid] = await model.getGuidsByLocalIds([localId]);
  if (!state.selection.isCurrentSelection(request)) return true;
  if (!guid) return showUnboundSource(state, request);
  const representation = getEngineeringRepresentations(state);
  return representation ? selectResolution(state, representation.index.resolveSources(representation.index.sourcesForIfcGuid(modelId,guid)), request) : showUnboundSource(state, request);
}
