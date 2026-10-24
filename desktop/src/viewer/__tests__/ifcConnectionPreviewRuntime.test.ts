import { expect, it } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { IfcConnectionPreviewRuntime } from '../ifcConnectionPreviewRuntime.js';
import { connectionChunkBytes } from '../ifcConnectionBatches.js';
const object = { expressId: 7, globalId: 'g7', ifcType: 'IFCCABLESEGMENT', name: 'wire', bounds: [0,0,0,3,4,1] };
function batch(sequence = 0) {
  return { sequence, bytes: 626, final: false, modelId: 'model', sourcePath: 'CBM/wire.ifc', sourceIdentity: 'sha',
    coordinateBasis: 'ifc-y-up-m' as const, objects: [object], chunks: [{ object, part:0, chunk:0,
      vertices: new Float32Array([0,0,0,0,0,1, 3,0,0,0,0,1, 3,4,0,0,0,1]),
      matrix:new THREE.Matrix4().makeTranslation(2,0,0).toArray(), color:[0.2,0.3,0.4,1], objectComplete:true }] };
}
function fixture() {
  const state = new AppState(), session = state.activateProject(1,'sha'), scene = new THREE.Scene();
  return new IfcConnectionPreviewRuntime({world:{scene:{three:scene}}} as any,session,()=>state.isCurrentSession(session));
}
it('counts authoritative warm connection objects without a mesh receipt, preserving source coordinates and identity', () => {
  const runtime=fixture();
  const ordinary={...object,expressId:9,globalId:'building',ifcType:'IFCWALL',name:'wall'};
  runtime.markModelReady('model',[object,ordinary]);
  expect(runtime.diagnostics.objects).toBe(1);
  expect(runtime.diagnostics.readyModels).toBe(1);
  expect(runtime.diagnostics.completeModels).toBe(0);
  expect(runtime.diagnostics.batches).toBe(0);
  expect(runtime.sourceObjects()).toEqual([{modelId:'model',objects:[object]}]);
  expect(runtime.root.children).toHaveLength(0);
  runtime.markModelReady('model',[object]); expect(runtime.diagnostics.objects).toBe(1);
  runtime.release();expect(runtime.sourceObjects()).toEqual([]);
});
it('merges streamed and authoritative identities without double counting or claiming a failed preview receipt completed',()=>{
  const runtime=fixture();runtime.acceptBatch(batch());runtime.markFailed('model');
  runtime.markModelReady('model',[object]);
  expect(runtime.diagnostics.objects).toBe(1);expect(runtime.diagnostics.partialModels).toBe(1);
  expect(runtime.diagnostics.completeModels).toBe(0);expect(runtime.diagnostics.readyModels).toBe(1);
  expect(runtime.root.children).toHaveLength(0);runtime.release();
});
it('isolates exact source identities across current and future batches without changing coordinates',()=>{
  const runtime=fixture();runtime.setTransform(new THREE.Matrix4());runtime.acceptBatch(batch());
  const scope={localIds:new Set<number>(),globalIds:new Set(['g7']),expressIds:new Set<number>()};
  runtime.setSelectionScope(true,new Map([['model',scope]]));
  const selected=runtime.root.children[0].children[0];expect(selected.visible).toBe(true);
  const other={...object,expressId:8,globalId:'g8'},next=batch(1);
  const chunks=[{...next.chunks[0],object:other}];
  runtime.acceptBatch({...next,objects:[other],chunks,bytes:chunks.reduce((sum,chunk)=>sum+connectionChunkBytes(chunk),0)});
  const hidden=runtime.root.children[1].children[0];expect(hidden.visible).toBe(false);
  const matrix=hidden.matrix.toArray();runtime.setTransform(new THREE.Matrix4().makeTranslation(1,2,3));
  expect(hidden.visible).toBe(false);expect(hidden.matrix.toArray()).toEqual(matrix);
  runtime.setSelectionScope(true,new Map());expect(selected.visible).toBe(false);
  runtime.setSelectionScope(false,new Map());expect(selected.visible).toBe(true);expect(hidden.visible).toBe(true);
  runtime.release();
});
it('renders the actual bent source triangle, original color and placement with one Y-up conversion', () => {
  const runtime=fixture();
  const project = new THREE.Matrix4().makeTranslation(10,20,30).multiply(new THREE.Matrix4().makeRotationX(-Math.PI/2));
  runtime.setTransform(project);
  expect(runtime.acceptBatch(batch())).toBe(true);
  runtime.root.updateMatrixWorld(true);
  const mesh=runtime.root.children[0].children[0] as THREE.Mesh;
  const position=mesh.geometry.getAttribute('position');
  const world=new THREE.Vector3().fromBufferAttribute(position,2).applyMatrix4(mesh.matrixWorld);
  expect(world.toArray()).toEqual([15,24,30]);
  expect((mesh.material as THREE.MeshStandardMaterial).color.toArray()).toEqual([0.2,0.3,0.4]);
  expect(mesh.userData.globalId).toBe('g7');
  expect(runtime.acceptBatch(batch())).toBe(false);
  expect(runtime.acceptBatch({...batch(2),chunks:[],objects:[],bytes:0,final:true})).toBe(false);
  expect(runtime.acceptBatch({...batch(1),chunks:[],objects:[],bytes:0,final:true})).toBe(true);
  runtime.markComplete('model',{objectCount:1,sequence:2});
  expect(runtime.diagnostics.completeModels).toBe(1);
  runtime.markModelReady('model');
  expect(runtime.root.children).toHaveLength(0);
  expect(runtime.acceptBatch(batch(2))).toBe(false);
  runtime.release();
});
it('rejects identity changes, metadata-only geometry and false byte accounting',()=>{
  const runtime=fixture();
  expect(runtime.acceptBatch({...batch(),chunks:[]})).toBe(false);
  expect(runtime.acceptBatch({...batch(),bytes:1})).toBe(false);
  expect(runtime.acceptBatch(batch())).toBe(true);
  expect(runtime.acceptBatch({...batch(1),sourceIdentity:'other'})).toBe(false);
  runtime.markComplete('model',{objectCount:2,sequence:2});
  expect(runtime.diagnostics.completeModels).toBe(0);
  expect(runtime.diagnostics.partialModels).toBe(1);
  runtime.release();
});
it('keeps valid source chunks on conversion failure and releases every owned mesh on close',()=>{
  const runtime=fixture();runtime.acceptBatch(batch());runtime.markFailed('model');runtime.markFailed('model');
  expect(runtime.diagnostics.partialModels).toBe(1);expect(runtime.root.children).toHaveLength(1);
  runtime.release();expect(runtime.root.children).toHaveLength(0);
  expect(runtime.acceptBatch(batch(1))).toBe(false);
});
it('accepts geometry and completion markers for multiple new objects in one batch and rejects in-batch duplicates atomically',()=>{
  const runtime=fixture(), source=batch(), a=source.chunks[0];
  const other={...object,expressId:8,globalId:'g8'};
  const chunks=[{...a,objectComplete:false},{...a,object:other,vertices:a.vertices.slice(),objectComplete:false},
    {...a,object:other,part:-1,vertices:new Float32Array()}, {...a,part:-1,vertices:new Float32Array()}];
  const combined={...source,objects:[object,other],chunks,bytes:chunks.reduce((sum,chunk)=>sum+connectionChunkBytes(chunk),0)};
  expect(runtime.acceptBatch({...combined,chunks:[chunks[0],chunks[0]],bytes:2*connectionChunkBytes(chunks[0])})).toBe(false);
  expect(runtime.root.children).toHaveLength(0);
  expect(runtime.acceptBatch(combined)).toBe(true);
  expect(runtime.root.children[0].children.map(mesh=>mesh.userData.globalId)).toEqual(['g7','g8']);
  expect(runtime.acceptBatch({...combined,sequence:1,objects:[],chunks:[],bytes:0,final:true})).toBe(true);
  runtime.markComplete('model',{objectCount:2,sequence:2});
  expect(runtime.diagnostics.completeModels).toBe(1);
  runtime.release();
});
