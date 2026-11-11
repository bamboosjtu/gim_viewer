// @vitest-environment node
import{it,expect,vi}from'vitest';
import{EngineeringSourceBatches}from'../engineeringSourceBatches.js';
import{ENGINEERING_SOURCE_BATCH_BYTES}from'../engineeringWorkerProtocol.js';
import{createEngineeringWorkerHandler}from'../engineeringWorker.js';
import{decodeEngineeringWorkerResult}from'../engineeringWorkerTransport.js';

it('reads a carrier once, preserves byte boundaries and decodes each encoding independently',async()=>{
 const utf8=new TextEncoder().encode('\uFEFFNAME=匿名设备'),gbk=new Uint8Array([0xd6,0xd0,0xce,0xc4]);
 const blob=new Blob([utf8,gbk]),read=vi.spyOn(blob,'arrayBuffer'),sources=new EngineeringSourceBatches();
 sources.add({blob,entries:[{path:'a.dev',offset:0,length:utf8.length},{path:'b.fam',offset:utf8.length,length:gbk.length},{path:'empty.cbm',offset:blob.size,length:0}]});
 expect(await sources.read('b.fam')).toBe('中文');expect(await sources.read('a.dev')).toContain('NAME=匿名设备');expect(await sources.read('empty.cbm')).toBe('');
 expect(read).toHaveBeenCalledTimes(1);expect(sources.has('a.dev')).toBe(false);await expect(sources.read('a.dev')).rejects.toThrow('unavailable');
});
it('rejects gaps, overlap, duplicate paths and oversized carriers before accepting any path',()=>{
 const blob=new Blob(['abc']),sources=new EngineeringSourceBatches();
 for(const entries of [[{path:'a',offset:1,length:2}],[{path:'a',offset:0,length:1},{path:'a',offset:1,length:2}],[{path:'a',offset:0,length:4}],[{path:'a',offset:0,length:2}]]){
  expect(()=>sources.add({blob,entries})).toThrow();expect(sources.has('a')).toBe(false);
 }
 expect(()=>sources.add({blob:new Blob([new Uint8Array(ENGINEERING_SOURCE_BATCH_BYTES+1)]),entries:[{path:'a',offset:0,length:ENGINEERING_SOURCE_BATCH_BYTES+1}]})).toThrow('bounds');
});
it('does not reread failed carriers and releases registered sources on clear',async()=>{
 const blob=new Blob(['x']),read=vi.spyOn(blob,'arrayBuffer').mockRejectedValue(Error('read failed')),sources=new EngineeringSourceBatches();
 sources.add({blob,entries:[{path:'a',offset:0,length:1}]});
 await expect(sources.read('a')).rejects.toThrow('read failed');await expect(sources.read('a')).rejects.toThrow('read failed');expect(read).toHaveBeenCalledOnce();
 sources.clear();expect(sources.has('a')).toBe(false);
});
it('keeps packed extraction identical across shared references and discards prior-run packs on init',async()=>{
 const source=[['project.cbm','OBJECTMODELPOINTER=unit.dev'],['unit.dev','SYMBOLNAME=设备\nSUBDEVICE0=part.dev\nSUBDEVICE1=part.dev'],['part.dev','SYMBOLNAME=附件']];
 const parts=source.map(([,text])=>new TextEncoder().encode(text)),entries=source.map(([path],i)=>({path,offset:parts.slice(0,i).reduce((n,p)=>n+p.length,0),length:parts[i].length}));
 const packed=createEngineeringWorkerHandler(),legacy=createEngineeringWorkerHandler();
 for(const handler of [packed,legacy])await handler({type:'init',scope:'same',paths:source.map(([path])=>path)});
 await packed({type:'packed-files',batch:{blob:new Blob(parts),entries}});await legacy({type:'files',files:source.map(([path,text])=>({path,blob:new Blob([text])}))});
 expect(await packed({type:'extract'})).toEqual(await legacy({type:'extract'}));
 const results=await Promise.all([packed,legacy].map(async handler=>{
  const reply=await handler({type:'assemble',objects:[],models:[]});if(reply.type!=='model')throw Error('model expected');
  const result=await decodeEngineeringWorkerResult(reply.result,()=>true);return{sources:result.sources,snapshot:result.snapshot,navigation:result.navigation,geometryOccurrences:result.geometryOccurrences};
 }));expect(results[0]).toEqual(results[1]);
 await packed({type:'init',scope:'new',paths:['project.cbm']});await expect(packed({type:'extract'})).rejects.toThrow('unavailable');
});
