// @vitest-environment node
import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CONNECTION_GEOMETRY_VERSION, IFC_CONNECTION_BATCH_MAX_BYTES,
  streamConnectionGeometry, validConnectionArtifact, type ConnectionGeometryBatch } from '../ifcConnectionBatches.js';

function source(triangles = 1) {
  const release = vi.fn(), stream = vi.fn();
  const vertices = new Float32Array([0,0,0,0,0,1, 3,0,0,0,0,1, 3,4,0,0,0,1]);
  const indices = new Uint32Array(triangles * 3).map((_v,i)=>i % 3);
  const api: any = {
    GetTypeCodeFromName: (type: string) => type === 'IFCBUILDINGELEMENTPROXY' ? 1 : 0,
    GetLineIDsWithType: () => ({size:()=>2,get:(i:number)=>i+7,delete:release}),
    GetLine: (_m:number,id:number) => ({type:1,GlobalId:{value:`g${id}`},Name:{value:id===7?'软导体':'ordinary building'}}),
    GetNameFromTypeCode: () => 'IFCBUILDINGELEMENTPROXY',
    GetFlatMesh: stream.mockImplementation(() => ({geometries:{size:()=>1,get:()=>({geometryExpressID:12,
      flatTransformation:new THREE.Matrix4().makeTranslation(12,0,0).toArray(),color:{x:0.2,y:0.3,z:0.4,w:1}})},delete:release})),
    GetCoordinationMatrix: () => new THREE.Matrix4().makeTranslation(10,0,0).toArray(),
    GetGeometry: () => ({GetVertexData:()=>1,GetVertexDataSize:()=>vertices.length,GetIndexData:()=>2,GetIndexDataSize:()=>indices.length,delete:release}),
    GetVertexArray: (ptr:number,size:number) => vertices.slice((ptr-1)/4,(ptr-1)/4+size),
    GetIndexArray: (ptr:number,size:number) => indices.slice((ptr-2)/4,(ptr-2)/4+size),
  };
  return {api,vertices,indices,stream,release};
}
it('streams only evidence-backed connections, copies source triangles and restores the normalized placement once', async () => {
  const {api,vertices,stream}=source();const batches:ConnectionGeometryBatch[]=[];
  const complete=await streamConnectionGeometry(api,0,true,async batch=>{
    batches.push(structuredClone(batch,{transfer:(batch.chunks??[]).map(chunk=>chunk.vertices.buffer)}));
  });
  expect(stream).toHaveBeenCalledTimes(1);
  expect(batches[0].chunks![0].vertices).toEqual(vertices);
  expect(batches[0].chunks![0].matrix[12]).toBe(2);
  expect(batches[0].chunks![0].color).toEqual([0.2,0.3,0.4,1]);
  expect(complete.objectCount).toBe(1);
  expect(validConnectionArtifact({version:CONNECTION_GEOMETRY_VERSION,batches,complete})).toBe(true);
  expect(validConnectionArtifact({version:CONNECTION_GEOMETRY_VERSION,batches:batches.slice(0,-1),complete})).toBe(false);
});
it('splits one large source object and waits for consumption before sending more geometry', async () => {
  const {api}=source(10000);const batches:ConnectionGeometryBatch[]=[];
  let consume!:()=>void;
  const pending=streamConnectionGeometry(api,0,false,async batch=>{
    batches.push(batch);
    if(batches.length===1)await new Promise<void>(resolve=>{consume=resolve;});
  });
  await Promise.resolve();expect(batches).toHaveLength(1);
  consume();const complete=await pending;
  expect(batches).toHaveLength(3); // first chunk, coalesced remainder, final receipt
  expect(batches.flatMap(batch=>batch.chunks??[]).filter(chunk=>chunk.vertices.length)).toHaveLength(4);
  expect(batches.every(batch=>batch.bytes<=IFC_CONNECTION_BATCH_MAX_BYTES)).toBe(true);
  expect(validConnectionArtifact({version:CONNECTION_GEOMETRY_VERSION,batches,complete})).toBe(true);
  const corrupt=structuredClone(batches);corrupt[0].bytes--;
  expect(validConnectionArtifact({version:CONNECTION_GEOMETRY_VERSION,batches:corrupt,complete})).toBe(false);
});
it('copies only each chunk\'s referenced range across transfer and WASM heap replacement',async()=>{
  const {api,vertices,indices}=source(10000),expected=Array.from(vertices);
  let sourceMemory=new Float32Array(100000),indexMemory=indices.slice();sourceMemory.set(vertices);
  api.GetGeometry=()=>({GetVertexData:()=>1,GetVertexDataSize:()=>100000,GetIndexData:()=>2,GetIndexDataSize:()=>30000,delete:vi.fn()});
  api.GetVertexArray=vi.fn((ptr:number,size:number)=>sourceMemory.slice((ptr-1)/4,(ptr-1)/4+size));
  api.GetIndexArray=vi.fn((ptr:number,size:number)=>indexMemory.slice((ptr-2)/4,(ptr-2)/4+size));
  const batches:ConnectionGeometryBatch[]=[];
  const complete=await streamConnectionGeometry(api,0,false,async batch=>{
    batches.push(structuredClone(batch,{transfer:(batch.chunks??[]).map(c=>c.vertices.buffer)}));
    if(batches.length===1){
      const old=[sourceMemory.buffer,indexMemory.buffer];
      sourceMemory=sourceMemory.slice();indexMemory=indexMemory.slice();
      structuredClone(old,{transfer:old});
    }
  });
  expect(api.GetVertexArray).toHaveBeenCalledTimes(4);expect(api.GetIndexArray).toHaveBeenCalledTimes(4);
  expect(api.GetVertexArray.mock.calls.map((call:number[])=>call[1])).toEqual([18,18,18,18]);
  expect(api.GetIndexArray.mock.calls.reduce((sum:number,call:number[])=>sum+call[1],0)).toBe(30000);
  const chunks=batches.flatMap(b=>b.chunks??[]).filter(c=>c.vertices.length);
  expect(chunks).toHaveLength(4);
  expect(chunks.reduce((n,c)=>n+c.vertices.length,0)).toBe(10000*18);
  for(const chunk of chunks)expect(chunk.vertices).toEqual(Float32Array.from({length:chunk.vertices.length},(_v,i)=>expected[i%18]));
  expect(validConnectionArtifact({version:CONNECTION_GEOMETRY_VERSION,batches,complete})).toBe(true);
});
it.each([Infinity,-Infinity,NaN,Math.fround(3.4e38),-0])('preserves referenced Float32 validation and values (%s)',async value=>{
  const {api,vertices}=source();vertices[0]=value;
  const batches:ConnectionGeometryBatch[]=[];
  const complete=await streamConnectionGeometry(api,0,false,async b=>{batches.push(b);});
  if(Number.isFinite(value)){
    expect(complete.failedObjects).toEqual([]);
    expect(Object.is(batches[0].chunks![0].vertices[0],value)).toBe(true);
  }else{
    expect(complete.failedObjects).toEqual([7]);expect(batches.flatMap(b=>b.chunks??[])).toHaveLength(0);
  }
});
it('offsets byte pointers for unordered high vertex indices without inspecting unused invalid data',async()=>{
  const {api,vertices,indices}=source();indices.set([7,5,6]);
  const memory=new Float32Array(48).fill(NaN);memory.set(vertices,30);
  const geometry=api.GetGeometry();api.GetGeometry=()=>({...geometry,GetVertexDataSize:()=>memory.length});
  api.GetVertexArray=vi.fn((ptr:number,size:number)=>memory.slice((ptr-1)/4,(ptr-1)/4+size));
  const batches:ConnectionGeometryBatch[]=[];
  const complete=await streamConnectionGeometry(api,0,false,async b=>{batches.push(b);});
  expect(api.GetVertexArray).toHaveBeenCalledWith(121,18);
  expect(batches[0].chunks![0].vertices).toEqual(new Float32Array([...vertices.slice(12),...vertices.slice(0,12)]));
  expect(complete.failedObjects).toEqual([]);
});
it('coalesces many source objects while preserving object and byte ceilings and source identity',async()=>{
  const {api}=source();
  api.GetLineIDsWithType=()=>({size:()=>260,get:(i:number)=>i+7,delete:vi.fn()});
  api.GetLine=(_model:number,id:number)=>({type:1,GlobalId:{value:`g${id}`},Name:{value:'软导体'}});
  const batches:ConnectionGeometryBatch[]=[];
  const complete=await streamConnectionGeometry(api,0,false,async batch=>{
    batches.push(structuredClone(batch,{transfer:(batch.chunks??[]).map(chunk=>chunk.vertices.buffer)}));
  });
  expect(complete.objectCount).toBe(260);
  expect(batches.length).toBeLessThanOrEqual(5);
  expect(batches.every(batch=>batch.objects.length<=128 && batch.bytes<=IFC_CONNECTION_BATCH_MAX_BYTES)).toBe(true);
  expect(batches.some(batch=>batch.objects.length===128)).toBe(true);
  expect(new Set(batches.flatMap(batch=>batch.objects.map(object=>object.globalId))).size).toBe(260);
  expect(validConnectionArtifact({version:CONNECTION_GEOMETRY_VERSION,batches,complete})).toBe(true);
});
it('coalesces large meshes without exceeding the byte ceiling',async()=>{
  const {api}=source(100000);const batches:ConnectionGeometryBatch[]=[];
  const complete=await streamConnectionGeometry(api,0,false,async batch=>{batches.push(batch);});
  expect(batches.every(batch=>batch.bytes<=IFC_CONNECTION_BATCH_MAX_BYTES)).toBe(true);
  expect(batches.filter(batch=>!batch.final).length).toBeGreaterThan(2);
  expect(batches.length).toBeLessThan(10);
  expect(validConnectionArtifact({version:CONNECTION_GEOMETRY_VERSION,batches,complete})).toBe(true);
});
it('continues a validated early prefix with one contiguous receipt and no duplicate object geometry',async()=>{
  const {api}=source();api.GetLine=(_m:number,id:number)=>({type:1,GlobalId:{value:`g${id}`},Name:{value:'软导体'}});
  const batches:ConnectionGeometryBatch[]=[];
  const early=await streamConnectionGeometry(api,0,false,async batch=>{batches.push(batch);},{onlyIds:new Set([7])});
  batches.pop();
  const complete=await streamConnectionGeometry(api,0,false,async batch=>{batches.push(batch);},
    {skipIds:new Set([7]),startSequence:early.sequence-1,initialObjectCount:early.objectCount});
  expect(complete.objectCount).toBe(2);
  expect(batches.flatMap(b=>b.chunks??[]).filter(c=>c.vertices.length).map(c=>c.object.expressId)).toEqual([7,8]);
  expect(validConnectionArtifact({version:CONNECTION_GEOMETRY_VERSION,batches,complete})).toBe(true);
});
it('isolates a failed source object and refuses a complete cache receipt while other source work continues', async () => {
  const {api}=source();
  api.GetFlatMesh=()=>{throw Error('bad source geometry');};
  const batches:ConnectionGeometryBatch[]=[];
  const complete=await streamConnectionGeometry(api,0,false,async batch=>{batches.push(batch);});
  expect(complete.failedObjects).toEqual([7]);
  expect(complete.objectCount).toBe(-1);
  expect(batches[batches.length-1].final).toBe(true);
  expect(validConnectionArtifact({version:CONNECTION_GEOMETRY_VERSION,batches,complete})).toBe(false);
});
