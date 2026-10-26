import type * as THREE from 'three';

interface DevPickIdentity {
  rootOccurrence: string;
  instanceKey: string;
}
export type PickableDevRoot = (DevPickIdentity | { entry: DevPickIdentity }) & {
  group?: THREE.Group;
  /** Bounds of the displayed representation, refreshed on LOD/anchor changes. */
  pickBounds?: THREE.Box3;
};

export interface DevViewportPick {
  rootOccurrence: string;
  instanceKey: string;
  distance: number;
}

/** Raycast ordinary DEV placement groups when the instancing pilot is off.
 * Hiding a source layer or using "only selected" must also remove it from
 * picking: a hidden model must never intercept the click that belongs to a
 * visible DEV object. */
export function pickVisibleDevRoot(
  ray: THREE.Raycaster,
  rows: Iterable<PickableDevRoot>,
): DevViewportPick | null {
  let nearest: DevViewportPick | null = null;
  const hits: THREE.Intersection[] = [];
  let identity: DevPickIdentity;
  const visit = (object: THREE.Object3D): void => {
    if (!object.visible) return;
    if ((object as THREE.Mesh).isMesh && ray.layers.test(object.layers)) {
      hits.length = 0;
      object.raycast(ray, hits);
      for (const hit of hits) if (!nearest || hit.distance < nearest.distance) {
        nearest = { rootOccurrence: identity.rootOccurrence, instanceKey: identity.instanceKey, distance: hit.distance };
      }
    }
    for (const child of object.children) visit(child);
  };
  for (const row of rows) {
    const group = row.group;
    identity = 'entry' in row ? row.entry : row;
    if (!group || !identity.rootOccurrence || !identity.instanceKey) continue;
    let visible = true;
    for (let node: THREE.Object3D | null = group; node; node = node.parent) {
      if (!node.visible) { visible = false; break; }
    }
    if (!visible) continue;
    // Unknown bounds remain eligible; no per-click geometry traversal to build them.
    if (row.pickBounds && !ray.ray.intersectsBox(row.pickBounds)) continue;
    visit(group);
  }
  return nearest;
}
