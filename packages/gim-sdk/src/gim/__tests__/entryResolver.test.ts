import { expect, it, vi } from 'vitest';
import { createEntryIndex, createEntryResolver, getFileEntryResolver, sourceReferenceCandidates } from '../entryResolver.js';

it('resolves actual relative/global paths and refuses ambiguous or case-colliding entries', () => {
  const resolve = createEntryResolver(['assets/unit.dev', 'shared/item.phm', 'left/item.mod', 'right/item.mod', 'A.dev', 'a.dev']);
  expect(resolve('../shared/item.phm', 'assets/unit.dev')).toBe('shared/item.phm');
  expect(resolve('UNIT.DEV')).toBe('assets/unit.dev');
  expect(resolve('item.mod')).toBeNull(); expect(resolve('item.mod', 'right/part.phm')).toBe('right/item.mod');
  expect(resolve('A.dev')).toBeNull(); expect(resolve('missing.mod')).toBeNull();
});

it('reuses the archive index during hydration and isolates changed inventories', () => {
  const files = new Map<string, unknown>([['left/item.mod', 'original']]);
  const keys = vi.spyOn(files, 'keys');
  const resolve = getFileEntryResolver(files);
  files.set('left/item.mod', 'hydrated');
  for (let request = 0; request < 256; request++) {
    expect(getFileEntryResolver(files)).toBe(resolve);
    expect(getFileEntryResolver(files)('ITEM.MOD', 'left/part.dev')).toBe('left/item.mod');
  }
  expect(keys).toHaveBeenCalledTimes(1);
  files.set('right/item.mod', 'other');
  expect(getFileEntryResolver(files)('item.mod')).toBeNull();
  expect(keys).toHaveBeenCalledTimes(2);
  expect(getFileEntryResolver(new Map([['other/item.mod', 'new source']]))('item.mod')).toBe('other/item.mod');
});

it('resolves the IFC exporter suffix only for IFC targets, preserving ambiguity',()=>{
 const index=createEntryIndex(['A/model.IFC','B/model.IFC','A/part.dev']);
 expect(sourceReferenceCandidates(index,'model.ifc$','A/network.cbm')).toEqual(['A/model.IFC']);
 expect(sourceReferenceCandidates(index,'model.ifc$','project.cbm')).toHaveLength(2);
 expect(sourceReferenceCandidates(index,'part.dev$','A/network.cbm')).toEqual([]);
});
