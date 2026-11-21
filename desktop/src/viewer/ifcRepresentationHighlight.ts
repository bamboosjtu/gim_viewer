import type * as THREE from 'three';
import type { ViewerState as AppState } from '../shared/viewerState.js';
import type { ViewerContext } from './viewerEngine.js';
import type { RegionalObject } from './ifcRegionalData.js';
import { addModHighlightGroup, enqueueHighlightCommit } from './highlight.js';
import { outlineFragmentItems } from './selectionOutline.js';

const contains = (ids: Iterable<number> | undefined, id: number): boolean =>
  ids instanceof Set ? ids.has(id) : Array.isArray(ids) && ids.includes(id);

/** Bind a representation commit to the selection that owns its source identity.
 * No source queries, geometry work, scene scans or visibility rebuilds occur here.
 */
export async function syncIfcRepresentationHighlight(
  ctx: ViewerContext,
  state: AppState,
  runtimeId: string,
  modelId: string,
  object: RegionalObject,
  group: THREE.Group | undefined,
  localId: number | undefined,
  representationCurrent: () => boolean,
  prepareHighlight?: () => void,
): Promise<void> {
  const request = state.selection.selectionRequest;
  if (!request || !state.selection.isCurrentSelection(request) || !representationCurrent()) return;
  const target = request.target;
  const regional =
    target?.kind === 'ifc-object' &&
    target.key === `ifc:${modelId.toLowerCase()}:object:${object.expressId}`;
  const scope = state.selection.representationSelection;
  if (scope?.requestId === request.id && !scope.isCurrent()) return;
  const selected =
    scope?.requestId === request.id &&
    scope.isCurrent() &&
    scope.ifc.some((ref) => ref.modelId === modelId && ref.expressId === object.expressId);
  const far =
    localId !== undefined &&
    ((target?.kind === 'ifc-element' && target.key === `${runtimeId}:${localId}`) ||
      (state.selection.selectionHighlightRequestId === request.id &&
        contains(state.selection.highlightedItems?.[runtimeId], localId)));
  if (!regional && !far && !selected) return;
  const selection = state.selection.selectionGuard(request);
  const guard = {
    ...selection,
    isCurrent: () =>
      selection.isCurrent() &&
      representationCurrent() &&
      (!selected || (state.selection.representationSelection === scope && scope.isCurrent())),
  };
  await enqueueHighlightCommit(state, guard, async () => {
    if (state.selection.selectionHighlightRequestId !== request.id) return;
    if (group) {
      if (!state.selection.highlightedModState?.groups.includes(group)) prepareHighlight?.();
      addModHighlightGroup(state, group);
      return;
    }
    if (localId === undefined || contains(state.selection.highlightedItems?.[runtimeId], localId))
      return;
    const items = { [runtimeId]: new Set([localId]) };
    await outlineFragmentItems(ctx, state, items, guard);
    // An external apply already in progress must remain resettable by the next
    // queued selection even if its request was aborted while awaiting Fragments.
    if (selection.isSessionCurrent()) {
      state.selection.highlightedItems = {
        ...state.selection.highlightedItems,
        [runtimeId]: [
          ...new Set([...(state.selection.highlightedItems?.[runtimeId] ?? []), localId]),
        ],
      };
    }
  });
}
