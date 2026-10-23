import type * as THREE from 'three';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from './viewerEngine.js';
import type { RegionalObject } from './ifcRegionalData.js';
import { addModHighlightGroup, enqueueHighlightCommit, HIGHLIGHT_STYLE } from './highlight.js';

const contains = (ids: Iterable<number> | undefined, id: number): boolean =>
  ids instanceof Set ? ids.has(id) : Array.isArray(ids) && ids.includes(id);

/** Bind a representation commit to the selection that owns its source identity.
 * No source queries, geometry work, scene scans or visibility rebuilds occur here.
 */
export async function syncIfcRepresentationHighlight(ctx: ViewerContext, state: AppState,
  runtimeId: string, modelId: string, object: RegionalObject, group: THREE.Group | undefined,
  localId: number | undefined, representationCurrent: () => boolean, prepareHighlight?: () => void): Promise<void> {
  const request = state.selectionRequest;
  if (!request || !state.isCurrentSelection(request) || !representationCurrent()) return;
  const target = request.target;
  const regional = target?.kind === 'ifc-object'
    && target.key === `ifc:${modelId.toLowerCase()}:object:${object.expressId}`;
  const far = localId !== undefined && (target?.kind === 'ifc-element' && target.key === `${runtimeId}:${localId}`
    || state.selectionHighlightRequestId === request.id && contains(state.highlightedItems?.[runtimeId],localId));
  if (!regional && !far) return;
  const selection = state.selectionGuard(request);
  const guard = {...selection, isCurrent: () => selection.isCurrent() && representationCurrent()};
  await enqueueHighlightCommit(state, guard, async () => {
    if (state.selectionHighlightRequestId !== request.id) return;
    if (group) {
      if (!state.highlightedModState?.groups.includes(group)) prepareHighlight?.();
      addModHighlightGroup(state, group); return;
    }
    if (localId === undefined || contains(state.highlightedItems?.[runtimeId],localId)) return;
    const items = {[runtimeId]: new Set([localId])};
    await ctx.fragments.highlight(HIGHLIGHT_STYLE, items);
    // An external apply already in progress must remain resettable by the next
    // queued selection even if its request was aborted while awaiting Fragments.
    if (selection.isSessionCurrent()) {
      state.highlightedItems = {...state.highlightedItems,
        [runtimeId]: [...new Set([...(state.highlightedItems?.[runtimeId] ?? []), localId])]};
    }
  });
}
