import * as THREE from 'three';

// Same station-scale extent limit used by the scene admission guard. A
// template's extent is independent of the IFC/project translation anchor.
export const GEOMETRY_MAX_EXTENT_M = 500;

export function invalidGeometryExtent(object: THREE.Object3D): string | null {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return 'empty-bounds';
  const size = box.getSize(new THREE.Vector3()).toArray();
  if (size.some(value => !Number.isFinite(value))) return 'non-finite-bounds';
  if (Math.max(...size) > GEOMETRY_MAX_EXTENT_M) {
    return `extent-exceeds-${GEOMETRY_MAX_EXTENT_M}m: ${size.join(',')}`;
  }
  return null;
}
