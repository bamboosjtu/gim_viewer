// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import * as THREE from 'three';
import {streamEarlyConnection} from '../ifcEarlyConnection.js';
const mocks=vi.hoisted(()=>({build:vi.fn()}));
vi.mock('../../gim/ifcConnectionSubset.js',()=>({buildEarlyConnectionInput:mocks.build}));
afterEach(()=>{vi.resetAllMocks();});
function setup(triangles=1){
 mocks.build.mockReturnValue({bytes:new Uint8Array([1]),expressId:7,indexedRecords:50,subsetRecords:12,indexBytes:524288,indexingMs:1,buildMs:0.1,openings:[]});
 const vertices=new Float32Array([0,0,0,0,0,1, 1,0,0,0,0,1, 0,1,0,0,0,1]);
 const indices=new Uint32Array(triangles*3).map((_v,i)=>i%3);
 return {OpenModel:vi.fn(()=>0),Dispose:vi.fn(),
  GetTypeCodeFromName:(type:string)=>type==='IFCBUILDINGELEMENTPROXY'?1:0,
  GetLineIDsWithType:()=>({size:()=>1,get:()=>7,delete:vi.fn()}),
  GetLine:()=>({type:1,GlobalId:{value:'g7'},Name:{value:'软导体'}}),GetNameFromTypeCode:()=> 'IFCBUILDINGELEMENTPROXY',
  GetFlatMesh:()=>({geometries:{size:()=>1,get:()=>({geometryExpressID:8,flatTransformation:new THREE.Matrix4().toArray(),color:{x:0.1,y:0.2,z:0.3,w:1}})},delete:vi.fn()}),
  GetGeometry:()=>({GetVertexData:()=>1,GetVertexDataSize:()=>vertices.length,GetIndexData:()=>2,GetIndexDataSize:()=>indices.length,delete:vi.fn()}),
  GetVertexArray:()=>vertices,GetIndexArray:()=>indices};
}
it('publishes a complete bounded first object without a premature whole-source receipt',async()=>{
 const api=setup(),batches:any[]=[];
 const result=await streamEarlyConnection(async()=>api as any,new Uint8Array([2]),{COORDINATE_TO_ORIGIN:true},async b=>{batches.push(b);});
 expect(api.OpenModel).toHaveBeenCalledWith(new Uint8Array([1]),{COORDINATE_TO_ORIGIN:false});
 expect(api.Dispose).toHaveBeenCalledOnce();
 expect(batches.every(b=>!b.final)).toBe(true);expect(result.skipIds).toEqual(new Set([7]));
 expect(result.sequence).toBe(batches.length);expect(result.objectCount).toBe(1);
});
it('keeps source consumers authoritative: callback errors propagate after subset cleanup',async()=>{
 const api=setup(),emit=vi.fn(async()=>{throw Error('cancelled scene consumer');});
 await expect(streamEarlyConnection(async()=>api as any,new Uint8Array([2]),{},emit)).rejects.toThrow('cancelled scene consumer');
 expect(api.Dispose).toHaveBeenCalledOnce();expect(emit).toHaveBeenCalledOnce();
});
it('falls back without publishing partial geometry when the optional subset exceeds its mesh budget',async()=>{
 const api=setup(100000),emit=vi.fn();
 const result=await streamEarlyConnection(async()=>api as any,new Uint8Array([2]),{},emit);
 expect(result.objectCount).toBe(0);expect(result.skipIds.size).toBe(0);expect(result.sequence).toBe(0);
 expect(result.fallback).toBeTruthy();expect(emit).not.toHaveBeenCalled();expect(api.Dispose).toHaveBeenCalledOnce();
});
it('does not open a subset for ineligible/unsupported input, leaving full-source evaluation available',async()=>{
 const api=setup(),emit=vi.fn(),create=vi.fn(async()=>api as any);mocks.build.mockReturnValue(null);
 expect((await streamEarlyConnection(create,new Uint8Array([2]),{},emit)).objectCount).toBe(0);
 mocks.build.mockImplementation(()=>{throw Error('missing reference');});
 const result=await streamEarlyConnection(async()=>api as any,new Uint8Array([2]),{},emit);
 expect(result.fallback).toContain('missing reference');expect(api.OpenModel).not.toHaveBeenCalled();expect(emit).not.toHaveBeenCalled();
 expect(create).not.toHaveBeenCalled();expect(api.Dispose).not.toHaveBeenCalled();
});
