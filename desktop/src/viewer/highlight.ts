import {requestObjectRender,requestViewerRender} from './demandRendering.js';
import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { ViewerState as AppState } from '../shared/viewerState.js';
import type { SelectionCommitGuard } from '../shared/selectionContracts.js';
import type { SelectionRequest } from '../shared/selectionContracts.js';
import { frameBox } from './camera.js';
import { setDevInstanceHighlight } from './devInstanceBatches.js';
import { perfBegin } from '../utils/perfTimings.js';
import { addSelectionOutline, removeSelectionOutline, clearMeshOutlines, clearFragmentOutlines, outlineFragmentItems, SELECTION_AMBER } from './selectionOutline.js';

/** MOD/STL 高亮颜色（与 IFC 高亮保持一致） */
const HIGHLIGHT_MOD_COLOR = new THREE.Color(SELECTION_AMBER);

/**
 * 重置 MOD/STL 高亮：恢复所有 mesh 的原始材质并 dispose clone。
 *
 * MOD 材质是共享的（_sharedMaterialCache），高亮时 clone 了材质，
 * reset 时必须恢复原始材质引用并 dispose clone，避免内存泄漏和
 * 影响其他使用同一共享材质的 mesh。
 */
export function resetModHighlight(state: AppState): void {
  clearMeshOutlines(state);
  if (!state.highlightedModState) return;
  const { originalMaterials } = state.highlightedModState;
  for (const [mesh, originalMat] of originalMaterials) {
    const current = mesh.material;
    if (current !== originalMat) {
      // dispose cloned highlight materials
      if (Array.isArray(current)) {
        current.forEach((m) => m.dispose());
      } else {
        (current as THREE.Material).dispose();
      }
    }
    mesh.material = originalMat;requestObjectRender(mesh);
    setDevInstanceHighlight(mesh, false);
  }
  state.highlightedModState = null;
}

/** Restore only a departing representation, preserving other selected sources. */
export function removeModHighlightGroup(state: AppState, group: THREE.Object3D): void {
  const owned = state.highlightedModState;
  if (!owned?.groups.includes(group)) return;
  group.traverse(object => {
    const mesh = object as THREE.Mesh, original = owned.originalMaterials.get(mesh);
    if (!original) return;
    removeSelectionOutline(state, mesh);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mesh.material !== original) materials.forEach(material => material.dispose());
    mesh.material = original;requestObjectRender(mesh); setDevInstanceHighlight(mesh, false);
    owned.originalMaterials.delete(mesh);
  });
  owned.groups = owned.groups.filter(value => value !== group);
  if (!owned.groups.length) state.highlightedModState = null;
}

/**
 * 高亮一组 MOD/STL Group：克隆每个 mesh 的材质并设置 emissive 发光。
 *
 * 设计要点：
 * - MOD 材质是共享的（MeshStandardMaterial from _sharedMaterialCache），
 *   必须 clone 后修改，不能直接改原材质
 * - STL 使用 MeshPhongMaterial，同样 clone 后修改
 * - 两种材质都有 emissive 属性，使用 emissive 发光作为高亮效果
 * - 保存原始材质引用到 state.highlightedModState，供 resetModHighlight 恢复
 */
export function highlightModGroups(
  state: AppState,
  groups: THREE.Object3D[],
): void {
  // 先重置已有高亮（恢复上一次高亮的 mesh 材质）
  resetModHighlight(state);
  for (const group of groups) addModHighlightGroup(state, group);
}

/** Add a replacement without recloning unchanged selected meshes. */
export function addModHighlightGroup(state: AppState, group: THREE.Object3D): void {
  const owned: NonNullable<AppState['highlightedModState']> = state.highlightedModState
    ?? {groups: [], originalMaterials: new Map()};
  if (owned.groups.includes(group)) return;
  const originalMaterials = owned.originalMaterials;
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material || originalMaterials.has(mesh)) return;
    setDevInstanceHighlight(mesh, true);

    // 保存原始材质引用
    originalMaterials.set(mesh, mesh.material);
    addSelectionOutline(state, mesh);

    // 克隆材质并应用高亮
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const highlighted = mats.map((mat) => {
      const cloned = mat.clone();
      // MeshStandardMaterial / MeshPhongMaterial 都有 emissive
      if ('emissive' in cloned) {
        (cloned as THREE.MeshStandardMaterial).emissive.add(HIGHLIGHT_MOD_COLOR.clone().multiplyScalar(.025));
      }
      if ('color' in cloned && (cloned as THREE.MeshStandardMaterial).color?.isColor) (cloned as THREE.MeshStandardMaterial).color.lerp(HIGHLIGHT_MOD_COLOR, .025);
      cloned.needsUpdate = true;
      return cloned;
    });
    mesh.material = highlighted.length === 1 ? highlighted[0] : highlighted;requestObjectRender(mesh);
  });
  owned.groups.push(group);
  state.highlightedModState = owned;
}

