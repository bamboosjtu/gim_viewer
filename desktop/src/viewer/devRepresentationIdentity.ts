import type * as THREE from 'three';
import type { DevRepresentationHint } from '../engineering/representations.js';

/** Geometry provenance is carried by compiled MOD/STL groups, including GLB
 * extras. The placement wrapper alone never proves a nested part identity.
 */
export function devRepresentationHint(object: THREE.Object3D, placementRoot: THREE.Object3D): DevRepresentationHint {
  const result: DevRepresentationHint = {};
  for (let cursor: THREE.Object3D | null = object; cursor; cursor = cursor.parent) {
    if (result.assemblyPath === undefined && typeof cursor.userData.assemblyPath === 'string') result.assemblyPath = cursor.userData.assemblyPath;
    if (!result.devPath && (cursor !== placementRoot || result.assemblyPath !== undefined) && typeof cursor.userData.devPath === 'string') result.devPath = cursor.userData.devPath;
    if (cursor === placementRoot) break;
    if (result.assemblyPath !== undefined && result.devPath) break;
  }
  return result;
}
