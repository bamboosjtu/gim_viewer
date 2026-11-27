import { it, expect } from 'vitest';
import { parseXmlMod } from '../xmlModParser.js';
import { parseWorkerXmlMod } from '../xmlModWorkerParser.js';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it.skipIf(process.env.GIM_VERIFY_SUBSTATION01 !== '1')('substation01 worker XML interpretation matches the existing DOM parser for every MOD', () => {
  const root = resolve(process.env.GIM_SUBSTATION01_ROOT ?? '../demo/demo-substation', 'MOD');
  const files = readdirSync(root).filter(p => /\.mod$/i.test(p));
  expect(files.length).toBe(4179);
  const counts: Record<string, number> = {};
  for (const file of files) {
    const text = readFileSync(resolve(root, file), 'utf8');
    const value = parseWorkerXmlMod(text, file);
    expect(value).toEqual(parseXmlMod(text, file));
    for (const entity of value.entities) counts[entity.primitive.type] = (counts[entity.primitive.type] ?? 0) + 1;
  }
  console.log('substation01 primitive counts', counts);
}, 120000);

it('rejects malformed XML and external declarations', () => {
  expect(() => parseWorkerXmlMod('<Device><Entities></Device>', 'bad.mod')).toThrow();
  expect(() => parseWorkerXmlMod('<!DOCTYPE Device><Device/>', 'bad.mod')).toThrow();
});

it.each([
  ['1junk', '2'],
  ['1', '2.0'],
  ['1', '9007199254740992'],
])('preserves malformed Boolean references %s and %s in both XML parsers', (entity1, entity2) => {
  const text = `<Device><Entities><Entity ID="3"><Boolean Type="Union" Entity1="${entity1}" Entity2="${entity2}"/></Entity></Entities></Device>`;
  const worker = parseWorkerXmlMod(text, 'bad.mod');
  expect(worker).toEqual(parseXmlMod(text, 'bad.mod'));
  expect(worker.entities[0].primitive).toEqual({
    type: 'Unsupported', sourceType: 'Boolean', raw: { Type: 'Union', Entity1: entity1, Entity2: entity2 },
  });
  expect(worker.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsupported-primitive' }));
});

it('accepts Boolean references with the same integer syntax as Entity IDs in both XML parsers', () => {
  const text = '<Device><Entities><Entity ID="3"><Boolean Type="Union" Entity1=" 00 " Entity2="9007199254740991"/></Entity></Entities></Device>';
  const worker = parseWorkerXmlMod(text, 'valid.mod');
  expect(worker).toEqual(parseXmlMod(text, 'valid.mod'));
  expect(worker.entities[0].primitive).toEqual({ type: 'Boolean', op: 'Union', entity1: 0, entity2: Number.MAX_SAFE_INTEGER });
});
