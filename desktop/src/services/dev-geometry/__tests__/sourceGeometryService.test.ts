import { expect, it } from 'vitest';
import { AppState } from '../../../app/state.js';
import { getSourceGeometryOccurrences } from '../sourceGeometryService.js';

it('waits for physical source readiness only and discards an old-session occurrence result', async () => {
  const state = new AppState(), session = state.activateProject(1, 'old'); state.currentProjectType = 'substation';
  let publish!: (value: { occurrences: []; diagnostics: [] }) => void;
  state.sourceGeometry.ready = new Promise(resolve => { publish = resolve; });
  const result = getSourceGeometryOccurrences(state, session);
  state.activateProject(2, 'new'); publish({ occurrences: [], diagnostics: [] });
  expect(await result).toEqual([]); expect(state.sourceGeometry.catalog).toBeNull();
});
it('returns the published physical catalog without copying it or waiting for semantic readiness',async()=>{
  const state=new AppState(),session=state.activateProject(1,'source');state.currentProjectType='substation';
  const occurrences:[]=[];state.sourceGeometry.catalog={occurrences,diagnostics:[]};
  state.engineering.buildPending=true;
  expect(await getSourceGeometryOccurrences(state,session)).toBe(occurrences);
});
it('distinguishes a current missing physical catalog from an obsolete request',async()=>{
  const state=new AppState(),old=state.activateProject(1,'old');state.currentProjectType='substation';
  const current=state.activateProject(2,'new');
  await expect(getSourceGeometryOccurrences(state,old)).resolves.toEqual([]);
  await expect(getSourceGeometryOccurrences(state,current)).rejects.toThrow('来源物理实例尚不可用');
});
