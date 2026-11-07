import {expect,it} from 'vitest';
import {AppState} from '../../app/state.js';
import {perfMarkProductMoment,perfReset} from '../../utils/perfTimings.js';
import {benchmarkEvidence,benchmarkProgress} from '../modelEvidence.js';

it('waits for line persistence and substation spatial work without changing automatic response timing',async()=>{
  perfReset();const state=new AppState();state.currentProjectType='transmission_line';
  state.currentGimGraph={nodesByPath:new Map()} as never;
  state.lineCachePersistence='saving';
  expect(benchmarkProgress(state)).toMatchObject({automaticSettled:true,cacheSettled:false});
  state.lineCachePersistence='saved';
  expect(benchmarkProgress(state)).toMatchObject({automaticSettled:true,cacheSettled:true});
  state.lineCachePersistence='failed';
  expect(benchmarkProgress(state).cache).toMatchObject({writeFailures:1,linePersistence:'failed'});
  expect((await benchmarkEvidence(state)).checks.find(row=>row.name==='line-cache-persistence')?.passed).toBe(false);

  state.currentProjectType='substation';state.currentIfcEntries=[{path:'source.ifc',name:'source',modelId:'model'}];
  expect(benchmarkProgress(state).backgroundSettled).toBe(false);
  perfMarkProductMoment('spatialSemanticReady',{available:true});
  expect(benchmarkProgress(state).backgroundSettled).toBe(true);
  perfReset();perfMarkProductMoment('spatialSemanticReady',{available:false});
  expect(benchmarkProgress(state).backgroundStatus).toBe('failed');
  expect((await benchmarkEvidence(state)).checks.find(row=>row.name==='background-spatial-available')?.passed).toBe(false);
  perfReset();
});

it('reports failure reasons without exporting private DEV paths or raw diagnostics',async()=>{
  perfReset();const state=new AppState();state.geometryDiagnosticsByDevPath.set('DEV/private-model.dev',{
    devPath:'DEV/private-model.dev',status:'failed',source:'cold',reason:'source-invalid',unsupportedPrimitiveTypeCounts:{},failedVisibleRootCount:14,
    detail:'private source information',
  });
  const evidence=await benchmarkEvidence(state);
  expect(evidence.geometryDiagnostics).toMatchObject({templates:1,statuses:{failed:1},reasons:{'source-invalid':1},failedVisibleRoots:14});
  expect(JSON.stringify(evidence)).not.toContain('private-model');
  expect(JSON.stringify(evidence)).not.toContain('private source information');
  perfReset();
});
