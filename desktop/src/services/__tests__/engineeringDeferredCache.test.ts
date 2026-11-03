// @vitest-environment node
import { afterEach,expect,it,vi } from 'vitest';
import { createEngineeringWorkerHandler } from '../engineeringWorker.js';
import { decodeEngineeringWorkerResult } from '../engineeringWorkerTransport.js';

async function fixture(){
  const handle=createEngineeringWorkerHandler(),identity={sourceSha256:'a'.repeat(64),parserVersion:'test',entries:['project.cbm','main.dev']};
  await handle({type:'init',scope:identity.sourceSha256,paths:[...identity.entries]});
  await handle({type:'files',files:[{path:'project.cbm',bytes:new TextEncoder().encode('OBJECTMODELPOINTER=main.dev')},{path:'main.dev',bytes:new TextEncoder().encode('SYMBOLNAME=主变压器')}]});
  await handle({type:'extract'});return {handle,identity};
}
afterEach(()=>{vi.unstubAllGlobals();});

it('publishes the full model with one display buffer before any cache compressor is available',async()=>{
  const {handle,identity}=await fixture();vi.stubGlobal('CompressionStream',class{constructor(){throw Error('compressor unavailable');}});
  const reply=await handle({type:'assemble',objects:[],models:[],identity});expect(reply.type).toBe('model');if(reply.type!=='model')return;
  expect(Object.keys(reply.result).sort()).toEqual(['body','encoding','metrics']);
  const result=await decodeEngineeringWorkerResult(reply.result,()=>true);
  expect(result.snapshot.entities).toHaveLength(1);expect(result.cachePlan).toEqual(['sources','entities','navigation']);
  const cache=await handle({type:'encode-cache',buildId:result.buildId!,domain:'sources'});
  expect(cache.type).toBe('cache');if(cache.type==='cache'){expect(cache.result.error).toContain('compressor unavailable');expect(cache.result.bytes).toBeUndefined();}
});

it('binds deferred cache requests to the latest build and requires source-first domain order',async()=>{
  const {handle,identity}=await fixture();
  const assemble=async()=>{const reply=await handle({type:'assemble',objects:[],models:[],identity});if(reply.type!=='model')throw Error('model expected');return decodeEngineeringWorkerResult(reply.result,()=>true);};
  const first=await assemble(),latest=await assemble();
  await expect(handle({type:'encode-cache',buildId:first.buildId!,domain:'sources'})).rejects.toThrow('身份');
  await expect(handle({type:'encode-cache',buildId:latest.buildId!,domain:'entities'})).rejects.toThrow('顺序');
  for(const domain of ['sources','entities','navigation'] as const){
    const reply=await handle({type:'encode-cache',buildId:latest.buildId!,domain});if(reply.type!=='cache')throw Error('cache expected');
    expect(reply.result.error).toBeUndefined();expect(reply.result.metrics.plainBytes).toBeGreaterThan(0);
    const original=reply.result.bytes!;structuredClone(original,{transfer:[original.buffer]});expect(original.byteLength).toBe(0);
  }
});

it('decodes a GBK DeviceName-only family before classification without rewriting source bytes',async()=>{
  const handle=createEngineeringWorkerHandler(),scope='a'.repeat(64),family=new Uint8Array([...new TextEncoder().encode('[Device]\nDeviceName='),0xb6,0xcb,0xd7,0xd3,0xcf,0xe4]);
  const original=family.slice(),paths=['project.cbm','main.dev','family.fam'];
  await handle({type:'init',scope,paths});
  await handle({type:'files',files:[{path:paths[0],bytes:new TextEncoder().encode('OBJECTMODELPOINTER=main.dev')},{path:paths[1],bytes:new TextEncoder().encode('TYPE=OTHERS\nBASEFAMILY=family.fam')},{path:paths[2],bytes:family}]});
  await handle({type:'extract'});const reply=await handle({type:'assemble',objects:[],models:[]});if(reply.type!=='model')throw Error('Model expected');
  const result=await decodeEngineeringWorkerResult(reply.result,()=>true);
  expect(result.sources.graph.records[0].name).toBe('端子箱');expect(result.snapshot.entities[0].category).toBe('E16.terminal_box');
  expect(family).toEqual(original);
});
