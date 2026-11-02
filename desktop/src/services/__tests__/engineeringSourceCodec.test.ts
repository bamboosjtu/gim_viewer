// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { packEngineeringSource, unpackEngineeringSource, unpackEngineeringSourceAsync } from '../engineeringSourceCodec.js';
describe('lossless source table encoding', () => {
  it('deduplicates repeated family facts while preserving every distinct occurrence and raw physical line', () => {
    const rawLine = '材质=Material=钢材、镀锌；原始说明'.repeat(30);
    const sources = Array.from({ length: 2000 }, (_, i) => ({ id: `occurrence:${i}`, properties: [{ path: 'family.fam', line: 17, keys: ['材质', 'Material'], value: '钢材', rawLine }] }));
    const packed = packEngineeringSource(sources), text = JSON.stringify(packed);
    expect(text.length).toBeLessThan(JSON.stringify(sources).length / 10);
    const restored = unpackEngineeringSource(JSON.parse(text));
    expect(restored).toEqual(sources);
    expect(new Set((restored as typeof sources).map(source => source.id)).size).toBe(2000);
  });
  it('preserves source scalar types and nullable fields', () => {
    const data = { text: '0', zero: 0, no: false, yes: true, missing: null, rows: [['', 17, true, null]] };
    expect(unpackEngineeringSource(packEngineeringSource(data))).toEqual(data);
  });
  it('rejects cyclic input and forward or malformed table references', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => packEngineeringSource(cyclic)).toThrow('Cyclic');
    expect(() => unpackEngineeringSource({ encoding: 'engineering-source-table-v1', shapes: [], nodes: [[4, 0]], root: 0 })).toThrow('编码无效');
    expect(() => unpackEngineeringSource({ encoding: 'engineering-source-table-v1', shapes: [['key']], nodes: [[5, 0]], root: 0 })).toThrow('编码无效');
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
