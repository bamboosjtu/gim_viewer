import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { highlightModGroups, resetModHighlight } from '../highlight.js';
import { outlineFragmentItems, clearFragmentOutlines, showHoverOutline, clearHoverOutline } from '../selectionOutline.js';

it('keeps source colour and opacity, draws amber edges, and restores shared materials without disposing source geometry',()=>{
  const state=new AppState(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshStandardMaterial({color:0x516b84,transparent:true,opacity:.7}),mesh=new THREE.Mesh(geometry,material),other=new THREE.Mesh(geometry,material),root=new THREE.Group();root.add(mesh);
  const dispose=vi.spyOn(geometry,'dispose');highlightModGroups(state,[root]);
  const selected=mesh.material as THREE.MeshStandardMaterial;expect(selected.opacity).toBe(.7);expect(selected.transparent).toBe(true);expect(new THREE.Vector3(selected.color.r,selected.color.g,selected.color.b).distanceTo(new THREE.Vector3(material.color.r,material.color.g,material.color.b))).toBeLessThan(.1);
  expect(other.material).toBe(material);const line=mesh.children.find(child=>(child as THREE.LineSegments).isLineSegments) as THREE.LineSegments;expect(line).toBeDefined();expect((line.material as THREE.LineBasicMaterial).color.getHex()).toBe(0xf59e0b);
  resetModHighlight(state);expect(mesh.material).toBe(material);expect(mesh.children).toHaveLength(0);expect(dispose).not.toHaveBeenCalled();
});

it('hover never replaces material and selected outlines remain after hover is cleared',()=>{
  const state=new AppState(),mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial()),original=mesh.material;
  showHoverOutline(state,mesh);expect(mesh.material).toBe(original);expect(mesh.children).toHaveLength(1);clearHoverOutline(state);highlightModGroups(state,[mesh]);showHoverOutline(state,mesh);clearHoverOutline(state);expect(mesh.children).toHaveLength(1);resetModHighlight(state);
});

it('draws Fragments contours in the model coordinate frame without changing original materials or requesting IFC precision',async()=>{
  const state=new AppState(),parent=new THREE.Group();parent.position.set(10,20,30);
  const transform=new THREE.Matrix4().makeTranslation(1,2,3),getItemsGeometry=vi.fn(async()=>[[{positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2]),transform}]]),highlight=vi.fn();
  const ctx={fragments:{list:new Map([['m',{object:parent,getItemsGeometry}]]),highlight}} as any;
  await outlineFragmentItems(ctx,state,{m:[7]},{isCurrent:()=>true,isSessionCurrent:()=>true});parent.updateMatrixWorld(true);
  const line=parent.children[0].children[0];expect(line.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([11,22,33]);expect(highlight).not.toHaveBeenCalled();expect(getItemsGeometry).toHaveBeenCalledWith([7]);
  clearFragmentOutlines(state);expect(parent.children).toHaveLength(0);
});
