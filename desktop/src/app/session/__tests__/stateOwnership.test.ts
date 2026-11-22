import {expect,it,vi} from 'vitest';
import {AppState} from '../../state.js';

it('resets source/loading/cache owners in the real project lifecycle while retaining cache Map identities',()=>{
  const state=new AppState(),session=state.activateProject(1,'old'),scope=state.sessionScope(session);
  const cache=state.properties,maps=Object.values(cache);
  cache.cachedIfcPaths.set('model.ifc','cache/model.ifc');
  cache.cachedFamSourceProperties.set('a.fam',[]);
  cache.cachedFamProperties.set('a.fam',new Map());
  cache.cachedDevProperties.set('a.dev',{TYPE:'Body'});
  cache.cachedLineFamProperties.set('line.fam',new Map());
  cache.cachedLineFamDisplayKeys.set('line.fam',new Map());
  cache.cachedLineDevProperties.set('line.dev',new Map());
  state.sourceGeometry.catalog={occurrences:[],diagnostics:[]};
  state.sourceGeometry.ready=Promise.resolve(state.sourceGeometry.catalog);
  state.sourceGeometry.cachePending=true;state.sourceGeometry.cacheError='old write';
  state.ifcLoading.pending=true;state.ifcLoading.skippedLargeIfc=['large.ifc'];
  state.resetGimState();
  expect(scope.signal.aborted).toBe(true);expect(state.isCurrentSession(session)).toBe(false);
  expect(state.sourceGeometry.catalog).toBeNull();expect(state.sourceGeometry.ready).toBeNull();
  expect(state.sourceGeometry.cachePending).toBe(false);expect(state.sourceGeometry.cacheError).toBe('');
  expect(state.ifcLoading.pending).toBe(false);expect(state.ifcLoading.skippedLargeIfc).toEqual([]);
  for(const [index,map]of maps.entries()){expect(Object.values(cache)[index]).toBe(map);expect(map.size).toBe(0);}
});

it('does not release a replacement installed synchronously by an outgoing scope disposer', () => {
  const state = new AppState();
  const old = state.activateProject(1, 'old');
  const releaseOld = vi.fn(), releaseNew = vi.fn();
  const runtime = (release: () => void) => ({ release, clearSelection: vi.fn(), select: vi.fn(), diagnostics: {} });
  state.deviceLodRuntime = runtime(releaseOld);
  const replacement = runtime(releaseNew);
  state.sessionScope(old).own(() => {
    state.activateProject(2, 'new');
    state.deviceLodRuntime = replacement;
  });
  state.invalidatePendingLoads();
  expect(state.currentProjectId).toBe(2);
  expect(state.deviceLodRuntime).toBe(replacement);
  expect(releaseOld).toHaveBeenCalledOnce();
  expect(releaseNew).not.toHaveBeenCalled();
  state.resetGimState();
  expect(releaseNew).toHaveBeenCalledOnce();
  expect(state.isCurrentSession(state.captureProjectSession())).toBe(true);
});

it('rejects selection work during a transition and admits fresh selection after activation', () => {
  const state = new AppState();
  state.activateProject(1, 'old');
  const old = state.selection.beginSelection({ kind: 'cbm', key: 'old' });
  state.invalidatePendingLoads();
  expect(old.signal.aborted).toBe(true);
  const duringClose = state.selection.beginSelection({ kind: 'cbm', key: 'closing' });
  expect(duringClose.signal.aborted).toBe(true);
  expect(state.selection.selectionRequest).toBeNull();
  state.activateProject(2, 'new');
  const fresh = state.selection.beginSelection({ kind: 'cbm', key: 'new' });
  expect(state.selection.isCurrentSelection(fresh)).toBe(true);
  expect(state.selection.isCurrentSelection(old)).toBe(false);
});

it('releases active selection visibility once across successive transition stages', () => {
  const state = new AppState();
  state.activateProject(1, 'old');
  const reset = vi.fn();
  state.selection.selectionVisibility = { reset, sync: vi.fn(), registerModel: vi.fn(), removeModel: vi.fn(), setModelVisible: vi.fn() };
  state.projectSession.beginOpen();
  const cleaning = state.invalidatePendingLoads();
  expect(state.finishProjectCleanup(cleaning, false)).toBe(true);
  state.activateProject(2, 'new');
  expect(reset).toHaveBeenCalledOnce();
});
