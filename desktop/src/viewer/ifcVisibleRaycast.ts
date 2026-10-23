import type * as THREE from 'three';
import type { RaycastData, RaycastResult } from '@thatopen/fragments';
import type { ViewerContext } from './viewerEngine.js';

function visible(object: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) if (!current.visible) return false;
  return true;
}

/** FragmentsManager.raycast queries hidden model roots too. Pick only sources
 * visible when the click began and reject hidden items using the public API. */
export async function raycastVisibleIfc(ctx: ViewerContext, data: RaycastData): Promise<RaycastResult | null> {
  const models = [...ctx.fragments.list.values()].filter(model => visible(model.object));
  const hits = await Promise.allSettled(models.map(async model => {
    const hit = await model.raycast(data);
    if (!hit || !visible(model.object)) return null;
    if ((await model.getVisible([hit.localId]))[0]) return visible(model.object) ? hit : null;
    // Some versions return an invisible nearest item. Keep a visible item
    // behind it selectable without querying hidden sources or private tiles.
    const candidates = await model.raycastAll(data) ?? [];
    const ids = [...new Set(candidates.map(candidate => candidate.localId))];
    const values = await model.getVisible(ids), allowed = new Set(ids.filter((_, i) => values[i]));
    if (!visible(model.object)) return null;
    return candidates.filter(candidate => allowed.has(candidate.localId))
      .sort((a,b) => (a.rayDistance ?? a.distance) - (b.rayDistance ?? b.distance))[0] ?? null;
  }));
  const results: RaycastResult[] = [];
  for (const result of hits) {
    if (result.status === 'rejected') console.warn('[IFC selection]', result.reason);
    else if (result.value) results.push(result.value);
  }
  return results.sort((a,b) => (a.rayDistance ?? a.distance) - (b.rayDistance ?? b.distance))[0] ?? null;
}
