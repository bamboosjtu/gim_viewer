// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { extractEngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { buildEngineeringSources } from '../../gim/engineering/buildSources.js';
import { projectEngineeringNavigation } from '../../gim/engineering/navigation.js';
import { decodeEngineeringSources, encodeEngineeringSources } from '../engineeringCacheCodec.js';
import { decodeEngineeringNavigation, encodeEngineeringNavigation } from '../engineeringNavigationCache.js';

async function fixture() {
  const raw: Record<string, string> = { 'project.cbm': 'OBJECTMODELPOINTER=unit.dev', 'unit.dev': 'SYMBOLNAME=主变压器\nSUBDEVICE0=terminal.dev', 'terminal.dev': 'SYMBOLNAME=端子箱' };
  const id = { sourceSha256: 'a'.repeat(64), parserVersion: 'test', entries: Object.keys(raw) };
  const graph = await extractEngineeringSourceGraph({ paths: id.entries, readText: async path => raw[path] });
  const built = buildEngineeringSources(id.sourceSha256, graph, [], []), view = projectEngineeringNavigation(built.sources, built.snapshot);
  const encoded = await encodeEngineeringSources(built.sources, id), source = await decodeEngineeringSources(encoded.bytes, id);
  return { ...built, view, id, source };
}
describe('independent navigation cache', () => {
  it('round trips both projections and source/entity references', async () => {
    const f = await fixture(), bytes = await encodeEngineeringNavigation(f.view, f.sources, f.snapshot, f.source.digest, f.id);
    expect(await decodeEngineeringNavigation(bytes, f.sources, f.snapshot, f.source.digest, f.id)).toEqual(f.view);
    expect(f.view.sourceNodes.get(f.view.sourceRoot)?.children).toHaveLength(2);
  });
  it('rejects changed normalized membership or source contents even when the package identity is unchanged', async () => {
    const f = await fixture(), bytes = await encodeEngineeringNavigation(f.view, f.sources, f.snapshot, f.source.digest, f.id);
    const changed = structuredClone(f.snapshot); changed.entities[0].name = 'changed';
    await expect(decodeEngineeringNavigation(bytes, f.sources, changed, f.source.digest, f.id)).rejects.toThrow('input dependencies');
    await expect(decodeEngineeringNavigation(bytes, f.sources, f.snapshot, 'different-source', f.id)).rejects.toThrow('input dependencies');
  });
  it('refuses a lost entity reference, an unknown source or an unreachable branch before publishing', async () => {
    const f = await fixture(); f.view.composition.rowsByEntity.delete(f.snapshot.entities[0].id);
    await expect(encodeEngineeringNavigation(f.view, f.sources, f.snapshot, f.source.digest, f.id)).rejects.toThrow('entity coverage');
    const view = projectEngineeringNavigation(f.sources, f.snapshot), row = view.sourceRows.values().next().value!;
    view.sourceNodes.get(row)!.sourceId = 'absent';
    await expect(encodeEngineeringNavigation(view, f.sources, f.snapshot, f.source.digest, f.id)).rejects.toThrow('source reference');
    const orphan = projectEngineeringNavigation(f.sources, f.snapshot); orphan.sourceNodes.get(orphan.sourceRoot)!.children = [];
    await expect(encodeEngineeringNavigation(orphan, f.sources, f.snapshot, f.source.digest, f.id)).rejects.toThrow('unreachable rows');
  });
  it('requires the complete precompiled engineering search index before publishing', async () => {
    const f = await fixture();
    expect(f.view.compositionSearch.every(item => item.searchText === item.searchText.toLowerCase())).toBe(true);
    delete (f.view.compositionSearch[0] as Partial<typeof f.view.compositionSearch[number]>).searchText;
    await expect(encodeEngineeringNavigation(f.view, f.sources, f.snapshot, f.source.digest, f.id)).rejects.toThrow('engineering search text');
  });
});
