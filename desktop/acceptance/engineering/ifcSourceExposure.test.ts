import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import { SubstationSpatialIndexBuilder } from '../../src/gim/ifcSpatialParser.js';
import { createIfcModelId } from '../../src/gim/modelIdentity.js';
import { ifcSourceRecords } from '../../src/gim/engineering/ifcSourceRecords.js';
import { toObjectEvidence } from '../../src/gim/engineering/sourceEvidence.js';
import type { SourceRecord } from '../../src/gim/engineering/sourceEvidence.js';
import { normalizeEngineeringModel } from '../../src/engineering/normalize.js';
import type { SourceAlias } from '../../src/engineering/types.js';

const samples = ['s01', 's02', 's03', 's04', 'a31', 'b11', 'b12', 'b13', 'b14'];
const out = resolve('../output/refactor-baseline');
const results: Array<Record<string, unknown>> = [];
// The research whole-input excludes these outward feature interfaces. They
// remain sources in the production parser and must never gain default entities.
const featureTypes = new Set(['IFCANNOTATION', 'IFCGRID', 'IFCDISTRIBUTIONPORT', 'IFCPORT', 'IFCOPENINGELEMENT',
  'IFCOPENINGSTANDARDCASE', 'IFCVOIDINGFEATURE', 'IFCFEATUREELEMENTSUBTRACTION', 'IFCFEATUREELEMENTADDITION', 'IFCPROJECTIONELEMENT']);

describe('required nine-package production IFC source exposure', () => {
  for (const sample of samples) it(`${sample}: production STEP parser retains every researched outward product`, async () => {
    const reference: { sources: SourceRecord[]; sourceAliases: Array<{ source: string; status: 'confirmed' | 'ambiguous' | 'not_found'; candidates?: string[]; target?: string }> } = JSON.parse(gunzipSync(readFileSync(join(out, `nine-projects/${sample}.json.gz`))).toString('utf8'));
    const summary = JSON.parse(readFileSync(resolve(`../research/data/nine-projects/${sample}/summary.json`), 'utf8'));
    const root = resolve(`../output/entity-normalization/source-v1/${sample}/source`);
    const builder = new SubstationSpatialIndexBuilder(null);
    for (const model of summary.models) {
      const text = readFileSync(join(root, model.path), 'utf8');
      builder.addIfcModel({ modelId: createIfcModelId(model.path), path: model.path, name: model.path }, text);
      // Allow the test runner to observe progress/cancellation between files.
      await new Promise<void>(done => setImmediate(done));
    }
    const index = builder.finalize();
    expect(index.models.filter(m => m.parseError).map(m => [m.entryPath, m.parseError])).toEqual([]);
    const records = ifcSourceRecords(index.objects);
    const actual = new Map(records.map(r => [r.source, r]));
    const expected = reference.sources.filter(r => r.track === 'ifc');
    const missing = expected.filter(r => !actual.has(r.source));
    expect(missing.slice(0, 20).map(r => [r.source, r.source_type])).toEqual([]);
    const expectedKeys = new Set(expected.map(r => r.source));
    const extra = records.filter(r => !expectedKeys.has(r.source));
    const extraTypes = Object.fromEntries([...new Set(extra.map(r => r.source_type))].sort().map(type => [type, extra.filter(r => r.source_type === type).length]));
    expect(extra.filter(r => !featureTypes.has(r.source_type)).slice(0, 20).map(r => [r.source, r.source_type])).toEqual([]);
    expect(extra.filter(r => !toObjectEvidence(r).traits.nonphysical).slice(0, 20).map(r => [r.source, r.source_type])).toEqual([]);
    const expectedByPath = new Map(expected.map(r => [r.source, r]));
    const sourceById = new Map(reference.sources.map(r => [r.id, r]));
    const canonicalIds = new Map(records.map(r => [r.id, expectedByPath.get(r.source)?.id ?? r.id]));
    const productionRows = records.map(row => ({ ...row, id: canonicalIds.get(row.id)!, parent: canonicalIds.get(row.parent) ?? row.parent }));
    const aliases: SourceAlias[] = reference.sourceAliases.map(a => ({ sourceId: a.source, status: a.status === 'not_found' ? 'unresolved' : a.status,
      candidates: a.candidates ?? (a.target ? [a.target] : []) }));
    const baseline = normalizeEngineeringModel(sample, reference.sources.map(toObjectEvidence), aliases);
    const production = normalizeEngineeringModel(sample, [...reference.sources.filter(r => r.track === 'dev'), ...productionRows].map(toObjectEvidence), aliases);
    const memberships = new Map(production.memberships.map(m => [m.sourceId, m]));
    const changed = baseline.memberships.filter(m => {
      const actual = memberships.get(m.sourceId);
      return !actual || actual.ownerId !== m.ownerId || actual.interpretation.category !== m.interpretation.category;
    }).map(m => ({ source: sourceById.get(m.sourceId)?.source, before: m, after: memberships.get(m.sourceId) }));
    const refinements = changed.filter(change => {
      const before = sourceById.get(change.before.sourceId), after = change.after;
      const observed = change.source ? actual.get(change.source) : undefined;
      // The old scan only used IFC Name. A current object's own decoded field
      // can refine a placeholder Name, but cannot silently change ownership.
      return before && observed && ['', '--', '-', '$'].includes(before.name) && after && change.before.ownerId === after.ownerId &&
        change.before.interpretation.category === 'U-OBJECT' && after.interpretation.category !== 'U-OBJECT' &&
        change.before.interpretation.meaning === after.interpretation.meaning &&
        observed.properties.some(p => p.keys?.some(key => ['IFC.Description', 'IFC.ObjectType', 'IFC.Tag'].includes(key)) && p.value.replace(/\s+/g, ' ').trim() === observed.name);
    });
    const accepted = new Set(refinements);
    const unexplained = changed.filter(change => !accepted.has(change));
    writeFileSync(join(out, `${sample}-production-ifc-differences.json`), JSON.stringify({ refinements, unexplained }, null, 2));
    expect(unexplained.slice(0, 5)).toEqual([]);
    results.push({ sample, models: index.models.length, researchedProducts: expected.length, productionRecords: records.length,
      ownObjectFieldClassifications: refinements.length, unexplainedDifferences: unexplained.length, extraSourceFeatureTypes: extraTypes });
  }, 600_000);
});
afterAll(() => {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'ifc-source-exposure.json'), JSON.stringify({ complete: results.length === samples.length,
    scope: 'production STEP parser exposure vs research outward products; excludes geometry and desktop rendering', results }, null, 2));
});
