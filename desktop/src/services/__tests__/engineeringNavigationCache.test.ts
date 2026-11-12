// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { extractEngineeringSourceGraph } from '../../gim/engineering/sourceGraph.js';
import { buildEngineeringSources } from '../../gim/engineering/buildSources.js';
import { projectEngineeringNavigation } from '../../gim/engineering/navigation.js';
import { decodeEngineeringSources, encodeEngineeringSources } from '../engineeringCacheCodec.js';
import { applyNavigationCacheProjection, createNavigationCacheProjection, decodeEngineeringNavigation, encodeEngineeringNavigation } from '../engineeringNavigationCache.js';

async function fixture() {
  const raw: Record<string, string> = { 'project.cbm': 'OBJECTMODELPOINTER=unit.dev', 'unit.dev': 'SYMBOLNAME=主变压器\nSUBDEVICE0=terminal.dev', 'terminal.dev': 'SYMBOLNAME=端子箱' };
  const id = { sourceSha256: 'a'.repeat(64), parserVersion: 'test', entries: Object.keys(raw) };
  const graph = await extractEngineeringSourceGraph({ paths: id.entries, readText: async path => raw[path] });
  const built = buildEngineeringSources(id.sourceSha256, graph, [], []), view = projectEngineeringNavigation(built.sources, built.snapshot);
  const encoded = await encodeEngineeringSources(built.sources, id), source = await decodeEngineeringSources(encoded.bytes, id);
  return { ...built, view, id, source };
}
describe('independent navigation cache', () => {
  it('returns only composition and search suffixes while preserving identical cache bytes and explicit search identities',async()=>{
    const f=await fixture(),base=f.view;
    const largeText='immutable inventory search '.repeat(500);
    base.inventorySearch![0].searchText=largeText;
    const refined={...base,compositionComplete:true,compositionCoverage:'full' as const,
      composition:structuredClone(base.composition),compositionSearch:[...base.compositionSearch].reverse().map(row=>({...row,subtitle:'空间上下文',searchText:row.searchText+'\n空间上下文'}))};
    const patch=createNavigationCacheProjection(base,refined);
    expect(Object.keys(patch).sort()).toEqual(['composition','compositionComplete','compositionCoverage','search']);
    expect(JSON.stringify(patch)).not.toContain(largeText);
    const workerBase=structuredClone(base),merged=applyNavigationCacheProjection(workerBase,structuredClone(patch));
    expect(merged).toEqual(refined);expect(merged.inventory).toBe(workerBase.inventory);expect(merged.sourceNodes).toBe(workerBase.sourceNodes);
    expect(merged.compositionSearch.map(row=>row.key)).toEqual(refined.compositionSearch.map(row=>row.key));
    const original=await encodeEngineeringNavigation(refined,f.sources,f.snapshot,f.source.digest,f.id);
    expect(await encodeEngineeringNavigation(merged,f.sources,f.snapshot,f.source.digest,f.id)).toEqual(original);
    expect(await decodeEngineeringNavigation(original,f.sources,f.snapshot,f.source.digest,f.id)).toEqual(refined);
  });
  it('rejects foreign/duplicate search identities and changes outside composition instead of dropping data',async()=>{
    const {view:base}=await fixture();
    base.compositionSearch.push({...base.compositionSearch[0],key:'second-transport-identity'});
    const patch=createNavigationCacheProjection(base,base),reordered=structuredClone(patch);reordered.search.reverse();
    expect(applyNavigationCacheProjection(base,reordered).compositionSearch.map(row=>row.key)).toEqual(reordered.search.map(row=>row.key));
    for(const key of ['absent',patch.search[0].key]){
      const bad=structuredClone(patch);bad.search[1].key=key;
      expect(()=>applyNavigationCacheProjection(base,bad)).toThrow('projection search identity');
    }
    expect(()=>applyNavigationCacheProjection(base,{...patch,search:[]})).toThrow('projection search coverage');
    expect(()=>createNavigationCacheProjection(base,{...base,sourceNodes:new Map(base.sourceNodes)})).toThrow('projection base changed');
    const changed=structuredClone(base.compositionSearch);changed[0].searchText='replacement without original text';
    expect(()=>createNavigationCacheProjection(base,{...base,compositionSearch:changed})).toThrow('projection search identity / prefix');
  });
  it('round trips both projections and source/entity references', async () => {
    const f = await fixture(), bytes = await encodeEngineeringNavigation(f.view, f.sources, f.snapshot, f.source.digest, f.id);
    expect(await decodeEngineeringNavigation(bytes, f.sources, f.snapshot, f.source.digest, f.id)).toEqual(f.view);
    expect(f.view.sourceNodes.get(f.view.sourceRoot)?.children).toHaveLength(2);
    const restored=await decodeEngineeringNavigation(bytes, f.sources, f.snapshot, f.source.digest, f.id);
    expect([...restored.composition.nodes.values()].every(node=>!('evidence' in node))).toBe(true);
    expect(restored.compositionInput?.declarations.every(row=>!('evidence' in row))).toBe(true);
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
  it('rejects stale independent template versions and missing inventory search',async()=>{
    const f=await fixture();f.view.projectionVersions!.inventory='stale-inventory';
    await expect(encodeEngineeringNavigation(f.view,f.sources,f.snapshot,f.source.digest,f.id)).rejects.toThrow('projection versions');
    const fresh=projectEngineeringNavigation(f.sources,f.snapshot);fresh.inventorySearch=[];
    await expect(encodeEngineeringNavigation(fresh,f.sources,f.snapshot,f.source.digest,f.id)).rejects.toThrow('inventory search');
  });
});
