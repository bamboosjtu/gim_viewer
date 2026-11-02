import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import { extractEngineeringSourceGraph } from '../../src/gim/engineering/sourceGraph.js';
import type { SourceRecord } from '../../src/gim/engineering/sourceEvidence.js';
import { buildEngineeringSources } from '../../src/gim/engineering/buildSources.js';
import { SubstationSpatialIndexBuilder } from '../../src/gim/ifcSpatialParser.js';
import { createIfcModelId } from '../../src/gim/modelIdentity.js';
import { projectEngineeringNavigation } from '../../src/gim/engineering/navigation.js';
import { assertEngineeringNavigation, encodeEngineeringNavigation, decodeEngineeringNavigation } from '../../src/services/engineeringNavigationCache.js';
import { encodeEngineeringSources, decodeEngineeringSources } from '../../src/services/engineeringCacheCodec.js';
import { packEngineeringSource } from '../../src/services/engineeringSourceCodec.js';

const samples = ['s01', 's02', 's03', 's04', 'a31', 'b11', 'b12', 'b13', 'b14'];
const navigationOutput = resolve('../output/refactor-navigation-v1');
const results: Array<Record<string, unknown>> = [];
const graphParserDigest = createHash('sha256');
for (const file of ['src/gim/engineering/sourceGraph.ts', 'src/gim/famParser.ts', 'src/gim/gimValueSemantics.ts']) graphParserDigest.update(file).update(readFileSync(resolve(file)));
const graphParserSha256 = graphParserDigest.digest('hex');
const count = (values: string[]) => Object.fromEntries([...values.reduce((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => a < b ? -1 : 1));
function pathsAt(folder: string, prefix = ''): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? pathsAt(join(folder, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]);
}

describe('required raw nine-package DEV source extraction', () => {
  for (const sample of samples) it(`${sample}: preserves actual DEV occurrences and source aliases`, async () => {
    const baseline = resolve('../output/refactor-baseline');
    const manifest = JSON.parse(readFileSync(join(baseline, 'manifest.json'), 'utf8'));
    const root = resolve(`../output/entity-normalization/source-v1/${sample}`);
    const identity = JSON.parse(readFileSync(join(root, 'identity.json'), 'utf8'));
    expect(identity.sha256).toBe(manifest.packages.find((p: { sample: string }) => p.sample === sample).source.sha256);
    const rawRoot = join(root, 'source');
    const reference: { sources: SourceRecord[]; sourceAliases: Array<{ status: string }> } = JSON.parse(gunzipSync(readFileSync(join(baseline, `nine-projects/${sample}.json.gz`))).toString('utf8'));
    const paths = pathsAt(rawRoot);
    const graph = await extractEngineeringSourceGraph({
      paths,
      readText: async path => {
        const bytes = readFileSync(join(rawRoot, path));
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
      },
    });
    const dev = reference.sources.filter(row => row.track === 'dev');
    expect(graph.records.length).toBe(dev.length);
    // Compare all occurrences by actual DEV path + current-object name and type,
    // without requiring the old scanner's tree-derived source IDs.
    const key = (path: string, row: SourceRecord) => JSON.stringify([path, row.name, row.source_type]);
    expect(count(graph.records.map(row => key(row.source, row)))).toEqual(count(dev.map(row => key(row.sources[1], row))));
    expect(count(graph.aliases.map(a => a.status))).toEqual(count(reference.sourceAliases.map(a => a.status)));
    expect(new Set(graph.records.map(row => row.id)).size).toBe(graph.records.length);
    const occurrences = new Set(graph.cbmOccurrences.map(node => node.id));
    expect(graph.records.every(row => row.devOccurrence && occurrences.has(row.devOccurrence.cbmOccurrenceId))).toBe(true);
    const builder = new SubstationSpatialIndexBuilder(null);
    for (const path of graph.ifcPaths) {
      builder.addIfcModel({ modelId: createIfcModelId(path), path, name: path }, readFileSync(join(rawRoot, path), 'utf8'));
      await new Promise<void>(done => setImmediate(done));
    }
    const spatial = builder.finalize();
    expect(spatial.models.filter(model => model.parseError).map(model => [model.entryPath, model.parseError])).toEqual([]);
    const built = buildEngineeringSources(identity.sha256, graph, spatial.objects, spatial.models, spatial.nodes);
    const view = projectEngineeringNavigation(built.sources, built.snapshot);
    assertEngineeringNavigation(view, built.sources, built.snapshot);
    expect(view.composition.nodes.get(view.composition.rootKey)?.entityCount).toBe(built.snapshot.entities.length);
    expect(view.sourceRows.size).toBe(built.snapshot.memberships.length);
    const compositionNodes = view.composition.nodes;
    const namedGroup = (title: string) => [...compositionNodes.values()].find(node => node.kind === 'group' && node.title === title);
    const mainSystem = namedGroup('主变压器系统'), tenKv = namedGroup('10千伏配电装置');
    const bays = tenKv?.children.map(key => compositionNodes.get(key)!).filter(node => node.key.includes('/unit:')) ?? [];
    if (sample === 's01') { expect(bays.map(node => node.title)).toEqual(expect.arrayContaining(['36S间隔', '24S间隔'])); expect(namedGroup('20千伏配电装置')).toBeUndefined(); }
    if (sample === 's03') {
      expect(mainSystem?.entityCount).toBeGreaterThan(0);
      expect(namedGroup('Default Building')).toBeUndefined(); expect(namedGroup('无')).toBeUndefined();
      for (const name of ['主控通信楼01','配电室01']) expect(namedGroup(name)?.declaredContextIds?.length).toBeGreaterThan(0);
    }
    if (sample === 's02') expect(namedGroup('HN-220-B-2总平面')).toBeUndefined();
    if (sample === 's04') for (const voltage of [110, 35, 10]) expect(namedGroup(`${voltage}千伏配电装置`)?.entityCount).toBeGreaterThan(0);
    if (sample === 'b11') expect(namedGroup('建筑s')).toBeUndefined();
    if (sample === 'b13') for (const title of ['新建筑1', '新建筑 1']) expect(namedGroup(title)).toBeUndefined();
    const division = (title: string) => {
      const node = namedGroup(title);
      return { title, entityCount: node?.entityCount ?? 0, groups: node?.children.map(key => {
        const group = compositionNodes.get(key)!;
        return { title: group.title, entityCount: group.entityCount, children: group.children.map(key => {
          const child = compositionNodes.get(key)!; return { title: child.title, entityCount: child.entityCount };
        }) };
      }) ?? [] };
    };
    const templateOutput = resolve('../output/refactor-composition-v4'); mkdirSync(templateOutput, { recursive: true });
    writeFileSync(join(templateOutput, `${sample}-complete.json`), JSON.stringify({ sample, sourceSha256: identity.sha256,
      compositionVersion: view.composition.version, sourceComplete: built.sources.complete, wholeCandidates: built.snapshot.entities.length,
      scope: 'production CBM/DEV/IFC source, whole and projection; native rendering/performance excluded',
      divisions: [division('建筑工程'), division('安装工程')], mainTransformerSystemWholes: mainSystem?.entityCount ?? 0,
      tenKvUnits: bays.map(node => ({ title: node.title, entityCount: node.entityCount })),
    }, null, 2));
    let cacheRoundTrip = false;
    if (built.sources.complete) {
      const cacheIdentity = { sourceSha256: identity.sha256, parserVersion: graphParserSha256, entries: paths };
      const encoded = await encodeEngineeringSources(built.sources, cacheIdentity), artifact = await decodeEngineeringSources(encoded.bytes, cacheIdentity);
      const bytes = await encodeEngineeringNavigation(view, built.sources, built.snapshot, artifact.digest, cacheIdentity);
      const restored = await decodeEngineeringNavigation(bytes, artifact.sources, built.snapshot, artifact.digest, cacheIdentity);
      expect(restored).toEqual(view); cacheRoundTrip = true;
    }
    mkdirSync(navigationOutput, { recursive: true });
    writeFileSync(join(navigationOutput, `${sample}-source-graph.json.gz`), gzipSync(JSON.stringify(packEngineeringSource({ sourceSha256: identity.sha256, graphParserSha256, graph, paths }))));
    results.push({ sample, sourceSha256: identity.sha256, graphParserSha256, navigationVersion: view.version, compositionVersion: view.composition.version,
      rulesVersion: built.snapshot.rulesVersion, sourceComplete: built.sources.complete,
      incompleteReasons: built.sources.incompleteReasons, unresolvedReferences: graph.references.filter(reference => reference.status !== 'resolved').length,
      outwardSources: built.snapshot.memberships.length, wholeCandidates: built.snapshot.entities.length, spatialContainers: built.sources.spatialNodes.length,
      sourceRows: view.sourceRows.size, compositionRows: view.composition.nodes.size, cacheRoundTrip });
  }, 600_000);
});
afterAll(() => {
  mkdirSync(navigationOutput, { recursive: true });
  writeFileSync(join(navigationOutput, 'nine-projects.json'), JSON.stringify({ complete: results.length === samples.length,
    scope: 'raw production source/whole/navigation coverage and valid complete-cache round trips; excludes native IPC, geometry and desktop performance', results }, null, 2));
});
