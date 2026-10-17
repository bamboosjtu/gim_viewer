import {expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({invoke:vi.fn(),parse:vi.fn()}));
vi.mock('../runtime.js',()=>({isTauri:()=>true}));
vi.mock('../invokeTimed.js',()=>({invokeTimed:mock.invoke}));
vi.mock('../database.js',()=>({parseBatchCachePayload:mock.parse,packBinaryCacheWrite:vi.fn()}));
import {readDevArtifactBatch,packDevArtifact} from '../devLodCache.js';
it('passes the byte ceiling and keeps deferred entries distinct from missing or corrupt artifacts',async()=>{
  mock.invoke.mockResolvedValue(new ArrayBuffer(0));mock.parse.mockReturnValue({items:[
    {entry_path:'templates/a',bytes:packDevArtifact('a',{sha:'ok'})},
    {entry_path:'templates/b',bytes:null},{entry_path:'templates/bad',bytes:new Uint8Array([1])},
  ]});
  const rows=await readDevArtifactBatch('templates',['a','b','c','bad'],{projectId:1,sourceSha256:'source'},128);
  expect(rows.get('a')).toEqual({sha:'ok'});expect(rows.get('b')).toBeNull();expect(rows.get('bad')).toBeNull();expect(rows.has('c')).toBe(false);
  expect(mock.invoke).toHaveBeenCalledWith('read_device_lod_artifacts',expect.objectContaining({maxBytes:128,entryPaths:['templates/a','templates/b','templates/c','templates/bad']}));
});
