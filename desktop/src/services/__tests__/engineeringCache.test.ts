// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import vocabulary from '../../gim/engineering/sourceVocabulary.json';
import {projectEngineeringNavigation} from '../../gim/engineering/navigation.js';
import {encodeEngineeringNavigation} from '../engineeringNavigationCache.js';
import { extractEngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { buildEngineeringSources } from '../../gim/engineering/buildSources.js';
import { decodeEngineeringEntities, decodeEngineeringSources, encodeEngineeringEntities, encodeEngineeringSources, engineeringCacheEntry, engineeringSourceCacheMatchesFiles } from '../engineeringCacheCodec.js';
import { markCacheFailure } from '../engineeringWorker.js';
import type { EngineeringBuildResult } from '../engineeringWorkerProtocol.js';

const id = { sourceSha256: 'a'.repeat(64), parserVersion: 'parser-contract', entries: ['project.cbm', 'unit.dev', 'terminal.dev'] };
async function fixture(extra: Record<string, string> = {}) {
  const files: Record<string, string> = { 'project.cbm': 'OBJECTMODELPOINTER=unit.dev', 'unit.dev': 'SYMBOLNAME=主变压器\nSUBDEVICE0=terminal.dev',
    'terminal.dev': 'SYMBOLNAME=测控柜', ...extra };
  const graph = await extractEngineeringSourceGraph({ paths: Object.keys(files), readText: async p => files[p] });
  return buildEngineeringSources(id.sourceSha256, graph, [], []);
}

describe('independent source and entity cache contracts', () => {
  it('invalidates entities and navigation on vocabulary changes while retaining the source artifact',async()=>{
    const model=await fixture(),encoded=await encodeEngineeringSources(model.sources,id);
    const sources=await decodeEngineeringSources(encoded.bytes,id),entities=await encodeEngineeringEntities(model.snapshot,sources,id);
    const navigation=await encodeEngineeringNavigation(projectEngineeringNavigation(model.sources,model.snapshot),model.sources,model.snapshot,sources.digest,id);
    expect(model.snapshot.rulesVersion).toContain(vocabulary.version);
    vi.resetModules();vi.doMock('../../gim/engineering/sourceVocabulary.json',()=>({default:{...vocabulary,version:'substation-vocabulary-next'}}));
    try{
      const next=await import('../engineeringCacheCodec.js'),nextNavigation=await import('../engineeringNavigationCache.js');
      expect((await next.decodeEngineeringSources(encoded.bytes,id)).digest).toBe(sources.digest);
      await expect(next.decodeEngineeringEntities(entities,sources,id)).rejects.toThrow('identity / version');
      await expect(nextNavigation.decodeEngineeringNavigation(navigation,model.sources,model.snapshot,sources.digest,id)).rejects.toThrow('identity / version');
    }finally{vi.doUnmock('../../gim/engineering/sourceVocabulary.json');vi.resetModules();}
  });
  it('round trips sources and membership without relying on a CBM UI tree or geometry', async () => {
    const model = await fixture();
    const encoded = await encodeEngineeringSources(model.sources, id);
    const sources = await decodeEngineeringSources(encoded.bytes, id);
    const entities = await encodeEngineeringEntities(model.snapshot, sources, id);
    expect(sources.sources).toEqual(model.sources);
    expect(await decodeEngineeringEntities(entities, sources, id)).toEqual(model.snapshot);
    expect(engineeringCacheEntry(id, 'entities')).not.toBe(engineeringCacheEntry(id, 'sources'));
  });

  it('does not reject a source cache for unreferenced DEV files outside the semantic graph', async () => {
    const model = await fixture(), partial = structuredClone(model.sources);
    partial.graph.documents = partial.graph.documents.filter(document => document.path !== 'terminal.dev');
    partial.graph.records = partial.graph.records.filter(record => record.source !== 'terminal.dev')
      .map(record => ({ ...record, sources: record.sources.filter(path => path !== 'terminal.dev') }));
    partial.graph.references = partial.graph.references.filter(reference => reference.value !== 'terminal.dev');
    expect(engineeringSourceCacheMatchesFiles(partial, ['project.cbm', 'unit.dev', 'terminal.dev'])).toBe(true);
  });

  it('accepts a one-shot iterator only after materializing the delivered inventory once', async () => {
    const model = await fixture();
    expect(engineeringSourceCacheMatchesFiles(model.sources, new Map([['project.cbm', 1], ['unit.dev', 1], ['terminal.dev', 1]]).keys())).toBe(true);
  });

  it('rejects a decoded DEV-only source body when delivered IFC files are present', async () => {
    const model = await fixture();
    const partial = structuredClone(model.sources);
    partial.graph.ifcPaths = ['delivery.ifc'];
    partial.models = [];
    partial.ifcRecords = [];
    expect(engineeringSourceCacheMatchesFiles(partial, ['project.cbm', 'delivery.ifc'])).toBe(false);
    partial.models = [{ modelId: 'm', path: 'delivery.ifc' }];
    partial.ifcRecords = [{} as never];
    expect(engineeringSourceCacheMatchesFiles(partial, ['project.cbm', 'delivery.ifc'])).toBe(true);
  });

  it('marks an over-budget cache as explicitly disabled, not an error-only failure', () => {
    const result = {} as EngineeringBuildResult;
    markCacheFailure(result, Error('工程缓存无效：plain size'));
    expect(result.cacheError).toContain('plain size');
    expect(result.cacheDisabled).toContain('384 MiB');
  });

  it('rejects source/parser/inventory changes and corrupt bytes', async () => {
    const model = await fixture(), encoded = await encodeEngineeringSources(model.sources, id);
    for (const changed of [{ ...id, sourceSha256: 'b'.repeat(64) }, { ...id, parserVersion: 'changed' }, { ...id, entries: ['missing.cbm'] }]) {
      await expect(decodeEngineeringSources(encoded.bytes, changed)).rejects.toThrow('工程缓存无效');
    }
    const broken = encoded.bytes.slice(); broken[broken.length - 1] ^= 1;
    await expect(decodeEngineeringSources(broken, id)).rejects.toThrow('checksum');
    await expect(decodeEngineeringSources(encoded.bytes.subarray(0, 3), id)).rejects.toThrow('size');
    expect(() => engineeringCacheEntry({ ...id, sourceSha256: '../bad' }, 'sources')).toThrow('source identity');
  });

  it('binds entity artifacts to the exact source artifact and rejects lost memberships', async () => {
    const model = await fixture(), encoded = await encodeEngineeringSources(model.sources, id);
    const sources = await decodeEngineeringSources(encoded.bytes, id);
    const entities = await encodeEngineeringEntities(model.snapshot, sources, id);
    await expect(decodeEngineeringEntities(entities, { ...sources, digest: 'different-source-body' }, id)).rejects.toThrow('input dependencies');
    model.snapshot.memberships.pop();
    await expect(encodeEngineeringEntities(model.snapshot, sources, id)).rejects.toThrow('incomplete');
  });

  it('rejects a source snapshot with documents outside the delivered inventory', async () => {
    const model = await fixture();
    await expect(encodeEngineeringSources(model.sources, { ...id, entries: ['project.cbm', 'unit.dev'] })).rejects.toThrow('source documents');
  });

  it('refuses invalid entity field types before an artifact can be published', async () => {
    const model = await fixture(), encoded = await encodeEngineeringSources(model.sources, id);
    const source = await decodeEngineeringSources(encoded.bytes, id);
    (model.snapshot.entities[0] as unknown as { name: unknown }).name = 123;
    await expect(encodeEngineeringEntities(model.snapshot, source, id)).rejects.toThrow('shape is invalid');
  });

  it('keeps incomplete sources browsable without publishing a complete cache', async () => {
    const missingIfc = await fixture({ 'unlinked.ifc': 'IFC' });
    expect(missingIfc.sources.complete).toBe(false);
    expect(missingIfc.snapshot.entities).toHaveLength(2);
    await expect(encodeEngineeringSources(missingIfc.sources, id)).rejects.toThrow('incomplete sources');
    const missingPart = await fixture({ 'unit.dev': 'SYMBOLNAME=主变压器\nSUBDEVICE0=absent.dev' });
    expect(missingPart.sources.incompleteReasons).toContain('source-reference-unresolved');
    await expect(encodeEngineeringSources(missingPart.sources, id)).rejects.toThrow('incomplete sources');
  });

  it('bounds decompression by the declared size', async () => {
    const encoded = await encodeEngineeringSources((await fixture()).sources, id);
    const length = new DataView(encoded.bytes.buffer).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(encoded.bytes.subarray(4, 4 + length)));
    const changed = new TextEncoder().encode(JSON.stringify({ ...header, plainBytes: 1 }));
    const invalid = new Uint8Array(4 + changed.length + encoded.bytes.length - 4 - length);
    new DataView(invalid.buffer).setUint32(0, changed.length, true);
    invalid.set(changed, 4); invalid.set(encoded.bytes.subarray(4 + length), 4 + changed.length);
    await expect(decodeEngineeringSources(invalid, id)).rejects.toThrow('expanded size');
  });
});
