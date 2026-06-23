import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';

/** 将相机定位到场景包围盒 */
export function fitCameraToScene(ctx: ViewerContext, state: { hasFittedCamera: boolean }): boolean {
  if (state.hasFittedCamera) return false;
  const box = new THREE.Box3().setFromObject((ctx.world.scene as any).three);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim === 0 || !Number.isFinite(maxDim)) return false;
  const distance = maxDim * 1.2;
  void ctx.world.camera.controls?.setLookAt(center.x + distance, center.y + distance * 0.8, center.z + distance, center.x, center.y, center.z);
  state.hasFittedCamera = true;
  return true;
}

/** 将相机定位到指定包围盒 */
export async function frameBox(ctx: ViewerContext, box: THREE.Box3): Promise<void> {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDim * 2.5;
  await ctx.world.camera.controls?.setLookAt(
    center.x + distance, center.y + distance * 0.8, center.z + distance,
    center.x, center.y, center.z,
  );
}
