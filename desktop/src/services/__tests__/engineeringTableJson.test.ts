// @vitest-environment node
import {expect,it} from 'vitest';
import {packEngineeringSource,unpackEngineeringSource,unpackEngineeringSourceAsync} from '../engineeringSourceCodec.js';
import {engineeringTableChunks,parseEngineeringTable,releaseEngineeringBytes,stringifyEngineeringTable} from '../engineeringTableJson.js';

it('keeps the exact canonical bytes and shared references across bounded UTF-8 batches',async()=>{
  const shared={name:'中文😀 \\ " ],"nodes":[ and \n',value:null};
  const value={rows:Array.from({length:10000},(_,i)=>({i,name:`构件${i}`,shared})),shared};
  const table=packEngineeringSource(value),expected=new TextEncoder().encode(JSON.stringify(table));let writes=0,reads=0;
  const bytes=await stringifyEngineeringTable(table,64*1024*1024,()=>true,async()=>{writes++;});
  expect(bytes).toEqual(expected);expect(writes).toBeGreaterThan(0);
  const parsed=await parseEngineeringTable(bytes,()=>true,async()=>{reads++;});
  expect(parsed).toEqual(table);expect(reads).toBeGreaterThan(0);
  const restored=unpackEngineeringSource(parsed) as typeof value;
  expect(restored).toEqual(value);expect(restored.rows[0].shared).toBe(restored.shared);
});
it('round trips empty collections, scalars, escape sequences and unpaired surrogates',async()=>{
  for(const value of [null,false,0,{},[],{empty:[],text:'\ud800😀\n\r\t\\\\"'}]){
    const table=packEngineeringSource(value),bytes=await stringifyEngineeringTable(table,10000);
    expect(unpackEngineeringSource(await parseEngineeringTable(bytes))).toEqual(value);
  }
});
it('preserves the exact navigation dependency digest input without one model-sized string',async()=>{
  const table=packEngineeringSource({rows:Array.from({length:10000},(_,i)=>({i,text:'中文'+i}))}),sourceDigest='sha-source';
  const bytes=await stringifyEngineeringTable(table,16*1024*1024,undefined,undefined,{prefix:'['+JSON.stringify(sourceDigest)+',',suffix:']'});
  expect(bytes).toEqual(new TextEncoder().encode(JSON.stringify([sourceDigest,table])));
});
it('releases consumed intermediate rows while preserving shared decoded facts',async()=>{
  const shared={value:'shared'},input={a:shared,b:shared},table=packEngineeringSource(input);
  const result=await unpackEngineeringSourceAsync(table,()=>true,async()=>{},true) as typeof input;
  expect(result).toEqual(input);expect(result.a).toBe(result.b);expect(table.nodes.every(row=>row===null)).toBe(true);
});
it('streams the exact bytes while releasing owned encoded rows and enforcing the total budget',async()=>{
  const table=packEngineeringSource(Array.from({length:12000},(_,i)=>({i,text:'属性'+i}))),expected=new TextEncoder().encode(JSON.stringify(table));
  const chunks:Uint8Array[]=[];
  for await(const chunk of engineeringTableChunks(table,expected.length,undefined,async()=>{},undefined,true))chunks.push(chunk);
  expect(table.nodes.every(row=>row===null)).toBe(true);
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(expected));
  await expect((async()=>{for await(const _chunk of engineeringTableChunks(packEngineeringSource('预算'),1)){} })()).rejects.toThrow('plain size');
});
it('releases only full owned buffers and keeps borrowed views and legacy allocations valid',()=>{
  const owned=new Uint8Array([1,2,3]),buffer=owned.buffer;
  releaseEngineeringBytes(owned);expect(buffer.byteLength).toBe(0);
  const shared=new Uint8Array([4,5,6]);releaseEngineeringBytes(shared.subarray(1));expect([...shared]).toEqual([4,5,6]);
  const legacy=new Uint8Array([7,8]);Object.defineProperty(legacy.buffer,'transfer',{value:undefined});
  releaseEngineeringBytes(legacy);expect([...legacy]).toEqual([7,8]);
});
it('rejects byte-budget overflow, malformed tails and an obsolete session without publishing a partial table',async()=>{
  const table=packEngineeringSource(Array.from({length:5000},(_,i)=>({i})));let current=true;
  await expect(stringifyEngineeringTable(table,20)).rejects.toThrow('容量');
  await expect(stringifyEngineeringTable(table,1024*1024,()=>current,async()=>{current=false;})).rejects.toMatchObject({name:'AbortError'});
  const valid=new TextEncoder().encode(JSON.stringify(table));current=true;
  await expect(parseEngineeringTable(valid,()=>current,async()=>{current=false;})).rejects.toMatchObject({name:'AbortError'});
  for(const text of ['{}','{"encoding":"engineering-source-table-v1","shapes":[],"nodes":[[0],],"root":0}',
    '{"encoding":"engineering-source-table-v1","shapes":[],"nodes":[[0]],"root":0,"extra":true}',
    '{"encoding":"engineering-source-table-v1","shapes":[],"nodes":[[0]],"root":9}'])
    await expect(parseEngineeringTable(new TextEncoder().encode(text))).rejects.toThrow();
});
