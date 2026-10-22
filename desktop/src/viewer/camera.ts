import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import type { SelectionCommitGuard } from '../app/state.js';
import {isDevRenderBatch} from './devInstanceBatches.js';

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

/**
 * 只统计可渲染网格的场景包围盒，并剔除“地形/场地大平面”这类离群网格。
 *
 * IFC 里常带一块覆盖整个站址的场地平面；直接并入包围盒会把相机推到
 * 数百米外，整站变成一个小点。这里用各网格最大边长的中位数过滤掉
 * 尺度超过中位数 6 倍的网格。
 */
function sceneMeshBounds(ctx: ViewerContext): THREE.Box3 {
  const box = new THREE.Box3();
  const scene = (ctx.world.scene as any).three as THREE.Object3D | undefined;
  if (!scene) return box;
  scene.updateMatrixWorld(true);
  const boxes: Array<{ box: THREE.Box3; size: number }> = [];
  scene.traverse((object: THREE.Object3D) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || isDevRenderBatch(mesh)) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox?.();
    if (!geometry.boundingBox) return;
    const world = geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    if (world.isEmpty()) return;
    const size = world.getSize(new THREE.Vector3());
    boxes.push({ box: world, size: Math.max(size.x, size.y, size.z) });
  });
  if (boxes.length === 0) return box;
  const sorted = boxes.map((entry) => entry.size).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || sorted[0] || 0;
  const kept = median > 0 ? boxes.filter((entry) => entry.size <= median * 6) : boxes;
  for (const entry of kept.length > 0 ? kept : boxes) box.union(entry.box);
  return box;
}

/**
 * 变电默认视角：整站远景全景。
 *
 * 取全部已加载模型（IFC + DEV）的网格包围盒，按最大边长的 2.2 倍距离、
 * 约 40° 俯角放置相机；不包含网格/坐标轴，避免“全景”被辅助对象撑爆。
 */
export function fitCameraToStationOverview(
  ctx: ViewerContext,
  state: { hasFittedCamera: boolean },
  options?: { force?: boolean; distanceFactor?: number },
): boolean {
  if (state.hasFittedCamera && !options?.force) {
    debugLog(DEBUG_IFC_LOAD, '[Camera] station overview skipped: hasFittedCamera=true');
    return false;
  }
  const box = sceneMeshBounds(ctx);
  if (box.isEmpty()) {
    debugLog(DEBUG_IFC_LOAD, '[Camera] station overview skipped: no mesh bounds');
    return false;
  }
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (!(maxDim > 0) || !Number.isFinite(maxDim)) return false;
  const factor = options?.distanceFactor ?? 2.2;
  const distance = maxDim * factor;
  void ctx.world.camera.controls?.setLookAt(
    center.x + distance * 0.9,
    center.y + distance * 0.75,
    center.z + distance * 0.9,
    center.x,
    center.y,
    center.z,
  );
  state.hasFittedCamera = true;
  debugLog(DEBUG_IFC_LOAD, '[Camera] station overview applied', { center, distance, maxDim });
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
