import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import type { SelectionCommitGuard } from '../app/state.js';

/** 将相机定位到场景包围盒 */
export function fitCameraToScene(
  ctx: ViewerContext,
  state: { hasFittedCamera: boolean },
  options?: { force?: boolean },
): boolean {
  if (state.hasFittedCamera && !options?.force) {
    debugLog(DEBUG_IFC_LOAD, '[Camera] fitCameraToScene skipped: hasFittedCamera=true');
    return false;
  }
  const box = new THREE.Box3().setFromObject((ctx.world.scene as any).three);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  debugLog(DEBUG_IFC_LOAD, '[Camera] fitCameraToScene', {
    hasFittedCamera: state.hasFittedCamera,
    force: options?.force ?? false,
    maxDim,
    center: center.toArray(),
    size: size.toArray(),
    boxEmpty: box.isEmpty(),
  });
  if (maxDim === 0 || !Number.isFinite(maxDim)) {
    console.warn('[Camera] fitCameraToScene: scene bbox is empty or invalid, skip fit');
    return false;
  }
  const distance = maxDim * 1.2;
  void ctx.world.camera.controls?.setLookAt(center.x + distance, center.y + distance * 0.8, center.z + distance, center.x, center.y, center.z);
  state.hasFittedCamera = true;
  debugLog(DEBUG_IFC_LOAD, '[Camera] fitCameraToScene done: camera set to', { center, distance });
  return true;
}

/** 将相机定位到指定包围盒 */
export async function frameBox(ctx: ViewerContext, box: THREE.Box3, guard?: SelectionCommitGuard): Promise<void> {
  if (box.isEmpty() || ![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite) || (guard && !guard.isCurrent())) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDim * 2.5;
  const controls = ctx.world.camera.controls;
  if (!controls) return;
  let abort!: () => void;
  const interrupted = new Promise<void>((resolve) => { abort=resolve; });
  const cancel = (): void => {
    // CameraControls.stop() snaps to its old end target. Freeze the current
    // position/target first, so a subsequent empty selection retains the view.
    if (controls.getPosition && controls.getTarget) {
      const position=controls.getPosition(new THREE.Vector3(),false);
      const target=controls.getTarget(new THREE.Vector3(),false);
      void controls.setLookAt(position.x,position.y,position.z,target.x,target.y,target.z,false);
    }
    controls.stop?.();
    abort();
  };
  guard?.signal?.addEventListener('abort',cancel,{once:true});
  try {
    if (guard && !guard.isCurrent()) return;
    const movement=controls.setLookAt(center.x+distance,center.y+distance*0.8,center.z+distance,center.x,center.y,center.z,false);
    await (guard?.signal ? Promise.race([movement,interrupted]) : movement);
  } finally { guard?.signal?.removeEventListener('abort',cancel); }
}
