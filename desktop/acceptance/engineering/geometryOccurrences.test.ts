import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, expect, it, vi } from 'vitest';
import { unpackEngineeringSource } from '../../src/services/engineeringSourceCodec.js';
import type { EngineeringSourceGraph } from '../../src/gim/engineering/sourceGraph.js';
import { collectSourceGeometryOccurrences } from '../../src/gim/engineering/geometryOccurrences.js';
import { discoverGeometriesFromDevPath } from '../../src/services/modGeometryDiscovery.js';
import { isUsableAffineMatrix } from '../../src/gim/geometry/affineMatrix.js';

const samples = ['s01', 's02', 's03', 's04', 'a31', 'b11', 'b12', 'b13', 'b14'];
const directory = resolve('../output/refactor-source-geometry-v1');
const results: unknown[] = [];
const parser = createHash('sha256');
for (const file of ['src/gim/engineering/sourceGraph.ts', 'src/gim/famParser.ts', 'src/gim/gimValueSemantics.ts']) parser.update(file).update(readFileSync(resolve(file)));
const graphParserSha256 = parser.digest('hex');

for (const sample of samples) it(`${sample}: actual physical roots and template references use source occurrence identities`, async () => {
  const input = resolve(`../output/entity-normalization/source-v1/${sample}`);
  const identity = JSON.parse(readFileSync(join(input, 'identity.json'), 'utf8'));
  const geometryInput = resolve(`../output/refactor-source-geometry-input-v1/${sample}`);
  const geometryIdentity: { sourceSha256: string; entries: Array<{ path: string; sha256: string }> } = JSON.parse(readFileSync(join(geometryInput, 'identity.json'), 'utf8'));
  expect(geometryIdentity.sourceSha256).toBe(identity.sha256);
  const saved = unpackEngineeringSource(JSON.parse(gunzipSync(readFileSync(resolve(`../output/refactor-navigation-v1/${sample}-source-graph.json.gz`))).toString('utf8'))) as {
    graphParserSha256: string; sourceSha256: string; graph: EngineeringSourceGraph; paths: string[];
  };
  expect(saved.sourceSha256).toBe(identity.sha256); expect(saved.graphParserSha256).toBe(graphParserSha256);
  const graph = saved.graph, catalog = collectSourceGeometryOccurrences(graph);
  expect(new Set(catalog.occurrences.map(row => row.id)).size).toBe(catalog.occurrences.length);
  expect(catalog.occurrences.every(row => isUsableAffineMatrix(row.placementMatrix))).toBe(true);
  expect(catalog.occurrences.map(row => row.id)).toEqual(graph.records.filter(row => row.devOccurrence?.rootSourceId === row.id).map(row => row.id));
  const files = new Map(geometryIdentity.entries.map(({ path, sha256 }) => [path, {
    name: path.split('/').pop()!, size: 0,
    text: async () => { const bytes = readFileSync(join(geometryInput, 'files', path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); } },
  } as File]));
  const templates = [...new Set(catalog.occurrences.map(row => row.devPath))];
  let modLeaves = 0, stlLeaves = 0, reachableOccurrences = 0;
  const warnings: string[] = [], unavailable: Array<{ path: string; reason: string }> = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => warnings.push(args.map(String).join(' ')));
  try {
    for (const path of templates) {
      const rows = catalog.occurrences.filter(row => row.devPath === path);
      // Compile each template's physical references once; place every root separately.
      const local = await discoverGeometriesFromDevPath(path, files, [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], new Set(), 0, { instances: 0 }, { strictDependencies: false });
      for (const leaf of [...local.mods, ...local.stls]) expect(isUsableAffineMatrix(leaf.placementTransformMatrix)).toBe(true);
      modLeaves += local.mods.length; stlLeaves += local.stls.length;
      reachableOccurrences += (local.mods.length + local.stls.length) * rows.length;
      try { await discoverGeometriesFromDevPath(path, files, [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], new Set(), 0, { instances: 0 }, { strictDependencies: true }); }
      catch (error) { unavailable.push({ path, reason: String(error) }); }
    }
  } finally { warn.mockRestore(); }
  mkdirSync(directory, { recursive: true });
  const result = { sample, sourceSha256: identity.sha256, graphParserSha256, physicalRoots: catalog.occurrences.length,
    uniqueDevTemplates: templates.length, modTemplateLeaves: modLeaves, stlTemplateLeaves: stlLeaves, reachableOccurrences,
    unavailableTemplates: unavailable, warnings: [...new Set(warnings)], placementDiagnostics: catalog.diagnostics,
    scope: 'all source root placements and real DEV/PHM/MOD/STL reference discovery; excludes triangulation, native rendering and performance' };
  writeFileSync(join(directory, `${sample}.json`), JSON.stringify(result, null, 2));
  expect(catalog.occurrences.length).toBeGreaterThan(0); expect(reachableOccurrences).toBeGreaterThan(0);
  results.push(result);
}, 600_000);

afterAll(() => { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'nine-projects.json'), JSON.stringify({
  complete: results.length === samples.length, results,
}, null, 2)); });
