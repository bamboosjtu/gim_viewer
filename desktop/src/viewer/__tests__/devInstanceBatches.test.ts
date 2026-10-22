import {expect,it,vi} from 'vitest';
import * as THREE from 'three';
import {DevInstanceBatches} from '../devInstanceBatches.js';
import {highlightModGroups,resetModHighlight} from '../highlight.js';
import {DevGlbTemplate} from '../../services/devGlbTemplateRuntime.js';
import {fitCameraToStationOverview} from '../camera.js';

function fixture() {
  const scene=new THREE.Scene(),geometry=new THREE.BoxGeometry(2,2,2),material=new THREE.MeshStandardMaterial({color:0x234567});
  const source=new THREE.Group();source.add(new THREE.Mesh(geometry,material));
  const template=new DevGlbTemplate('DEV/a.dev',source),adapter=new DevInstanceBatches(scene);
  const groups=[10,20,30].map((x,i)=>{
    const group=template.createPlacement({contract:'source-template',rootOccurrence:`root${i}`,instanceKey:`instance${i}`,
      placementMatrix:new THREE.Matrix4().makeTranslation(x*1000,0,0).toArray()});
    scene.add(group);return group;
  });
  const meshes=groups.map(group=>group.children[0].children[0] as THREE.Mesh);
  const add=()=>groups.forEach(group=>adapter.add(group));
  const batch=()=>adapter.root.children[0] as THREE.InstancedMesh;
  const pick=(x:number)=>adapter.pick(new THREE.Raycaster(new THREE.Vector3(x,0,5),new THREE.Vector3(0,0,-1)));
  return {scene,geometry,material,template,adapter,groups,meshes,add,batch,pick};
}
it('reduces repeated draws while retaining the exact original occurrence/assembly graph and ray identity',()=>{
  const f=fixture();const before=f.groups.map(group=>new THREE.Box3().setFromObject(group));f.add();
  expect(f.adapter.statistics).toMatchObject({groups:3,batches:1,batchedMeshes:3,avoidedMeshDraws:2});
  expect(f.meshes.map(mesh=>mesh.layers.mask)).toEqual([0,0,0]);
  f.groups.forEach((group,i)=>expect(new THREE.Box3().setFromObject(group).equals(before[i])).toBe(true));
  expect(f.pick(10)).toMatchObject({rootOccurrence:'root0',instanceKey:'instance0',distance:4});
  expect(f.pick(20)).toMatchObject({rootOccurrence:'root1',instanceKey:'instance1',distance:4});
  expect(f.pick(30)).toMatchObject({rootOccurrence:'root2',instanceKey:'instance2',distance:4});
  f.adapter.release();f.template.dispose();
});
it('keeps the station overview camera identical when GPU draw batches are added',()=>{
  const f=fixture(),setLookAt=vi.fn();
  const ctx={world:{scene:{three:f.scene},camera:{controls:{setLookAt}}}} as any;
  expect(fitCameraToStationOverview(ctx,{hasFittedCamera:false},{distanceFactor:1.7})).toBe(true);
  const expected=setLookAt.mock.calls[0];
  f.add();
  expect(fitCameraToStationOverview(ctx,{hasFittedCamera:false},{distanceFactor:1.7})).toBe(true);
  expect(setLookAt.mock.calls[1]).toEqual(expected);
  f.adapter.release();f.template.dispose();
});
it('preserves nested local matrices, positive nonuniform scale and project placement without applying transforms twice',()=>{
  const f=fixture();
  f.scene.position.set(12,13,14);f.scene.rotation.x=.4;
  f.groups.forEach((group,i)=>{
    const nested=group.children[0];nested.rotation.set(.1,.2,.3);nested.scale.set(1,2,3);nested.updateMatrix();
    group.matrix.premultiply(new THREE.Matrix4().makeRotationY(.2+i*.1));
  });
  f.add();f.scene.updateMatrixWorld(true);
  const vertex=new THREE.Vector3(.2,.3,.4),matrix=new THREE.Matrix4();
  f.meshes.forEach((mesh,i)=>{
    f.batch().getMatrixAt(i,matrix);
    const actual=vertex.clone().applyMatrix4(matrix).applyMatrix4(f.batch().matrixWorld);
    const expected=vertex.clone().applyMatrix4(mesh.matrixWorld);
    expect(actual.distanceTo(expected)).toBeLessThan(2e-6);
  });
  f.adapter.release();f.template.dispose();
});
it('excludes only a selected mesh from its batch and restores original shared materials and picking after reset',()=>{
  const f=fixture();f.add();const state={highlightedModState:null} as any;
  highlightModGroups(state,[f.groups[1]]);
  expect(f.batch().count).toBe(2);expect(f.meshes[1].layers.mask).toBe(1);
  expect(f.meshes[1].material).not.toBe(f.material);expect(f.material.emissive.getHex()).toBe(0);
  expect(f.pick(30)?.instanceKey).toBe('instance2');expect(f.pick(20)?.instanceKey).toBe('instance1');
  const dispose=vi.spyOn(f.meshes[1].material as THREE.Material,'dispose');
  resetModHighlight(state);
  expect(dispose).toHaveBeenCalledOnce();expect(f.meshes[1].material).toBe(f.material);
  expect(f.meshes[1].layers.mask).toBe(0);expect(f.batch().count).toBe(3);
  expect(f.pick(20)?.instanceKey).toBe('instance1');f.adapter.release();f.template.dispose();
});
it('compacts invisible slots, respects inherited visibility and restores the same identities',()=>{
  const f=fixture();f.add();f.groups[0].visible=false;f.adapter.sync();
  expect(f.batch().count).toBe(2);expect(f.pick(10)).toBeNull();expect(f.pick(20)?.instanceKey).toBe('instance1');
  f.groups[1].visible=false;f.adapter.sync();expect(f.batch().count).toBe(1);
  expect(f.pick(30)?.instanceKey).toBe('instance2');
  f.groups.forEach(group=>group.visible=true);f.adapter.sync();expect(f.batch().count).toBe(3);
  f.scene.visible=false;expect(f.pick(20)).toBeNull();f.scene.visible=true;
  f.adapter.release();f.template.dispose();
});
it('falls back for mirrored, sheared, transparent and multi-material meshes while preserving their geometry',()=>{
  const f=fixture();f.add();
  for(const kind of ['mirror','shear','transparent','multi']) {
    const group=f.template.createPlacement({contract:'source-template',rootOccurrence:kind,instanceKey:kind});
    const mesh=group.children[0].children[0] as THREE.Mesh;
    if(kind==='mirror')group.matrix.makeScale(-1,1,1);
    if(kind==='shear')group.matrix.elements[4]=.3;
    if(kind==='transparent'){mesh.material=f.material.clone();mesh.material.transparent=true;mesh.material.opacity=.5;}
    if(kind==='multi')mesh.material=[f.material];
    f.scene.add(group);f.adapter.add(group);expect(mesh.layers.mask).toBe(1);
    expect(mesh.geometry).toBe(f.geometry);
  }
  expect(f.adapter.statistics.batchedMeshes).toBe(3);f.adapter.release();f.template.dispose();
});
it('releases only instance buffers, dissolves small buckets and leaves shared geometry owned by its template',()=>{
  const f=fixture();f.add();const batchDispose=vi.spyOn(f.batch(),'dispose');
  const geometryDispose=vi.spyOn(f.geometry,'dispose'),materialDispose=vi.spyOn(f.material,'dispose');
  f.adapter.remove(f.groups[0]);f.groups[0].removeFromParent();
  expect(batchDispose).toHaveBeenCalledOnce();expect(f.meshes.map(mesh=>mesh.layers.mask)).toEqual([1,1,1]);
  expect(f.adapter.statistics.batches).toBe(0);
  f.scene.add(f.groups[0]);f.adapter.add(f.groups[0]);expect(f.adapter.statistics.batches).toBe(1);
  f.adapter.release();f.adapter.release();
  expect(f.adapter.statistics).toMatchObject({groups:0,batches:0,instanceBufferBytes:0});
  expect(geometryDispose).not.toHaveBeenCalled();expect(materialDispose).not.toHaveBeenCalled();
  f.template.dispose();expect(geometryDispose).toHaveBeenCalledOnce();expect(materialDispose).toHaveBeenCalledOnce();
});
it('updates the batch after a coordinate anchor change and keeps explicit L2 on the ordinary path',()=>{
  const f=fixture();f.add();f.groups.forEach(group=>group.matrix.elements[12]+=100);f.adapter.sync();
  expect(f.pick(20)).toBeNull();expect(f.pick(120)?.rootOccurrence).toBe('root1');
  const fine=f.template.createPlacement({contract:'source-template',rootOccurrence:'fine',instanceKey:'fine',
    placementMatrix:new THREE.Matrix4().makeTranslation(5000,0,0).toArray()});
  f.scene.add(fine);f.adapter.add(fine,false);
  expect((fine.children[0].children[0] as THREE.Mesh).layers.mask).toBe(1);
  expect(f.pick(5)?.rootOccurrence).toBe('fine');expect(f.adapter.statistics.batchedMeshes).toBe(3);
  f.adapter.release();f.template.dispose();
});
it('keeps distinct occurrence colors in separate material buckets sharing the same geometry',()=>{
  const f=fixture();f.add();const blue=f.material.clone();blue.color.setHex(0x0055ff);
  for(const x of [5,15,25]) {
    const group=f.template.createPlacement({contract:'source-template',rootOccurrence:`blue${x}`,instanceKey:`blue${x}`,
      placementMatrix:new THREE.Matrix4().makeTranslation(x*1000,0,0).toArray()});
    (group.children[0].children[0] as THREE.Mesh).material=blue;f.scene.add(group);f.adapter.add(group);
  }
  expect(f.adapter.statistics.batches).toBe(2);
  expect(new Set(f.adapter.root.children.map(object=>(object as THREE.Mesh).material))).toEqual(new Set([f.material,blue]));
  expect(f.pick(15)?.instanceKey).toBe('blue15');expect(f.pick(20)?.instanceKey).toBe('instance1');
  f.adapter.release();blue.dispose();f.template.dispose();
});
it('retains all ordinary geometry and stops retrying a batch after an instance-buffer failure',()=>{
  const f=fixture();const upload=vi.spyOn(THREE.InstancedMesh.prototype,'setMatrixAt').mockImplementation(()=>{throw Error('simulated instance buffer failure');});
  try {
    expect(()=>f.add()).not.toThrow();expect(f.adapter.root.children).toHaveLength(0);
    expect(f.meshes.map(mesh=>mesh.layers.mask)).toEqual([1,1,1]);
    expect(f.adapter.statistics).toMatchObject({failures:1,failedBuckets:1,batches:0,instanceBufferBytes:0});
    f.adapter.sync();expect(upload).toHaveBeenCalledOnce();expect(f.pick(20)?.instanceKey).toBe('instance1');
  } finally {upload.mockRestore();f.adapter.release();f.template.dispose();}
});
it('keeps explicit ancestor render ordering on the ordinary mesh path',()=>{
  const f=fixture();f.groups.forEach(group=>group.renderOrder=2);f.add();
  expect(f.adapter.statistics.batches).toBe(0);expect(f.meshes.map(mesh=>mesh.layers.mask)).toEqual([1,1,1]);
  f.adapter.release();f.template.dispose();
});
