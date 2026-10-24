// @vitest-environment node
import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { CONNECTION_GEOMETRY_VERSION, streamConnectionGeometry, validConnectionArtifact,
  type ConnectionGeometryBatch } from '../ifcConnectionBatches.js';
import { streamEarlyConnection } from '../ifcEarlyConnection.js';
import { omitIndexedOpenings } from '../../gim/ifcConnectionSubset.js';
import { omitIfcOpeningRelations } from '../ifcOpeningPolicy.js';
import { readConnectionEndpointEvidence } from '../ifcConnectionEndpoints.js';

const source = resolve('../demo/demo-substation/DEV/一次设备0402其他.ifc');
// Explicit fixture identity only. Production classification never uses this filename.
it.skipIf(!existsSync(source))('substation01 source mesh chunks retain geometry and normalized/un-normalized coordinates', async () => {
  const bytes = readFileSync(source);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('1f4c0c5f093f524a3b2056d776928f4b80462800ce7d95264e79652366a21673');
  const { IfcAPI } = createRequire(import.meta.url)('web-ifc');
  const positions: number[][] = [], identities: string[][] = [];
  for (const normalized of [false, true]) {
    const api = new IfcAPI();
    api.SetWasmPath(resolve('node_modules/web-ifc') + '/', true);
    await api.Init();
    try {
      const model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: normalized });
      const batches: ConnectionGeometryBatch[] = [], points: number[] = [], ids = new Set<string>();
      const point = new THREE.Vector3();
      const complete = await streamConnectionGeometry(api, model, normalized, async batch => {
        batches.push(batch);
        for (const chunk of batch.chunks ?? []) {
          ids.add(chunk.object.globalId);
          const matrix = new THREE.Matrix4().fromArray(chunk.matrix);
          for (let i = 0; i < chunk.vertices.length; i += 6) {
            point.set(chunk.vertices[i], chunk.vertices[i+1], chunk.vertices[i+2]).applyMatrix4(matrix);
            points.push(...point.toArray());
          }
        }
      });
      expect(complete.failedObjects).toEqual([]);
      expect(complete.objectCount).toBe(299);
      expect(batches.length).toBeLessThan(50);
      console.log(JSON.stringify({normalized,objects:complete.objectCount,batches:batches.length,
        chunks:batches.reduce((sum,batch)=>sum+(batch.chunks?.length??0),0)}));
      expect(validConnectionArtifact({ version: CONNECTION_GEOMETRY_VERSION, batches, complete })).toBe(true);
      expect(points.length / 3).toBe(965946);
      identities.push([...ids].sort()); positions.push(points);
    } finally { api.Dispose(); }
  }
  expect(identities[0]).toEqual(identities[1]);
  expect(positions[0].length).toBe(positions[1].length);
  let maxDelta = 0;
  for (let i = 0; i < positions[0].length; i++) maxDelta = Math.max(maxDelta, Math.abs(positions[0][i]-positions[1][i]));
  expect(maxDelta).toBeLessThan(1e-6);
}, 60000);

