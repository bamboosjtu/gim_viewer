import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {BoxGeometry,Group,Mesh,MeshBasicMaterial} from 'three';
import {AppState} from '../../app/state.js';
import {perfMarkProductMoment,perfReset} from '../../utils/perfTimings.js';
import {benchmarkEvidence,benchmarkProgress} from '../modelEvidence.js';
it('progress freezes mutable LOD counters across asynchronous evidence collection',()=>{
  const state=new AppState(),hits=[1,0,0],misses=[0,2,0];
  state.deviceLodRuntime={diagnostics:{lodHits:hits,lodMisses:misses},release(){}} as never;
  const progress=benchmarkProgress(state);hits[1]=3;misses[1]=4;
  expect(progress.cache.devLodHits).toEqual([1,0,0]);expect(progress.cache.devLodMisses).toEqual([0,2,0]);
  state.deviceLodRuntime=null;
});

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
  state.engineering.status='ready';
  state.engineering.treeStatus='ready';
  expect(benchmarkProgress(state).backgroundSettled).toBe(true);
  state.engineering.buildPending=true;
  expect(benchmarkProgress(state)).toMatchObject({semantic:true,engineeringBuildPending:true,
    backgroundSettled:false,cacheSettled:false,automaticSettled:false});
  state.engineering.buildPending=false;
  state.engineering.status='error';
  expect(benchmarkProgress(state)).toMatchObject({semantic:false,semanticFailure:true,backgroundSettled:false});
  state.engineering.status='partial';state.engineering.failureCode='engineering-build-failed';
  expect(benchmarkProgress(state).semanticFailure).toBe(true);
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

it('keeps the original geometry digest when roots have overlapping sort prefixes', async () => {
  const state = new AppState();
  const geometry = new BoxGeometry(2, 2, 2);
  const material = new MeshBasicMaterial();
  geometry.computeBoundingBox();
  const rows = [
    { id: 'root,0,9', lod: 1, root: new Group() },
    { id: 'root', lod: 0, root: new Group() },
    { id: 'aaa', lod: 0, root: new Group() },
  ];
  const matrices = rows.map(({root}, i) => {
    const mesh = new Mesh(geometry, material);
    mesh.position.x = i;
    root.add(mesh);
    root.updateMatrixWorld(true);
    return mesh.matrixWorld.toArray();
  });
  state.deviceLodRuntime = {
    diagnostics: { shown: rows.length },
    forEachLoadedRoot(visit: (occurrence: string, root: Group, lod: number) => void) {
      for (const {id, root, lod} of rows) visit(id, root, lod);
    },
    release() {},
  } as unknown as typeof state.deviceLodRuntime;

  const canonical = rows.map(({id, lod}, i) => [
    id, lod, [[24, 36, [-1,-1,-1,1,1,1], matrices[i]]],
  ]).sort();
  const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const evidence = await benchmarkEvidence(state);
  expect(evidence.geometry).toMatchObject({ roots: 3, meshes: 3, geometries: 1, materials: 1 });
  expect(evidence.geometryStructuralFingerprint).toBe(digest);
  geometry.dispose();
  material.dispose();
});

it('preserves canonical semantic evidence bytes across serialization pages', async () => {
  const state = new AppState();
  const memberships = Array.from({length: 300}, (_, i) => ({
    sourceId: `来源 "${300 - i}"`,
    ownerId: null,
    disposition: 'source_only',
    interpretation: {category: 'U-OBJECT', meaning: 'source_only'},
  }));
  state.engineering.snapshot = {
    entities: [], pending: [], relationships: [], memberships,
  } as unknown as typeof state.engineering.snapshot;
  const membershipRows = memberships.map(({sourceId, ownerId, disposition, interpretation}) =>
    [sourceId, ownerId, disposition, interpretation.category, interpretation.meaning, null],
  ).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const canonical = {entities: [], pending: [], memberships: membershipRows, relationships: []};
  const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  expect((await benchmarkEvidence(state)).semanticDigest).toBe(digest);
});
