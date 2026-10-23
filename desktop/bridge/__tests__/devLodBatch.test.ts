import {expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({invoke:vi.fn(),parse:vi.fn()}));
vi.mock('../runtime.js',()=>({isTauri:()=>true}));
vi.mock('../invokeTimed.js',()=>({invokeTimed:mock.invoke}));
vi.mock('../database.js',()=>({parseBatchCachePayload:mock.parse,packBinaryCacheWrite:vi.fn()}));
import {readDevArtifactBatch,readDevArtifactResult,packDevArtifact} from '../devLodCache.js';
it('passes the byte ceiling and keeps deferred entries distinct from missing or corrupt artifacts',async()=>{
  mock.invoke.mockResolvedValue(new ArrayBuffer(0));mock.parse.mockReturnValue({items:[
    {entry_path:'templates/a',bytes:packDevArtifact('a',{sha:'ok'})},
    {entry_path:'templates/b',bytes:null},{entry_path:'templates/bad',bytes:new Uint8Array([1])},
  ]});
  const rows=await readDevArtifactBatch('templates',['a','b','c','bad'],{projectId:1,sourceSha256:'source'},128);
  expect(rows.get('a')).toMatchObject({status:'hit',value:{sha:'ok'}});expect(rows.get('b')).toMatchObject({status:'miss'});expect(rows.get('bad')).toMatchObject({status:'invalid'});expect(rows.get('c')).toMatchObject({status:'deferred'});
  expect(mock.invoke).toHaveBeenCalledWith('read_device_lod_artifacts',expect.objectContaining({maxBytes:128,entryPaths:['templates/a','templates/b','templates/c','templates/bad']}));
});
it('keeps simultaneous catalog and template reads in their own native stores',async()=>{
  mock.invoke.mockReset();mock.parse.mockReset();
  mock.invoke.mockImplementation(async (_command,args)=>args);
  mock.parse.mockImplementation((args:{entryPaths:string[]})=>({items:args.entryPaths.map(entry=>({
    entry_path:entry,bytes:packDevArtifact(entry.slice(entry.indexOf('/')+1),{store:entry.split('/')[0]}),
  }))}));
  const context={projectId:1,sourceSha256:'source'};
  const [template,catalog]=await Promise.all([
    readDevArtifactResult('templates','shared-key',context),readDevArtifactResult('catalog','shared-key',context),
  ]);
  expect(template).toEqual({status:'hit',value:{store:'templates'}});
  expect(catalog).toEqual({status:'hit',value:{store:'catalog'}});
  expect(mock.invoke).toHaveBeenCalledTimes(2);
});

it('reads 64 cold entries in one native call without changing missing/deferred outcomes',async()=>{
  mock.invoke.mockReset();mock.parse.mockReset();
  mock.invoke.mockImplementation(async (_command,args)=>args);
  mock.parse.mockImplementation((args:{entryPaths:string[]})=>({items:args.entryPaths.map(entry_path=>({entry_path,bytes:null}))}));
  const keys=Array.from({length:64},(_,i)=>`cold-${i}`);
  const rows=await readDevArtifactBatch('templates',keys,{projectId:1,sourceSha256:'source'},128);
  expect(mock.invoke).toHaveBeenCalledTimes(1);
  expect(rows.size).toBe(64);expect([...rows.values()].every(row=>row.status==='miss')).toBe(true);
});

it('keeps one byte ceiling across failure splits and defers later rows after it is exhausted',async()=>{
  mock.invoke.mockReset();mock.parse.mockReset();
  const bytes=packDevArtifact('a',{sha:'ok'});
  mock.invoke.mockImplementation(async(_command,args)=>{if(args.entryPaths.length>1)throw Error('transport failure');return args;});
  mock.parse.mockImplementation((args:{entryPaths:string[]})=>({items:[{entry_path:args.entryPaths[0],bytes}]}));
  const rows=await readDevArtifactBatch('templates',['a','b'],{projectId:1,sourceSha256:'source'},bytes.byteLength);
  expect(rows.get('a')).toMatchObject({status:'hit'});expect(rows.get('b')).toEqual({status:'deferred'});
  expect(mock.invoke.mock.calls.map(call=>call[1].entryPaths)).toEqual([['templates/a','templates/b'],['templates/a']]);
});

it('subtracts already returned bytes from subsequent logical chunks',async()=>{
  mock.invoke.mockReset();mock.parse.mockReset();
  const bytes=packDevArtifact('a',{sha:'ok'});
  mock.invoke.mockImplementation(async(_command,args)=>args);
  mock.parse.mockImplementation((args:{entryPaths:string[]})=>({items:args.entryPaths.map(entry_path=>({entry_path,bytes:entry_path==='templates/a'?bytes:null}))}));
  const keys=['a',...Array.from({length:64},(_,i)=>`cold-${i}`)];
  const rows=await readDevArtifactBatch('templates',keys,{projectId:1,sourceSha256:'source'},bytes.byteLength+10);
  expect(mock.invoke.mock.calls.map(call=>call[1].maxBytes)).toEqual([bytes.byteLength+10,10]);
  expect(rows.get('a')).toMatchObject({status:'hit'});expect(rows.get('cold-63')).toEqual({status:'miss'});
});
