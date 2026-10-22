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
