import * as THREE from 'three';

/** Above this extent, check representable coordinate precision instead of
 * treating a large but valid site model as invalid merely because of its size. */
export const GEOMETRY_MAX_EXTENT_M=500;

export function invalidGeometryBounds(box:THREE.Box3):string|null {
  if(box.isEmpty())return 'empty-bounds';
  const values=[...box.min.toArray(),...box.max.toArray()];
  if(!values.every(Number.isFinite))return 'non-finite-bounds';
  const size=box.getSize(new THREE.Vector3());
  if(Math.max(size.x,size.y,size.z)<=GEOMETRY_MAX_EXTENT_M)return null;
  const magnitude=Math.max(...values.map(Math.abs));
  if(magnitude===0||2**(Math.floor(Math.log2(magnitude))-23)<=0.001)return null;
  return `insufficient-float32-coordinate-precision: ${size.toArray().join(',')}`;
}
export function invalidGeometryExtent(object:THREE.Object3D):string|null {
  return invalidGeometryBounds(new THREE.Box3().setFromObject(object));
}
