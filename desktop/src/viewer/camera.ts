import { reportBackgroundError } from '../utils/backgroundErrors.js';
import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import type { SelectionCommitGuard } from '../shared/selectionContracts.js';
import {isDevRenderBatch} from './devInstanceBatches.js';
import {requestViewerRender} from './demandRendering.js';

/** A fitted overview can be farther away than OBC's default 1000 m far plane.
 * Bound the required depth by the fitted position and box sphere, rather than
 * using a global huge far plane. Update both public projection cameras so a
 * later projection switch cannot restore a stale clipping range. */
function ensureFittedClipping(ctx:ViewerContext,box:THREE.Box3,position:THREE.Vector3,farPreset?:number):void {
  const sphere=box.getBoundingSphere(new THREE.Sphere());
  const distance=position.distanceTo(sphere.center),radius=sphere.radius;
  if(!Number.isFinite(distance)||!Number.isFinite(radius)||radius<0)return;
  const far=Math.max(10,(distance+radius)*1.2);
  const near=Math.max(.01,(distance-radius)*.05);
  const rig=ctx.world.camera as typeof ctx.world.camera & {threePersp?:THREE.PerspectiveCamera;threeOrtho?:THREE.OrthographicCamera};
  let changed=false;
  for(const camera of new Set([rig.three,rig.threePersp,rig.threeOrtho])){
    if(!camera||!('near'in camera)||!('far'in camera)||!('updateProjectionMatrix'in camera))continue;
    const projection=camera as THREE.PerspectiveCamera|THREE.OrthographicCamera;
    const configured=farPreset!==undefined&&Number.isFinite(farPreset)&&farPreset>0?farPreset:projection.far;
    const nextFar=Math.max(Number.isFinite(configured)?configured:0,far);
    const nextNear=Math.min(Number.isFinite(projection.near)&&projection.near>=0?projection.near:.1,near);
    if(projection.far===nextFar&&projection.near===nextNear)continue;
    projection.far=nextFar;projection.near=nextNear;projection.updateProjectionMatrix();changed=true;
  }
  if(changed)requestViewerRender(ctx);
}

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
  ensureFittedClipping(ctx,box,new THREE.Vector3(center.x+distance,center.y+distance*.8,center.z+distance));
  void Promise.resolve(ctx.world.camera.controls?.setLookAt(center.x + distance, center.y + distance * 0.8, center.z + distance, center.x, center.y, center.z)).catch(reportBackgroundError);
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
  scene.traverseVisible((object: THREE.Object3D) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || mesh.userData.interactionDecoration || isDevRenderBatch(mesh)) return;
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
 * 按视口宽高、视场角和可见模型的投影边界定位，保留约 20% 总留白。
 * 不包含隐藏图层及交互辅助对象，电压等级远裁剪预设由 services 注入。
 */
