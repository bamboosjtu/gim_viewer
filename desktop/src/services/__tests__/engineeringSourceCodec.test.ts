// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { packEngineeringSource, unpackEngineeringSourceAsync } from '../engineeringSourceCodec.js';
const unpack=(value:unknown)=>unpackEngineeringSourceAsync(value,()=>true);
describe('lossless source table encoding', () => {
  it('deduplicates repeated family facts while preserving every distinct occurrence and raw physical line', async () => {
    const rawLine = '材质=Material=钢材、镀锌；原始说明'.repeat(30);
    const sources = Array.from({ length: 2000 }, (_, i) => ({ id: `occurrence:${i}`, properties: [{ path: 'family.fam', line: 17, keys: ['材质', 'Material'], value: '钢材', rawLine }] }));
    const packed = packEngineeringSource(sources), text = JSON.stringify(packed);
    expect(text.length).toBeLessThan(JSON.stringify(sources).length / 10);
    const restored = await unpack(JSON.parse(text));
    expect(restored).toEqual(sources);
    expect(new Set((restored as typeof sources).map(source => source.id)).size).toBe(2000);
  });
  it('preserves source scalar types and nullable fields', async () => {
    const data = { text: '0', zero: 0, no: false, yes: true, missing: null, rows: [['', 17, true, null]] };
    expect(await unpack(packEngineeringSource(data))).toEqual(data);
  });
  it('preserves own prototype-like field names in small and wide records without changing decoded prototypes',async()=>{
    for(const fields of [0,40]){
    const input=JSON.parse('{"__proto__":{"source":"raw"},"constructor":"field","prototype":true,"rows":[1,2,3]}');
    for(let index=0;index<fields;index++)input['field'+index]=index;
    const result=await unpack(packEngineeringSource(input)) as Record<string,unknown>;
    expect(result).toEqual(input);expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result,'__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result,'__proto__')).toMatchObject({enumerable:true,writable:true,configurable:true});
    expect(({} as Record<string,unknown>).source).toBeUndefined();
    }
  });
  it('rejects cyclic input and forward or malformed table references', async () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => packEngineeringSource(cyclic)).toThrow('Cyclic');
    await expect(unpack({ encoding: 'engineering-source-table-v1', shapes: [], nodes: [[4, 0]], root: 0 })).rejects.toThrow('编码无效');
    await expect(unpack({ encoding: 'engineering-source-table-v1', shapes: [['key']], nodes: [[5, 0]], root: 0 })).rejects.toThrow('编码无效');
  });
  it('keeps records independent when a shape workspace is reused across object and scalar rows',async()=>{
    const rows=Array.from({length:300},(_,i)=>Object.fromEntries(Array.from({length:32},(_,field)=>['field'+field,{value:i*100+field}])));
    const result=await unpack(packEngineeringSource(rows)) as typeof rows;
    expect(result).toEqual(rows);expect(result[0]).not.toBe(result[1]);
    expect(result[0].field0).not.toBe(result[1].field0);
    result[1].field0.value=-1;expect(result[0].field0.value).toBe(0);
  });
  it('hydrates shared facts in bounded batches and cancels before returning an obsolete graph', async () => {
    const facts = Array.from({ length: 10000 }, (_, i) => ({ id: `occurrence:${i}`, values: ['共享原始字段', i] }));
    const table = packEngineeringSource(facts); let yields = 0;
    expect(await unpackEngineeringSourceAsync(table, () => true, async () => { yields++; })).toEqual(facts);
    expect(yields).toBeGreaterThan(0);
    let current = true;
    await expect(unpackEngineeringSourceAsync(table, () => current, async () => { current = false; })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
