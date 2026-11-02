import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { unpackEngineeringSource } from '../../src/services/engineeringSourceCodec.js';
import type { EngineeringSourceGraph } from '../../src/gim/engineering/sourceGraph.js';
import { buildEngineeringSources } from '../../src/gim/engineering/buildSources.js';
import { getEngineeringRepresentations } from '../../src/services/engineeringRepresentationService.js';
import { AppState } from '../../src/app/state.js';

const results: Record<string, unknown>[] = [], output = resolve('../output/refactor-representation-index-v1');
const parser = createHash('sha256');
for (const file of ['src/gim/engineering/sourceGraph.ts', 'src/gim/famParser.ts', 'src/gim/gimValueSemantics.ts']) parser.update(file).update(readFileSync(resolve(file)));
const graphParserSha256 = parser.digest('hex');
for (const sample of ['s01', 's02', 's03', 's04', 'a31', 'b11', 'b12', 'b13', 'b14']) it(`${sample}: every real DEV address and descendant hint resolves to the exact source candidates`, () => {
  const saved = unpackEngineeringSource(JSON.parse(gunzipSync(readFileSync(resolve(`../output/refactor-navigation-v1/${sample}-source-graph.json.gz`))).toString('utf8'))) as {
    sourceSha256: string; graphParserSha256: string; graph: EngineeringSourceGraph;
  };
  const identity = JSON.parse(readFileSync(resolve(`../output/entity-normalization/source-v1/${sample}/identity.json`), 'utf8'));
  expect(saved.graphParserSha256).toBe(graphParserSha256); expect(saved.sourceSha256).toBe(identity.sha256);
  const built = buildEngineeringSources(identity.sha256, saved.graph, [], []), state = new AppState();
  state.engineeringSources = built.sources; state.engineeringSnapshot = built.snapshot;
  const representation = getEngineeringRepresentations(state)!; expect(representation.issues).toEqual([]);
  const expected = new Map<string, string[]>();
  for (const row of saved.graph.records) {
    const address = row.devOccurrence!; expect(address).toBeDefined();
    const key = JSON.stringify([address.rootSourceId, address.assemblyPath]), ids = expected.get(key) ?? [];
    ids.push(row.id); expected.set(key, ids);
  }
  for (const ids of expected.values()) ids.sort();
  const started = performance.now(); let queries = 0;
  for (const row of saved.graph.records) {
    const address = row.devOccurrence!, ids = expected.get(JSON.stringify([address.rootSourceId, address.assemblyPath]))!;
    expect(representation.index.resolveDev(address.rootSourceId, { assemblyPath: address.assemblyPath }).sourceIds).toEqual(ids);
    const suffix = [address.assemblyPath, 'phm:0', 'mod:0'].filter(Boolean).join('/');
    expect(representation.index.resolveDev(address.rootSourceId, { assemblyPath: suffix }).sourceIds).toEqual(ids);
    queries += 2;
  }
  results.push({ sample, sourceSha256: identity.sha256, devSources: saved.graph.records.length, physicalRoots: representation.index.devRoots.size,
    queries, verificationMs: performance.now() - started,
    scope: 'real DEV source addresses and binding queries including assertions; excludes IFC rendering and native/browser interaction performance' });
});
afterAll(() => {
  mkdirSync(output, { recursive: true }); writeFileSync(join(output, 'nine-projects.json'), JSON.stringify({ complete: results.length === 9, results }, null, 2));
});
