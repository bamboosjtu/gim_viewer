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
  expect(benchmarkProgress(state)).toMatchObject({semantic:false,backgroundSettled:false,cacheSettled:false});
  state.engineeringStatus='ready';
  expect(benchmarkProgress(state).backgroundSettled).toBe(true);
  state.engineeringStatus='error';
  expect(benchmarkProgress(state)).toMatchObject({semantic:false,semanticFailure:true,backgroundSettled:false});
  perfReset();perfMarkProductMoment('spatialSemanticReady',{available:false});
  expect(benchmarkProgress(state).backgroundStatus).toBe('failed');
  expect((await benchmarkEvidence(state)).checks.find(row=>row.name==='background-spatial-available')?.passed).toBe(false);
  perfReset();
});

it('reports failure reasons without exporting private DEV paths or raw diagnostics',async()=>{
  perfReset();const state=new AppState();state.geometryDiagnosticsByDevPath.set('DEV/private-model.dev',{
    devPath:'DEV/private-model.dev',status:'failed',source:'cold',reason:'source-invalid',unsupportedPrimitiveTypeCounts:{},failedVisibleRootCount:14,
    detail:'source-origin-span-v1: private source information',
  });
  state.geometryDiagnosticsByDevPath.set('DEV/empty-model.dev',{
    devPath:'DEV/empty-model.dev',status:'empty',source:'cold',reason:'phm-no-solidmodel',unsupportedPrimitiveTypeCounts:{},
  });
  const evidence=await benchmarkEvidence(state);
  expect(evidence.geometryDiagnostics).toMatchObject({templates:2,statuses:{failed:1,empty:1},nonFailureReasons:{'phm-no-solidmodel':1}});
  expect(evidence.geometryStatuses).toEqual({failed:1,empty:1});
  expect(evidence.failedGeometryReasons).toEqual({'source-invalid':1});
  expect(evidence.geometryDefects).toMatchObject({failedSourceCount:1,failedVisibleRoots:14,failedReasons:{'source-invalid':1},sourceEvidenceComplete:true});
  expect(evidence.geometryDefects.failedSourceSetDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(evidence)).not.toContain('private-model');
  expect(JSON.stringify(evidence)).not.toContain('private source information');
  perfReset();
});
