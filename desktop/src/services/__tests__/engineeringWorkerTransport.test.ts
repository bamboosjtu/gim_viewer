// @vitest-environment node
import { expect, it } from 'vitest';
import { extractEngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { buildEngineeringSources } from '../../gim/engineering/buildSources.js';
import { projectEngineeringNavigation } from '../../gim/engineering/navigation.js';
import { collectSourceGeometryOccurrences } from '../../gim/engineering/geometryOccurrences.js';
import { encodeEngineeringWorkerResultAsync, decodeEngineeringWorkerResult, engineeringWorkerResultTransfers } from '../engineeringWorkerTransport.js';

async function fixture() {
  const raw: Record<string,string> = { 'project.cbm': 'OBJECTMODELPOINTER=main.dev',
    'main.dev': 'SYMBOLNAME=主变压器\nSUBDEVICE0=terminal.dev\nSUBDEVICE1=radiator.dev',
    'terminal.dev': 'SYMBOLNAME=本体端子箱', 'radiator.dev': 'SYMBOLNAME=散热器' };
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(raw), readText: async path => raw[path] });
  const built = buildEngineeringSources('sample', graph, [], []);
  return { ...built, navigation: projectEngineeringNavigation(built.sources, built.snapshot), geometryOccurrences: collectSourceGeometryOccurrences(graph) };
}

it('transfers owned buffers once and restores source facts, whole membership, maps and placement matrices', async () => {
  const result = await fixture();
  const wire = await encodeEngineeringWorkerResultAsync({ ...result, buildId:1,cachePlan:['sources','entities','navigation'],entityCacheHit:true });
  const buffers = engineeringWorkerResultTransfers(wire); expect(buffers).toHaveLength(1);
  const received = structuredClone(wire, { transfer: buffers });
  expect(wire.body.byteLength).toBe(0);expect('sourceBytes' in wire).toBe(false);
  const restored = await decodeEngineeringWorkerResult(received, () => true);
  expect(restored.sources).toEqual(result.sources); expect(restored.snapshot).toEqual(result.snapshot);
  expect(restored.navigation).toEqual(result.navigation); expect(restored.navigation.sourceNodes).toBeInstanceOf(Map);
  expect(restored.geometryOccurrences).toEqual(result.geometryOccurrences);
  expect(restored.cachePlan).toEqual(['sources','entities','navigation']);expect(restored.entityCacheHit).toBe(true);expect(restored.metrics?.transportBytes).toBeGreaterThan(0);
});

it('interns repeated family lines instead of expanding each occurrence across the Worker boundary', async () => {
  const result = await fixture(), original = '材质=Material=钢材、镀锌；原始说明'.repeat(100);
  for (const record of result.sources.graph.records) record.properties = Array.from({ length: 500 }, () => ({ path: 'family.fam', line: 17, keys: ['材质', 'Material'], value: '钢材', rawLine: original }));
  const wire = await encodeEngineeringWorkerResultAsync(result);
  expect(wire.body.byteLength).toBeLessThan(new TextEncoder().encode(JSON.stringify(result.sources)).byteLength / 10);
  const restored = await decodeEngineeringWorkerResult(wire, () => true);
  expect(restored.sources).toEqual(result.sources);
  const records = restored.sources.graph.records;
  expect(records[0].properties[0]).toBe(records[1].properties[0]);
});

it('rejects invalid transport and cancels a decoded result before publication when the project changes', async () => {
  const wire = await encodeEngineeringWorkerResultAsync(await fixture());
  await expect(decodeEngineeringWorkerResult({ ...wire, encoding: 'invalid' as any }, () => true)).rejects.toThrow('传输无效');
  let current = true; const pending = decodeEngineeringWorkerResult(wire, () => current); current = false;
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
