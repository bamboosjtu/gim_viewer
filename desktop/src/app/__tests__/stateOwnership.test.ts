import {expect,it} from 'vitest';
import {AppState} from '../state.js';

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
