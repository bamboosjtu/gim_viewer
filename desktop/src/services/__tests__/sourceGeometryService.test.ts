import { expect, it } from 'vitest';
import { AppState } from '../../app/state.js';
import { getSourceGeometryOccurrences } from '../sourceGeometryService.js';

it('waits for physical source readiness only and discards an old-session occurrence result', async () => {
  const state = new AppState(), session = state.activateProject(1, 'old'); state.currentProjectType = 'substation';
  let publish!: (value: { occurrences: []; diagnostics: [] }) => void;
  state.sourceGeometryReady = new Promise(resolve => { publish = resolve; });
  const result = getSourceGeometryOccurrences(state, session);
  state.activateProject(2, 'new'); publish({ occurrences: [], diagnostics: [] });
  expect(await result).toEqual([]); expect(state.sourceGeometryCatalog).toBeNull();
});
