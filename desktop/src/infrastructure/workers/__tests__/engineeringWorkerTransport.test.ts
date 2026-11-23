// @vitest-environment node
import { expect, it } from 'vitest';
import { extractEngineeringSourceGraph } from '@gim/gim-sdk/source';
import {buildTestEngineeringSources} from '@tests/sdk-source-fixtures';
import { projectEngineeringNavigation } from '@gim/gim-sdk/projection';
import { encodeEngineeringWorkerResult, decodeEngineeringWorkerResult, engineeringWorkerResultTransfers } from '../engineeringWorkerTransport.js';

async function fixture() {
  const raw: Record<string,string> = { 'project.cbm': 'OBJECTMODELPOINTER=main.dev',
    'main.dev': 'SYMBOLNAME=主变压器\nSUBDEVICE0=terminal.dev\nSUBDEVICE1=radiator.dev',
    'terminal.dev': 'SYMBOLNAME=本体端子箱', 'radiator.dev': 'SYMBOLNAME=散热器' };
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(raw), readText: async path => raw[path] });
  const built = buildTestEngineeringSources('sample', graph, [], []);
  return { ...built, navigation: projectEngineeringNavigation(built.sources, built.snapshot) };
}

it('transfers owned buffers once and restores source facts, whole membership, maps and placement matrices', async () => {
  const result = await fixture();
  const wire = encodeEngineeringWorkerResult({ ...result, buildId:1,cachePlan:['sources','entities','navigation'],entityCacheHit:true });
  const buffers = engineeringWorkerResultTransfers(wire);
  expect(buffers).toHaveLength(wire.body.length);
  expect(new Set(buffers).size).toBe(buffers.length);
  const received = structuredClone(wire, { transfer: buffers });
  expect(wire.body.every(page => page.byteLength === 0)).toBe(true);
  expect('sourceBytes' in wire).toBe(false);
  const restored = await decodeEngineeringWorkerResult(received, () => true);
  expect(restored.sources).toEqual(result.sources); expect(restored.snapshot).toEqual(result.snapshot);
  expect(restored.navigation).toEqual(result.navigation); expect(restored.navigation.sourceNodes).toBeInstanceOf(Map);
  expect('geometryOccurrences' in restored).toBe(false);
  expect(restored.cachePlan).toEqual(['sources','entities','navigation']);expect(restored.entityCacheHit).toBe(true);expect(restored.metrics?.transportBytes).toBeGreaterThan(0);
});

it('interns repeated family lines instead of expanding each occurrence across the Worker boundary', async () => {
  const result = await fixture(), original = '材质=Material=钢材、镀锌；原始说明'.repeat(100);
  for (const record of result.sources.graph.records) record.properties = Array.from({ length: 500 }, () => ({ path: 'family.fam', line: 17, keys: ['材质', 'Material'], value: '钢材', rawLine: original }));
  const wire = encodeEngineeringWorkerResult(result);
  expect(wire.metrics?.transportBytes).toBeLessThan(new TextEncoder().encode(JSON.stringify(result.sources)).byteLength / 10);
  const restored = await decodeEngineeringWorkerResult(wire, () => true);
  expect(restored.sources).toEqual(result.sources);
  const records = restored.sources.graph.records;
  expect(records[0].properties[0]).toBe(records[1].properties[0]);
});

it('hydrates large results page by page and preserves shared references across page boundaries', async () => {
  const result = await fixture();
  const shared = { path: 'family.fam', line: 1, keys: ['名称'], value: '共享', rawLine: '名称=共享' };
  const properties = Array.from({ length: 4200 }, (_, i) => ({
    ...shared, line: i + 2, value: `构件 ${i}`,
  }));
  const [first, second] = result.sources.graph.records;
  first.properties = [shared, ...properties];
  second.properties = [shared];
  const wire = encodeEngineeringWorkerResult(result);
  expect(wire.body.length).toBeGreaterThan(2);
  const received = structuredClone(wire, { transfer: engineeringWorkerResultTransfers(wire) });
  const restored = await decodeEngineeringWorkerResult(received, () => true, undefined, true);
  expect(received.body).toHaveLength(0);
  const records = restored.sources.graph.records;
  expect(records[0].properties).toEqual(first.properties);
  expect(records[0].properties[0]).toBe(records[1].properties[0]);
});

it('rejects invalid transport and cancels a decoded result before publication when the project changes', async () => {
  const wire = encodeEngineeringWorkerResult(await fixture());
  await expect(decodeEngineeringWorkerResult({ ...wire, encoding: 'invalid' as any }, () => true)).rejects.toThrow('传输无效');
  let current = true; const pending = decodeEngineeringWorkerResult(wire, () => current); current = false;
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