const highlightCommits = new WeakMap<AppState, Promise<void>>();

/** Share ordering with representation changes; only the selected meshes change. */
export async function enqueueHighlightCommit(state: AppState, guard: SelectionCommitGuard,
  apply: () => Promise<void> | void): Promise<void> {
  if (!guard.isCurrent()) return;
  const previous = highlightCommits.get(state) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => { if (guard.isCurrent()) return apply(); });
  highlightCommits.set(state, task);
  try { await task; } finally { if (highlightCommits.get(state) === task) highlightCommits.delete(state); }
}

/** Only the external reset/apply stage is serialized; reads and loads stay concurrent. */
export async function commitSelectionHighlight(
  ctx: ViewerContext, state: AppState, guard: SelectionCommitGuard,
  apply?: () => Promise<void> | void,
): Promise<void> {
  if (!guard.isCurrent()) return;
  const meta={selectionId:state.selectionRequest?.id,selectionKind:state.selectionRequest?.target?.kind,sourcePath:state.selectionRequest?.target?.key};
  const end=perfBegin('selection.highlightCommit',meta);
  try { await enqueueHighlightCommit(state,guard,async () => {
    if (!guard.isCurrent()) return;
    const items = state.highlightedItems;
    if (items) {
      await ctx.fragments.resetHighlight(items as any);
      if (!guard.isSessionCurrent()) return;
      if (state.highlightedItems === items) state.highlightedItems = null;
    }
    if (!guard.isCurrent()) return;
    resetModHighlight(state);
    clearFragmentOutlines(state);
    for (const runtime of state.ifcRegionalRuntimes.values()) runtime.clearHighlight();
    await apply?.();
    if (guard.isCurrent()) {
      state.selectionHighlightRequestId = state.selectionRequest?.id ?? null;
      await state.selectionVisibility?.sync(guard);
    }
  }); } finally {
    requestViewerRender(ctx);end(undefined,{...meta,current:guard.isCurrent()});
  }
}

/** 重置当前高亮（IFC + MOD），与选择的外部高亮提交使用同一短队列。 */
export async function resetHighlight(ctx: ViewerContext, state: AppState, isCurrent: () => boolean = () => true): Promise<void> {
  await commitSelectionHighlight(ctx,state,{isCurrent,isSessionCurrent:isCurrent});
}

/** Render a resolved selection; source documents and GUID ownership stay in services. */
export async function highlightIfcItems(ctx:ViewerContext,state:AppState,selected:Readonly<Record<string,readonly number[]>>,request:SelectionRequest):Promise<void> {
  const guard=state.selectionGuard(request);if(!guard.isCurrent())return;
  const items:OBC.ModelIdMap={},boxes:THREE.Box3[]=[];
  for(const [runtimeId,ids] of Object.entries(selected)) {
    if(!guard.isCurrent())return;if(!ids.length)continue;
    items[runtimeId]=new Set(ids);
    try {const box=await ctx.fragments.list.get(runtimeId)?.getMergedBox([...ids]);if(box&&!box.isEmpty())boxes.push(box);}catch{/* Bounds are optional. */}
  }
  await commitSelectionHighlight(ctx,state,guard,Object.keys(items).length?async()=>{
    await outlineFragmentItems(ctx,state,items as any,guard);
    if(guard.isSessionCurrent())state.highlightedItems=items as any;
  }:undefined);
  if(guard.isCurrent()&&boxes.length&&state.canAutoLocate(request))await frameBox(ctx,boxes.reduce((box,next)=>box.union(next),boxes[0].clone()),guard);
}
