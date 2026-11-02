import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { describe, expect, it, afterAll } from 'vitest';
import { normalizeEngineeringModel } from '../../src/engineering/normalize.js';
import type { SourceAlias } from '../../src/engineering/types.js';
import { toObjectEvidence } from '../../src/gim/engineering/sourceEvidence.js';
import type { SourceRecord } from '../../src/gim/engineering/sourceEvidence.js';

interface Reference {
  sources: SourceRecord[];
  sourceAliases: Array<{ source: string; status: 'confirmed' | 'ambiguous' | 'not_found'; target?: string; candidates?: string[] }>;
  memberships: Array<{ source_id: string; whole_id: string; disposition: string; source_meaning: string; source_class_candidate: string }>;
  entities: Array<{ id: string; code: string; unit_kind: string; source_members: string[]; phase_body_count: string }>;
  pending: Array<{ id: string; reason: string; source_members: string[] }>;
  aliases: Array<{ source: string; status: string; whole_id: string; component_candidates: string[] }>;
}

const output = resolve('../output/refactor-baseline');
const samples = ['s01', 's02', 's03', 's04', 'a31', 'b11', 'b12', 'b13', 'b14'];
const results: Array<Record<string, unknown>> = [];

describe('required nine-project source-to-whole conformance', () => {
  for (const sample of samples) it(`${sample}: every source, whole boundary, pending set and alias agrees with the verified reference`, () => {
    const manifest = JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8'));
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    expect(hash(resolve('../research/scripts/engineering_units.py'))).toBe(manifest.rules_sha256);
    const entry = manifest.packages.find((p: { sample: string }) => p.sample === sample);
    expect(hash(resolve('..', entry.source.path))).toBe(entry.source.sha256);
    expect(hash(resolve(`../research/data/nine-projects/${sample}/entities.csv.gz`))).toBe(entry.scan_sha256);
    const reference: Reference = JSON.parse(gunzipSync(readFileSync(resolve(output, `nine-projects/${sample}.json.gz`))).toString('utf8'));
    const input = reference.sources.map(toObjectEvidence);
    const aliases: SourceAlias[] = reference.sourceAliases.map(a => ({ sourceId: a.source,
      status: a.status === 'not_found' ? 'unresolved' : a.status, candidates: a.candidates ?? (a.target ? [a.target] : []) }));
    const started = performance.now();
    const model = normalizeEngineeringModel(sample, input, aliases);
    const durationMs = performance.now() - started;
    expect(model.entities.length).toBe(reference.entities.length);
    expect(model.pending.length).toBe(reference.pending.length);
    expect(model.memberships.length).toBe(reference.sources.length);
    const memberships = new Map(model.memberships.map(m => [m.sourceId, m]));
    const ownerMap = new Map<string, string>();
    const mismatches: string[] = [];
    for (const old of reference.memberships) {
      const next = memberships.get(old.source_id);
      if (!next || next.disposition !== old.disposition || next.interpretation.meaning !== old.source_meaning || next.interpretation.category !== old.source_class_candidate) {
        mismatches.push(`${old.source_id}: role/category/disposition`); continue;
      }
      if (!old.whole_id) {
        if (next.ownerId) mismatches.push(`${old.source_id}: source-only gained an owner`);
      } else {
        const mapped = ownerMap.get(old.whole_id);
        if (mapped && mapped !== next.ownerId) mismatches.push(`${old.source_id}: whole boundary differs`);
        ownerMap.set(old.whole_id, next.ownerId!);
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(new Set(ownerMap.values()).size).toBe(ownerMap.size);
    const entities = new Map(model.entities.map(e => [e.id, e]));
    for (const old of reference.entities) {
      const next = entities.get(ownerMap.get(old.id)!);
      expect(next, old.id).toBeDefined();
      expect(next!.sourceIds).toEqual(old.source_members);
      expect([next!.category, next!.kind, next!.phaseBodyCount ?? '']).toEqual([old.code, old.unit_kind, old.phase_body_count ? Number(old.phase_body_count) : '']);
    }
    const pending = new Map(model.pending.map(p => [p.id, p]));
    for (const old of reference.pending) {
      const next = pending.get(ownerMap.get(old.id)!);
      expect(next, old.id).toBeDefined();
      expect([next!.reason, next!.sourceIds]).toEqual([old.reason, old.source_members]);
    }
    const actualAliases = new Map(model.aliases.map(a => [a.sourceId, a]));
    for (const old of reference.aliases) {
      const next = actualAliases.get(old.source)!;
      expect(next.status).toBe(old.status);
      expect(next.ownerId).toBe(old.whole_id ? ownerMap.get(old.whole_id) : null);
      expect(next.componentCandidates).toEqual(old.component_candidates);
    }
    // Real-source ordering is not identity. Deterministic output covers all nine.
    expect(normalizeEngineeringModel(sample, [...input].reverse(), aliases)).toEqual(model);
    results.push({ sample, sources: input.length, entities: model.entities.length, pending: model.pending.length, durationMs });
  });
});

afterAll(() => {
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'typescript-conformance.json'), JSON.stringify({
    complete: results.length === samples.length,
    scope: 'verified source snapshots -> TypeScript engineering normalization; not source parser or desktop rendering acceptance',
    samples: results,
  }, null, 2));
});