export function fitCameraToStationOverview(
  ctx: ViewerContext,
  state: { hasFittedCamera: boolean },
  options?: { force?: boolean; farPlane?:number; fillFraction?:number },
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
  const direction=new THREE.Vector3(.9,.75,.9).normalize();
  const right=new THREE.Vector3(0,1,0).cross(direction).normalize(),up=direction.clone().cross(right).normalize();
  const rig=ctx.world.camera as typeof ctx.world.camera & {threePersp?:THREE.PerspectiveCamera};
  const camera=(rig.threePersp??rig.three) as THREE.PerspectiveCamera;
  const fov=camera&&Number.isFinite(camera.fov)&&camera.fov>0&&camera.fov<180?camera.fov:50;
  const canvas=(ctx.world.renderer as {three?:{domElement?:HTMLCanvasElement}}|undefined)?.three?.domElement;
  const aspect=canvas&&canvas.clientWidth>0&&canvas.clientHeight>0?canvas.clientWidth/canvas.clientHeight:
    camera&&Number.isFinite(camera.aspect)&&camera.aspect>0?camera.aspect:1;
  const fill=options?.fillFraction!==undefined&&Number.isFinite(options.fillFraction)?Math.max(.5,Math.min(.9,options.fillFraction)):.8;
  const vertical=Math.tan(fov*Math.PI/360)*fill,horizontal=vertical*aspect;
  let distance=1,projectedWidth=0,projectedHeight=0;
  for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
    const offset=new THREE.Vector3(x,y,z).sub(center),depth=offset.dot(direction),width=Math.abs(offset.dot(right)),height=Math.abs(offset.dot(up));
    distance=Math.max(distance,depth+width/horizontal,depth+height/vertical);
    projectedWidth=Math.max(projectedWidth,width*2);projectedHeight=Math.max(projectedHeight,height*2);
  }
  const position=center.clone().addScaledVector(direction,distance);
  ensureFittedClipping(ctx,box,position,options?.farPlane);
  void Promise.resolve(ctx.world.camera.controls?.setLookAt(
    position.x,
    position.y,
    position.z,
    center.x,
    center.y,
    center.z,
  )).catch(reportBackgroundError);
  const active=rig.three as THREE.OrthographicCamera;
  if(active?.isOrthographicCamera&&ctx.world.camera.controls?.zoomTo){
    const height=Math.max(projectedHeight,projectedWidth/aspect,.01)/fill;
    void Promise.resolve(ctx.world.camera.controls.zoomTo((active.top-active.bottom)/height,false)).catch(reportBackgroundError);
  }
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
  const controls = ctx.world.camera.controls;
  if (!controls) return;
  const currentPosition = controls.getPosition?.(new THREE.Vector3(), false);
  const currentTarget = controls.getTarget?.(new THREE.Vector3(), false);
  const direction = currentPosition && currentTarget ? currentPosition.clone().sub(currentTarget) : new THREE.Vector3(1, .8, 1);
  if (direction.lengthSq() < 1e-12) direction.set(1, .8, 1);
  direction.normalize();
  const camera = (ctx.world.camera as any).three as THREE.PerspectiveCamera;
  const fov = Number.isFinite(camera?.fov) ? camera.fov * Math.PI / 180 : Math.PI / 4;
  const aspect = camera?.aspect > 0 ? camera.aspect : 1;
  const distance = Math.max(maxDim * 1.1, size.length() * .6 / Math.tan(fov / 2) / Math.min(1, aspect));
  const position = center.clone().addScaledVector(direction, distance);
  let abort!: () => void;
  const interrupted = new Promise<void>((resolve) => { abort=resolve; });
  const cancel = (): void => {
    // CameraControls.stop() snaps to its old end target. Freeze the current
    // position/target first, so a subsequent empty selection retains the view.
    if (controls.getPosition && controls.getTarget) {
      const position=controls.getPosition(new THREE.Vector3(),false);
      const target=controls.getTarget(new THREE.Vector3(),false);
      void Promise.resolve(controls.setLookAt(position.x,position.y,position.z,target.x,target.y,target.z,false)).catch(reportBackgroundError);
    }
    controls.stop?.();
    abort();
  };
  guard?.signal?.addEventListener('abort',cancel,{once:true});
  try {
    if (guard && !guard.isCurrent()) return;
    ensureFittedClipping(ctx,box,position);
    const movement=controls.setLookAt(position.x,position.y,position.z,center.x,center.y,center.z,false);
    if ((camera as any)?.isOrthographicCamera) {
      const orthographic = camera as unknown as THREE.OrthographicCamera;
      const zoom = Math.min(orthographic.right-orthographic.left, orthographic.top-orthographic.bottom) / Math.max(size.length()*1.15, .01);
      if (controls.zoomTo) await controls.zoomTo(zoom, false);
    }
    await (guard?.signal ? Promise.race([movement,interrupted]) : movement);
  } finally { guard?.signal?.removeEventListener('abort',cancel); }
}
