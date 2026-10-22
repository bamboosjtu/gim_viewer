import * as THREE from 'three';
export type DeviceLod = 0 | 1 | 2;
/** Automatic browsing policy is intentionally capped at L1.  L2 is entered
 * only through an explicit refine request owned by the selection inspector. */
export function chooseDeviceLod(previous: DeviceLod, visible: boolean, pixels: number): 0 | 1 {
  if (!visible) return 0; // Every physical occurrence has an automatic base representation.
  return pixels >= (previous > 0 ? 30 : 40) ? 1 : 0;
}
export function createDeviceViewContext(camera: THREE.Camera, width: number, height: number) {
  camera.updateMatrixWorld(true);
  const clip = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { clip, frustum: new THREE.Frustum().setFromProjectionMatrix(clip), eye: camera.getWorldPosition(new THREE.Vector3()),
    width, height, point: new THREE.Vector3(), projected: new THREE.Box2(), corner: new THREE.Vector2(), size: new THREE.Vector2() };
}
/** Uses box distance and projected corners, including long objects crossing the frustum. */
export function deviceViewMetrics(box: THREE.Box3, camera: THREE.Camera, width: number, height: number,
  view = createDeviceViewContext(camera, width, height)) {
  const { clip, eye, projected } = view;
  const visible = view.frustum.intersectsBox(box), distance = box.distanceToPoint(eye);
  projected.makeEmpty();
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const point = view.point.set(x, y, z).applyMatrix4(clip);
    projected.expandByPoint(view.corner.set(point.x * width / 2, point.y * height / 2));
  }
  const size = projected.getSize(view.size);
  // A box containing the eye or intersecting the near plane must not become a tiny candidate.
  const pixels = distance === 0 ? Math.max(width, height) : Math.min(Math.max(width, height) * 2, Math.max(size.x, size.y));
  return { visible, distance, pixels };
}
