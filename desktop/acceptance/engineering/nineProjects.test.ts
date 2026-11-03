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
  for (const sample of samples) it(`${sample}: conserves researched sources and verifies the current transformer/cabinet boundaries`, () => {
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
    // Research is the immutable source ledger. Its former whole boundaries
    // are not a current acceptance oracle: the approved terminal/neutral
    // composition and attribute precedence deliberately change those boundaries.
    expect(model.memberships.length).toBe(reference.sources.length);
    expect(new Set(model.memberships.map(m => m.sourceId)).size).toBe(reference.sources.length);
    const memberships = new Map(model.memberships.map(m => [m.sourceId, m]));
    const entities = new Map(model.entities.map(e => [e.id,e]));
    const sources = new Map(reference.sources.map(r=>[r.id,r]));
    for(const row of reference.sources){
      const member=memberships.get(row.id)!;
      expect(member,row.id).toBeDefined();
      // A source with an explicit secondary type cannot become a main body
      // merely because its name describes the transformer it controls.
      if(/^(?:secondarycabinet|screencabinetsandinstallations)$/i.test(row.source_type)&&/测控|控制|保护|屏柜/.test(row.name)){
        expect(member.interpretation.category,row.name).toMatch(/^E16/);
        expect(entities.get(member.ownerId??'')?.category,row.name).toMatch(/^E16/);
      }
      if(member.interpretation.category==='E16.terminal_box'){
        let parent=row.parent;const seen=new Set<string>();
        while(parent&&!seen.has(parent)){
          seen.add(parent);const host=memberships.get(parent),source=sources.get(parent);
          if(!host||!source)break;
          if(['E01','E-T','E03'].includes(host.interpretation.category)&&host.interpretation.meaning==='object'){
            expect(member.ownerId,row.name).toBe(host.ownerId);break;
          }
          parent=source.parent;
        }
      }
    }
    const changed=reference.memberships.flatMap(old=>{const next=memberships.get(old.source_id)!;return next.interpretation.category!==old.source_class_candidate||next.interpretation.meaning!==old.source_meaning||next.disposition!==old.disposition?[{source:old.source_id,before:{category:old.source_class_candidate,role:old.source_meaning,disposition:old.disposition},after:next.interpretation}]:[];});
    writeFileSync(resolve(output, sample+'-rule-differences.json'),JSON.stringify(changed,null,2));
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