const fixtures = [
  {id:'substation01',path:'demo-substation/DEV/一次设备0402其他.ifc',sha:'1f4c0c5f093f524a3b2056d776928f4b80462800ce7d95264e79652366a21673',objects:299},
  {id:'substation02',path:'substation02/CBM/消防给排水.ifc',sha:'67dfe9a427d3fc994eb9c8c90b85014c046c316e9bd11a3e592f7c6efe0b26c7',objects:1090},
  {id:'substation03',path:'substation03/CBM/设备接线.ifc',sha:'c64fc8cb5f764651277b3bf9fa14c67d88be4192e1dd3324497c6888baca5658',objects:272},
  {id:'substation04',path:'substation04/DEV/室内电缆沟施工图-版本1.ifc',sha:'b95547c97f370587ec7488aaf1dd8b4dd847cd0c0fb182856c0156aac9fb69a0',objects:324},
];
for (const fixture of fixtures) it.skipIf(!existsSync(resolve('../demo',fixture.path)))(
  `${fixture.id} full/early streams retain exact vertices and source identity, normalized placement and color`,async()=>{
    const source=readFileSync(resolve('../demo',fixture.path));
    expect(createHash('sha256').update(source).digest('hex')).toBe(fixture.sha);
    const {IfcAPI}=createRequire(import.meta.url)('web-ifc');
    const results=[];
    for(const accelerated of [false,true]){
      const bytes=new Uint8Array(source),api=new IfcAPI();api.SetWasmPath(resolve('node_modules/web-ifc')+'/',true);await api.Init();
      try{
        const objects=new Map<number,{guid:string;hash:ReturnType<typeof createHash>;vertices:number;bounds:THREE.Box3}>();
        const parts=new Map<string,{matrix:number[];color:number[]}>(),chunks=new Set<string>(),completed=new Set<number>();
        let sequence=0,final=false,first:number|undefined,totalBytes=0;
        const began=performance.now(),point=new THREE.Vector3();
        const emit=async(batch:ConnectionGeometryBatch)=>{
          expect(batch.sequence).toBe(sequence++);expect(final).toBe(false);final=batch.final;
          totalBytes+=batch.bytes;
          for(const chunk of batch.chunks??[]){
            const key=`${chunk.object.expressId}:${chunk.part}:${chunk.chunk}`;
            if(chunks.has(key))throw Error('Duplicate connection chunk');chunks.add(key);
            let row=objects.get(chunk.object.expressId);
            if(!row){row={guid:chunk.object.globalId,hash:createHash('sha256'),vertices:0,bounds:new THREE.Box3()};objects.set(chunk.object.expressId,row);}
            if(chunk.objectComplete)completed.add(chunk.object.expressId);
            if(!chunk.vertices.length)continue;
            first??=performance.now()-began;
            row.hash.update(Buffer.from(chunk.vertices.buffer,chunk.vertices.byteOffset,chunk.vertices.byteLength));
            row.vertices+=chunk.vertices.length/6;
            parts.set(`${chunk.object.expressId}:${chunk.part}`,{matrix:chunk.matrix,color:chunk.color});
            const matrix=new THREE.Matrix4().fromArray(chunk.matrix);
            for(let i=0;i<chunk.vertices.length;i+=6)row.bounds.expandByPoint(point.set(chunk.vertices[i],chunk.vertices[i+1],chunk.vertices[i+2]).applyMatrix4(matrix));
          }
        };
        const settings={COORDINATE_TO_ORIGIN:accelerated};
        const early=accelerated?await streamEarlyConnection(async()=>{const prefixApi=new IfcAPI();prefixApi.SetWasmPath(resolve('node_modules/web-ifc')+'/',true);await prefixApi.Init();return prefixApi;},bytes,settings,emit):undefined;
        if(early?.openings)omitIndexedOpenings(bytes,early.openings);else omitIfcOpeningRelations(bytes);
        const model=api.OpenModel(bytes,settings);
        expect(model).toBe(0); // The private API must not consume the importer owner model ID.
        const endpoints=readConnectionEndpointEvidence(api,model);
        if(fixture.id==='substation03')expect([...endpoints.values()].filter(rows=>rows.length)).toHaveLength(202);
        if(fixture.id==='substation01')expect([...endpoints.values()].flat().some(row=>row.kind==='ifc-element')).toBe(true);
        const complete=await streamConnectionGeometry(api,model,accelerated,emit,
          {...(early?{skipIds:early.skipIds,startSequence:early.sequence,initialObjectCount:early.objectCount}:{}),connectionEndpoints:endpoints});
        expect(complete.failedObjects).toEqual([]);expect(complete.objectCount).toBe(fixture.objects);
        expect(final).toBe(true);expect(completed.size).toBe(fixture.objects);expect(sequence).toBe(complete.sequence);
        const rows=[...objects].map(([id,row])=>({id,guid:row.guid,vertices:row.vertices,hash:row.hash.digest('hex'),bounds:[...row.bounds.min.toArray(),...row.bounds.max.toArray()]}));
        results.push({rows,parts});
        console.log(JSON.stringify({sample:fixture.id,accelerated,firstMs:first,completeMs:performance.now()-began,objects:objects.size,totalBytes,early:early?.profile}));
        if(fixture.id==='substation03'&&accelerated){
          const {IfcImporter}=await import('@thatopen/fragments');
          const {withSharedIfcImport}=await import('../ifcSharedImport.js');
          const {installWebIfcStreamCompatibility}=await import('../webIfcCompatibility.js');
          installWebIfcStreamCompatibility();
          const importer=new IfcImporter();importer.wasm={path:resolve('node_modules/web-ifc')+'/',absolute:true};importer.webIfcSettings=settings;
          let observed=0;
          const fragments=await withSharedIfcImport(api,model,bytes,settings,()=>{observed++;},()=>importer.process({bytes}));
          expect(fragments.byteLength).toBeGreaterThan(0);expect(observed).toBeGreaterThanOrEqual(fixture.objects);
        }
      }finally{api.Dispose();}
    }
    const [control,candidate]=results;
    expect(candidate.rows.map(({bounds,...row})=>row)).toEqual(control.rows.map(({bounds,...row})=>row));
    let maxDelta=0;
    for(let i=0;i<control.rows.length;i++)for(let j=0;j<6;j++)maxDelta=Math.max(maxDelta,Math.abs(control.rows[i].bounds[j]-candidate.rows[i].bounds[j]));
    expect(maxDelta).toBeLessThan(1e-6);
    expect([...candidate.parts.keys()]).toEqual([...control.parts.keys()]);
    for(const [key,value]of control.parts){const actual=candidate.parts.get(key)!;expect(actual.color).toEqual(value.color);
      expect(Math.max(...actual.matrix.map((v,i)=>Math.abs(v-value.matrix[i])))).toBeLessThan(1e-9);}
  },180000);
