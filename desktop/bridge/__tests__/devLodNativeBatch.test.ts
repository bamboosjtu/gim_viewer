import {expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('../runtime.js',()=>({isTauri:()=>true}));
vi.mock('../invokeTimed.js',()=>({invokeTimed:mocks.invoke}));
import {packDevArtifact,readDevArtifact} from '../devLodCache.js';
function envelope(paths:string[],corrupt=false):ArrayBuffer {
  const chunks=paths.map(entry=>({path:new TextEncoder().encode(entry),bytes:packDevArtifact(corrupt && entry.endsWith('broken') ? 'wrong' : entry.slice(entry.indexOf('/')+1),{value:entry})}));
  const out=new Uint8Array(9+chunks.reduce((sum,row)=>sum+4+row.path.length+1+8+row.bytes.length,0));
  out.set(new TextEncoder().encode('GIMR'));out[4]=1;const view=new DataView(out.buffer);view.setUint32(5,chunks.length,true);let offset=9;
  for(const row of chunks){view.setUint32(offset,row.path.length,true);offset+=4;out.set(row.path,offset);offset+=row.path.length;out[offset++]=1;view.setBigUint64(offset,BigInt(row.bytes.length),true);offset+=8;out.set(row.bytes,offset);offset+=row.bytes.length;}
  return out.buffer;
}
it('coalesces native reads in bounded batches, retaining identities and isolating a corrupt row',async()=>{
  mocks.invoke.mockImplementation(async (_command:string,args:{entryPaths:string[]})=>envelope(args.entryPaths,true));
  const context={projectId:1,sourceSha256:'a'.repeat(64)};
  const keys=Array.from({length:20},(_,i)=>i===19?'broken':`key-${i}`);
  const results=await Promise.all(keys.map(key=>readDevArtifact<any>('catalog',key,context)));
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(mocks.invoke.mock.calls.map(call=>call[1].entryPaths.length)).toEqual([16,4]);
  expect(results[0].value).toBe('catalog/key-0');expect(results[19]).toBeNull();
  expect(mocks.invoke.mock.calls[0][1].sourceGimSha256).toBe(context.sourceSha256);
});
