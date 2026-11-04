import * as THREE from 'three';
import type { AppState, SelectionCommitGuard } from '../app/state.js';
import type { ViewerContext } from './viewerEngine.js';

export const SELECTION_AMBER = 0xf59e0b;
const edgeCache = new Map<THREE.BufferGeometry, { geometry: THREE.EdgesGeometry; count: number }>();
type Outline = { line: THREE.LineSegments; release(): void };
const selected = new WeakMap<AppState, Map<THREE.Mesh, Outline>>();
const fragmentGroups = new WeakMap<AppState, Map<string, THREE.Group>>();
const hover = new WeakMap<AppState, () => void>();

function edge(mesh: THREE.Mesh, color: number, opacity: number): Outline {
  const sourceGeometry = mesh.geometry;
  let cached = edgeCache.get(sourceGeometry);
  if (!cached) { cached = { geometry: new THREE.EdgesGeometry(sourceGeometry, 25), count: 0 }; edgeCache.set(sourceGeometry, cached); }
  cached.count++;
  const material = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: true, depthWrite: false });
  const line = new THREE.LineSegments(cached.geometry, material); line.userData.interactionDecoration = true;
  line.raycast = () => {}; line.renderOrder = 100; mesh.add(line);
  let released = false;
  return { line, release() {
    if (released) return; released = true; line.removeFromParent(); material.dispose();
    if (--cached!.count === 0) { cached!.geometry.dispose(); edgeCache.delete(sourceGeometry); }
  } };
}

export function addSelectionOutline(state: AppState, mesh: THREE.Mesh): void {
  let rows = selected.get(state); if (!rows) { rows = new Map(); selected.set(state, rows); }
  if (!rows.has(mesh)) rows.set(mesh, edge(mesh, SELECTION_AMBER, 1));
  state.selectionDecorationCleanup = () => { clearMeshOutlines(state); clearFragmentOutlines(state); clearHoverOutline(state); };
}
export function removeSelectionOutline(state: AppState, mesh: THREE.Mesh): void {
  selected.get(state)?.get(mesh)?.release(); selected.get(state)?.delete(mesh);
}
export function clearMeshOutlines(state: AppState): void { for (const row of selected.get(state)?.values() ?? []) row.release(); selected.delete(state); }
export function clearHoverOutline(state: AppState): void { hover.get(state)?.(); hover.delete(state); }
export function showHoverOutline(state: AppState, group?: THREE.Object3D): void {
  clearHoverOutline(state); if (!group) return;
  const rows: Outline[] = [];
  group.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry && !selected.get(state)?.has(mesh)) rows.push(edge(mesh, 0xffd48a, .55));
  });
  hover.set(state, () => rows.forEach(row => row.release()));
}
export function showHoverBounds(state: AppState, scene: THREE.Object3D, box: THREE.Box3): void {
  clearHoverOutline(state);
  const helper = new THREE.Box3Helper(box, 0xffd48a); helper.raycast = () => {}; helper.userData.interactionDecoration = true;
  scene.add(helper); hover.set(state, () => { helper.removeFromParent(); helper.geometry.dispose(); (helper.material as THREE.Material).dispose(); });
}

function disposeGroup(group: THREE.Group): void {
  group.removeFromParent(); group.traverse(object => {
    const item = object as THREE.Mesh;
    if (item.geometry) item.geometry.dispose();
    if (item.material) for (const material of Array.isArray(item.material) ? item.material : [item.material]) material.dispose();
  }); group.clear();
}
export function clearFragmentOutlines(state: AppState): void {
  for (const group of fragmentGroups.get(state)?.values() ?? []) disposeGroup(group);
  fragmentGroups.delete(state);
}

/** A group is a source-backed range, not a single render mesh. Its envelope
 * stays selectable while far items are batched or near meshes are absent. */
export function outlineSelectionRange(ctx:ViewerContext,state:AppState,box:THREE.Box3):void {
  if(box.isEmpty())return;
  let groups=fragmentGroups.get(state);if(!groups){groups=new Map();fragmentGroups.set(state,groups);}
  const key='selection-range',old=groups.get(key);if(old)disposeGroup(old);
  const group=new THREE.Group(),helper=new THREE.Box3Helper(box,SELECTION_AMBER);
  helper.raycast=()=>{};helper.userData.interactionDecoration=true;
  (helper.material as THREE.Material).depthTest=false;
  group.userData.interactionDecoration=true;group.add(helper);ctx.world.scene.three.add(group);groups.set(key,group);
  state.selectionDecorationCleanup=()=>{clearMeshOutlines(state);clearFragmentOutlines(state);clearHoverOutline(state);};
}

/** Geometry comes from the already loaded Fragments representation, with its
 * original transform; no IFC parsing, precision upgrade or camera action. */
async function fragmentGroup(model: any, ids: number[], color: number, opacity: number): Promise<THREE.Group> {
  const group = new THREE.Group(); group.userData.interactionDecoration = true;
  if (model.getItemsGeometry) {
    const items = await model.getItemsGeometry(ids);
    for (const parts of items) for (const part of parts) {
      if (!part.positions?.length) continue;
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(part.positions), 3));
      if (part.indices) geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
      const edges = new THREE.EdgesGeometry(geometry, 25);
      const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: true, depthWrite: false }));
      line.matrixAutoUpdate = false; if (part.transform?.elements) line.matrix.fromArray(part.transform.elements);
      line.raycast = () => {}; line.userData.interactionDecoration = true; line.renderOrder = 100; group.add(line);
      if (opacity > .8) {
        const surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .045, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
        surface.matrixAutoUpdate = false; surface.matrix.copy(line.matrix); surface.raycast = () => {}; surface.userData.interactionDecoration = true; group.add(surface);
      } else geometry.dispose();
    }
  }
  return group;
}

export async function outlineFragmentItems(ctx: ViewerContext, state: AppState, items: Record<string, Iterable<number>>, guard: SelectionCommitGuard): Promise<void> {
  let groups = fragmentGroups.get(state); if (!groups) { groups = new Map(); fragmentGroups.set(state, groups); }
  state.selectionDecorationCleanup = () => { clearMeshOutlines(state); clearFragmentOutlines(state); clearHoverOutline(state); };
  for (const [modelId, values] of Object.entries(items)) {
    const model = ctx.fragments.list?.get?.(modelId); if (!model) continue;
    const ids = [...values];
    for (let offset = 0; offset < ids.length; offset += 32) {
      if (!guard.isCurrent()) return;
      const batch = ids.slice(offset, offset+32), key = JSON.stringify([modelId, batch]); if (groups.has(key)) continue;
      let group: THREE.Group;
      try { group = await fragmentGroup(model, batch, SELECTION_AMBER, 1); }
      catch (error) { if (!guard.isCurrent()) return; throw error; }
      if (!guard.isCurrent()) { disposeGroup(group); return; }
      if (group.children.length) { model.object.add(group); groups.set(key, group); }
      if (ids.length > 32) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

export async function showFragmentHover(ctx: ViewerContext, state: AppState, modelId: string, localId: number, current: () => boolean): Promise<void> {
  const model = ctx.fragments.list.get(modelId); if (!model) return;
  const group = await fragmentGroup(model, [localId], 0xffd48a, .55);
  if (!current()) { disposeGroup(group); return; }
  clearHoverOutline(state); model.object.add(group); hover.set(state, () => disposeGroup(group));
}
