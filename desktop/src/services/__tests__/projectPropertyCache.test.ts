import { expect, it, vi } from 'vitest';
import { ProjectPropertyCache } from '../projectPropertyCache.js';
import { buildInspectorSummary, inspectNodeParameters } from '../inspectorService.js';
import { AppState } from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';

function row(path: string, value: string, line = 1) {
  return {
    source_path: path,
    section_name: '设计',
    prop_key: '材质',
    prop_value: value,
    raw_property_json: JSON.stringify({ label: '材质', rawValue: value, sourceLine: line }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('loads only inspected families, keeping duplicates, section precedence and empty files', async () => {
  const cache = new ProjectPropertyCache();
  const sources = new Set(['DEV/a.fam', 'DEV/empty.fam', 'DEV/unrequested.fam']);
  const read = vi.fn(async () => [row('DEV/a.fam', '铝'), row('DEV/a.fam', '铝', 2), row('DEV/a.fam', '铜', 3)]);
  cache.setWarmFamReader(path => sources.has(path) ? path : null, read);

  expect(cache.cachedFamProperties.size).toBe(0);
  expect(read).not.toHaveBeenCalled();
  await Promise.all([
    cache.loadWarmFamProperties(['DEV/a.fam', 'DEV/empty.fam']),
    cache.loadWarmFamProperties(['DEV/a.fam', 'missing.fam']),
  ]);
  expect(read).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledWith(['DEV/a.fam', 'DEV/empty.fam']);
  expect(cache.cachedFamSourceProperties.get('DEV/a.fam')?.map(property => property.rawValue)).toEqual(['铝', '铝', '铜']);
  expect(cache.cachedFamProperties.get('DEV/a.fam')?.get('设计')?.get('材质')).toBe('铜');
  expect(cache.cachedFamSourceProperties.get('DEV/empty.fam')).toEqual([]);
  expect(cache.cachedFamProperties.has('DEV/unrequested.fam')).toBe(false);
  await cache.loadWarmFamProperties(['DEV/a.fam', 'DEV/empty.fam']);
  expect(read).toHaveBeenCalledTimes(1);
});

it('reloads the requested source if property repair invalidates an in-flight read', async () => {
  const cache = new ProjectPropertyCache();
  const old = deferred<ReturnType<typeof row>[]>();
  const read = vi.fn<() => Promise<ReturnType<typeof row>[]>>()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue([row('a.fam', 'new')]);
  cache.setWarmFamReader(path => path, read);
  const pending = cache.loadWarmFamProperties(['a.fam']);
  expect(cache.invalidateWarmFamProperties()).toBe(true);
  old.resolve([row('a.fam', 'old')]);
  await pending;
  expect(read).toHaveBeenCalledTimes(2);
  expect(cache.cachedFamProperties.get('a.fam')?.get('设计')?.get('材质')).toBe('new');
});

it('discards a late family read after resets or project replacement', async () => {
  const cache = new ProjectPropertyCache();
  const old = deferred<ReturnType<typeof row>[]>();
  cache.setWarmFamReader(path => path, () => old.promise);
  const pending = cache.loadWarmFamProperties(['a.fam']);
  cache.reset();
  const next = vi.fn(async () => [row('a.fam', 'new project')]);
  cache.setWarmFamReader(path => path, next);
  old.resolve([row('a.fam', 'old project')]);
  await pending;
  expect(next).not.toHaveBeenCalled();
  expect(cache.cachedFamProperties.size).toBe(0);
  await cache.loadWarmFamProperties(['a.fam']);
  expect(cache.cachedFamProperties.get('a.fam')?.get('设计')?.get('材质')).toBe('new project');
});

it('uses SQLite family evidence for both the warm inspector summary and parameter details', async () => {
  const state = new AppState();
  const path = 'CBM/device.fam';
  const node: CbmNode = {
    path: 'CBM/device.cbm', name: 'cbm label', entityName: 'F4System', children: [],
    famPath: 'device.fam', devPath: '', ifcFile: '', ifcGuid: '', classifyName: '',
    transformMatrix: '', systemNames: [], devSymbolName: '', devType: '', devExpanded: false,
  };
  const read = vi.fn(async () => [{ ...row(path, '实物名称'), prop_key: '工程中名称' }]);
  state.properties.setWarmFamReader(request => request === path ? path : null, read);

  const summary = await buildInspectorSummary(state, node);
  const details = await inspectNodeParameters(state, node);

  expect(read).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledWith([path]);
  expect(summary.name).toBe('实物名称');
  expect(details.cbmFamilies[0]?.properties[0]?.rawValue).toBe('实物名称');
});
