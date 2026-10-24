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
    GetVertexArray: () => vertices, GetIndexArray: () => indices,
  };
  return {api,vertices,stream,release};
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
