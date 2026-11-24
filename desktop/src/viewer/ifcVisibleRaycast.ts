import { logger } from '../utils/logger.js';
import type * as THREE from 'three';
import { SnappingClass } from '@thatopen/fragments';
import type { RaycastData, RaycastResult } from '@thatopen/fragments';
import type { ViewerContext } from './viewerEngine.js';

function visible(object: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent)
    if (!current.visible) return false;
  return true;
}

const distance = (hit: RaycastResult) => hit.rayDistance ?? hit.distance;

/** FragmentsManager.raycast queries hidden model roots too. Pick only sources
 * visible when the click began and reject hidden items using the public API. */
export async function raycastVisibleIfc(
  ctx: ViewerContext,
  data: RaycastData,
  accepts?: (point: THREE.Vector3) => boolean,
  surfaceOnly = false,
): Promise<RaycastResult | null> {
  const permitted = (hit: RaycastResult) =>
    (!surfaceOnly ||
      (hit.snappingClass !== SnappingClass.LINE &&
        hit.snappingClass !== SnappingClass.POINT &&
        !!hit.point)) &&
    (!accepts || accepts(hit.point));
  const models = [...ctx.fragments.list.values()].filter((model) => visible(model.object));
  const hits = await Promise.allSettled(
    models.map(async (model) => {
      const hit = await model.raycast(data);
      if (!hit || !visible(model.object)) return null;
      const firstPermitted = permitted(hit);
      if (firstPermitted && (await model.getVisible([hit.localId]))[0])
        return visible(model.object) ? hit : null;
      if (!visible(model.object)) return null;
      // Some versions return an invisible nearest item. Keep a visible item
      // behind it selectable without querying hidden sources or private tiles.
      const closestByItem = new Map<number, RaycastResult>();
      for (const candidate of (await model.raycastAll(data)) ?? []) {
        if ((firstPermitted && candidate.localId === hit.localId) || !permitted(candidate))
          continue;
        const previous = closestByItem.get(candidate.localId);
        if (!previous || distance(candidate) < distance(previous))
          closestByItem.set(candidate.localId, candidate);
      }
      if (!visible(model.object)) return null;
      let best: RaycastResult | null = null;
      const candidates = [...closestByItem.values()];
      for (let i = 0; i < candidates.length && visible(model.object); i += 2048) {
        const batch = candidates.slice(i, i + 2048);
        const values = await model.getVisible(batch.map((candidate) => candidate.localId));
        for (const [index, candidate] of batch.entries())
          if (values[index] && (!best || distance(candidate) < distance(best))) best = candidate;
      }
      return visible(model.object) ? best : null;
    }),
  );
  let best: RaycastResult | null = null;
  for (const result of hits) {
    if (result.status === 'rejected') logger.warn('[IFC selection]', result.reason);
    else if (result.value && (!best || distance(result.value) < distance(best)))
      best = result.value;
  }
  return best;
}
