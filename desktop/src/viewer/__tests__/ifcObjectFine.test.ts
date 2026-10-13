import {it,expect,vi,afterEach} from 'vitest';
import * as THREE from 'three';
import {extractIfcObjectFine} from '../ifcObjectFineData.js';
import {IfcObjectFineRuntime,objectFineGroup} from '../ifcObjectFineRuntime.js';

const object={key:'ifc:model:object:20',modelId:'model',sourcePath:'CBM/source.ifc',expressId:20,globalId:'GUID',ifcType:'IFCPLATE',name:'Plate',provider:'ifc-preview' as const};
function api(){const vertices=new Float32Array([0,0,0,0,0,1,1000,0,0,0,0,1,0,1000,0,0,0,1]);const deleteGeometry=vi.fn(),deleteVector=vi.fn();
  return {GetLine:vi.fn(()=>({GlobalId:{value:'GUID'},type:1})),GetNameFromTypeCode:()=> 'IFCPLATE',GetFlatMesh:vi.fn(()=>({expressID:20,geometries:{size:()=>1,get:()=>({geometryExpressID:40,flatTransformation:new THREE.Matrix4().makeRotationX(-Math.PI/2).multiply(new THREE.Matrix4().makeScale(.001,.001,.001)).setPosition(10,20,30).toArray(),color:{x:.3,y:.4,z:.5,w:1}}),delete:deleteVector}})),GetGeometry:()=>({GetVertexData:()=>0,GetVertexDataSize:()=>18,GetIndexData:()=>0,GetIndexDataSize:()=>3,delete:deleteGeometry}),GetVertexArray:()=>vertices,GetIndexArray:()=>new Uint32Array([0,1,2]),GetCoordinationMatrix:()=>new THREE.Matrix4().toArray(),deleteGeometry,deleteVector};}
it('calls exactly one GetFlatMesh, copies buffers before releasing native owners and checks original identity',()=>{
  const a=api(),result=extractIfcObjectFine(a as any,0,20,'GUID');expect(a.GetFlatMesh).toHaveBeenCalledTimes(1);expect(a.GetFlatMesh).toHaveBeenCalledWith(0,20);expect(a.deleteGeometry).toHaveBeenCalledOnce();expect(a.deleteVector).toHaveBeenCalledOnce();expect(result.globalId).toBe('GUID');
  a.GetVertexArray().fill(9);expect(result.parts[0].vertices[0]).toBe(0);
  expect(()=>extractIfcObjectFine(a as any,0,20,'OTHER')).toThrow('identity mismatch');expect(a.GetFlatMesh).toHaveBeenCalledOnce();
});
it('composes existing anchor with already Y-up/metre flat geometry without a second unit scale',()=>{
  const result=extractIfcObjectFine(api() as any,0,20,'GUID'),sourceToViewer=new THREE.Matrix4().makeTranslation(-1,-2,-3).multiply(new THREE.Matrix4().makeRotationX(-Math.PI/2)),group=objectFineGroup(result,object,sourceToViewer);
  const box=new THREE.Box3().setFromObject(group);expect(box.min.toArray()).toEqual([9,18,26]);expect(box.max.toArray()).toEqual([10,18,27]);expect(group.userData).toMatchObject({expressId:20,globalId:'GUID',lod:2,approximate:false});
});
afterEach(()=>{vi.useRealTimers();});
it('deduplicates requests, reuses one Worker/model for another object, then terminates on project release',async()=>{
  const sent:any[]=[];let worker:any;const terminate=vi.fn();
  const runtime=new IfcObjectFineRuntime({wasm:{path:'/',absolute:true},readBytes:async()=>new Uint8Array([1]),worker:()=>worker={terminate,onmessage:null,postMessage:(message:any)=>{sent.push(message);queueMicrotask(()=>worker.onmessage({data:{id:message.id,data:message.type==='open'?{}:{...extractIfcObjectFine(api() as any,0,20,'GUID'),expressId:message.expressId}}}));}} as unknown as Worker});
  const a=runtime.load(object),b=runtime.load(object);expect(a).toBe(b);await a;await runtime.load({...object,expressId:21});
  expect(sent.filter(m=>m.type==='open')).toHaveLength(1);expect(sent.filter(m=>m.type==='object')).toHaveLength(2);runtime.release();expect(terminate).toHaveBeenCalledOnce();await expect(runtime.load(object)).rejects.toThrow('released');
});
it('release while bytes are pending never creates a late Worker',async()=>{
  let resolve!:(bytes:Uint8Array)=>void;const worker=vi.fn(),runtime=new IfcObjectFineRuntime({wasm:{path:'/',absolute:true},readBytes:()=>new Promise(r=>{resolve=r;}),worker});
  const task=runtime.load(object),rejected=expect(task).rejects.toThrow('released');runtime.release();resolve(new Uint8Array([1]));await rejected;expect(worker).not.toHaveBeenCalled();
});
it('fixed timeout kills a synchronous WASM task and retry creates a new Worker',async()=>{
  vi.useFakeTimers();const terminate=vi.fn(),create=vi.fn(()=>({terminate,postMessage:()=>{},onmessage:null,onerror:null}) as unknown as Worker);
  const runtime=new IfcObjectFineRuntime({wasm:{path:'/',absolute:true},readBytes:async()=>new Uint8Array([1]),worker:create,timeoutMs:30});
  const task=runtime.load(object),rejected=expect(task).rejects.toThrow('fixed budget');await vi.advanceTimersByTimeAsync(31);await rejected;expect(terminate).toHaveBeenCalledOnce();
  const retry=runtime.load(object),again=expect(retry).rejects.toThrow('released');await Promise.resolve();runtime.release();await again;expect(create).toHaveBeenCalledTimes(2);
});
