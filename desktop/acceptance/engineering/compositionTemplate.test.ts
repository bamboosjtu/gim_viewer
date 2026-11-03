import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { unpackEngineeringSource } from '../../src/services/engineeringSourceCodec.js';
import type { EngineeringSourceGraph } from '../../src/gim/engineering/sourceGraph.js';
import { buildEngineeringSources } from '../../src/gim/engineering/buildSources.js';
import { projectEngineeringNavigation } from '../../src/gim/engineering/navigation.js';
import { assertEngineeringNavigation } from '../../src/services/engineeringNavigationCache.js';

const results: Array<Record<string, unknown>> = [], output = resolve('../output/refactor-composition-v4');
const graphParser = createHash('sha256');
for (const file of ['src/gim/engineering/sourceGraph.ts', 'src/gim/famParser.ts', 'src/gim/gimValueSemantics.ts']) graphParser.update(file).update(readFileSync(resolve(file)));
const graphParserSha256 = graphParser.digest('hex');
for (const sample of ['s01', 's02', 's03', 's04', 'a31', 'b11', 'b12', 'b13', 'b14']) it(`${sample}: source-declared construction and installation template`, () => {
  const saved = unpackEngineeringSource(JSON.parse(gunzipSync(readFileSync(resolve(`../output/refactor-navigation-v1/${sample}-source-graph.json.gz`))).toString('utf8'))) as {
    sourceSha256: string; graphParserSha256: string; graph: EngineeringSourceGraph;
  };
  expect(saved.graphParserSha256).toBe(graphParserSha256);
  const identity = JSON.parse(readFileSync(resolve(`../output/entity-normalization/source-v1/${sample}/identity.json`), 'utf8'));
  expect(saved.sourceSha256).toBe(identity.sha256);
  // Fast fixture covers every real DEV occurrence. Full IFC + cache coverage
  // remains the independent sourceGraph.test gate, not this partial model.
  const built = buildEngineeringSources(identity.sha256, saved.graph, [], []), before = JSON.stringify(built.snapshot);
  const view = projectEngineeringNavigation(built.sources, built.snapshot), nodes = view.composition.nodes;
  assertEngineeringNavigation(view, built.sources, built.snapshot);
  expect(JSON.stringify(built.snapshot)).toBe(before);
  const group = (title: string) => [...nodes.values()].find(node => node.kind === 'group' && node.title === title);
  const main = group('主变压器系统'), tenKv = group('10千伏配电装置');
  const bays = tenKv?.children.map(key => nodes.get(key)!).filter(node => node.kind === 'group' && node.key.includes('/unit:')) ?? [];
  if (sample === 's01') expect(bays.map(node => node.title)).toEqual(expect.arrayContaining(['36S间隔', '24S间隔']));
  if (sample === 's03') {
    expect(main?.entityCount).toBeGreaterThan(0);
    const transformer = built.snapshot.entities.find(entity => entity.name === '1号主变')!;
    expect(transformer.category).toBe('E01');
    const rows = view.composition.rowsByEntity.get(transformer.id)!;
    expect(rows.some(row => row.startsWith(`${main!.key}/`))).toBe(true);
    expect(bays.some(node => node.title === '出线间隔02')).toBe(true);
  }
  const row = { sample, sourceSha256: identity.sha256, graphParserSha256, compositionVersion: view.composition.version,
    scope: 'all real DEV source occurrences and projection; full IFC/cache/native rendering are separate gates',
    devSources: saved.graph.records.length, wholeCandidates: built.snapshot.entities.length,
    divisions: nodes.get(view.composition.rootKey)!.children.map(key => { const node = nodes.get(key)!; return { title: node.title, entityCount: node.entityCount }; }),
    mainTransformerSystemWholes: main?.entityCount ?? 0, tenKvBays: bays.map(node => ({ title: node.title, entityCount: node.entityCount })),
  };
  mkdirSync(output, { recursive: true }); writeFileSync(join(output, `${sample}-dev.json`), JSON.stringify(row, null, 2)); results.push(row);
}, 120_000);
afterAll(() => { mkdirSync(output, { recursive: true }); writeFileSync(join(output, 'nine-dev-projects.json'), JSON.stringify({ complete: results.length === 9, results }, null, 2)); });
