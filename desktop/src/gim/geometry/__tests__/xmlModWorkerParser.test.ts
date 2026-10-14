import { it, expect } from 'vitest';
import { parseXmlMod } from '../xmlModParser.js';
import { parseWorkerXmlMod } from '../xmlModWorkerParser.js';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it.skipIf(process.env.GIM_VERIFY_SUBSTATION01 !== '1')('substation01 worker XML interpretation matches the existing DOM parser for every MOD', () => {
  const root = resolve('../demo/demo-substation/MOD');
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
