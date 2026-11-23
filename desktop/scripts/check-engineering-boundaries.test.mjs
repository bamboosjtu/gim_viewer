import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceTemp } from './test-workspace.mjs';

function fixture() {
  const folder=mkdtempSync(join(workspaceTemp(),'boundary-cli-'));
  const files=(relative,content)=>{
    const path=join(folder,relative);
    mkdirSync(dirname(path),{recursive:true});
    writeFileSync(path,content);
  };
  for(const dir of ['desktop/bridge','app/src','packages/measurement-core/src',
    ...['engineering','gim','viewer','ui','services','app'].map(name=>`desktop/src/${name}`),
    ...['engineering','semantic','source','geometry','projection','adapters','shared'].map(name=>`packages/gim-sdk/src/${name}`),
    'desktop/scripts','desktop/node_modules'])mkdirSync(join(folder,dir),{recursive:true});
  symlinkSync(resolve('node_modules/typescript'),join(folder,'desktop/node_modules/typescript'),'junction');
  copyFileSync(resolve('package.json'),join(folder,'desktop/package.json'));
  for(const name of ['check-engineering-boundaries','core-boundaries','package-boundaries','presentation-boundaries','native-contract-boundaries','app-state-boundaries'])
    copyFileSync(resolve('scripts',`${name}.mjs`),join(folder,'desktop/scripts',`${name}.mjs`));
  copyFileSync(resolve('src/app/state.ts'),join(folder,'desktop/src/app/state.ts'));
  files('packages/gim-sdk/src/projection/projection.ts',"export {projectEngineeringComposition} from './composition.js';");
  files('desktop/src/measurement/core.ts',"export * from '@gim/measurement-core/source';");
  // The whitelisted viewer bridge imports must exist in the fixture so the
  // stale-entry detection accepts the live entries.
  files('desktop/src/viewer/ifcBimLoader.ts',"import '@desktop/ifcLodCache.js';\nexport {};");
  files('desktop/src/viewer/ifcRegionalRuntime.ts',"import '@desktop/ifcLodCache.js';\nexport {};");
  for(const name of [
    'devLodRuntime','devLodTemplateStore','devLodArtifactWriter','devLodSourceWorkset','devLodReadiness','devLodDiagnostics','devLodTypes'])
    files(`desktop/src/services/dev-geometry/${name}.ts`,'export {};');
  files('desktop/src/services/engineering/engineeringWorkerHandler.ts', 'export {};');
  files('desktop/src/services/project/ifcGeometrySource.ts', 'export {};');
  for (const name of ['engineeringWorkerClient', 'engineeringWorker', 'engineeringWorkerTransport', 'workerRequests'])
    files(`desktop/src/infrastructure/workers/${name}.ts`, 'export {};');
  for(const name of ['substationBackgroundRuntime','substationColdCore','substationDevRuntime','substationDocumentRuntime',
    'substationIfcRuntime','substationIndexPublication','substationSpatialRuntime',
    'substationSpatialSemanticCache','substationWarmAttempt','substationWarmCore','substationLoadingState'])
    files(`desktop/src/features/substation/runtime/${name}.ts`,'export {};');
  files('desktop/src/features/substation/application/substationRuntime.ts','export {};');
  files('desktop/src/features/substation/application/substationOpenStages.ts','export {};');
  files('desktop/src/features/substation/application/substationColdSource.ts','export {};');
  files('desktop/src/features/substation/application/substationColdPersistence.ts','export {};');
  files('desktop/src/features/substation/presentation/substationPresentation.ts','export {};');
  files('desktop/src/features/substation/runtime/substationRuntimeTelemetry.ts','export {};');
  for (const name of ['application/openEquipmentProject','runtime/equipmentSource','presentation/equipmentSelection','presentation/equipmentPresentationPort'])
    files(`desktop/src/features/equipment/${name}.ts`,'export {};');
  for (const name of ['substationIfcQueue', 'substationIfcModelLoad', 'substationIfcLoadProgress'])
    files(`desktop/src/features/substation/runtime/${name}.ts`, 'export {};');
  for (const name of ['application/openPowerlineProject','runtime/powerlineColdLoad','runtime/powerlineWarmRestore',
    'runtime/lineSourceState','runtime/lineParserInput','runtime/lineParserWorkerClient','runtime/lineParserWorker',
    'presentation/lineProjectProjection','presentation/linePresentationPort'])
    files(`desktop/src/features/powerline/${name}.ts`,'export {};');
  for(const name of ['spatialSemanticStarter','substationSpatialWorkflow','substationSpatialWorker','substationSpatialWorkerClient'])
    files(`desktop/src/features/substation/runtime/spatial/${name}.ts`,'export {};');
  const run=()=>spawnSync(process.execPath,[join(folder,'desktop/scripts/check-engineering-boundaries.mjs')],{
    cwd:folder,encoding:'utf8',windowsHide:true,env:process.env,
  });
  return {files,run};
}

test('checker accepts a valid fixture and rejects a forbidden reverse import',()=>{
  const {files,run}=fixture();
  const accepted=run();
  assert.equal(accepted.status,0,accepted.stderr);
  files('desktop/src/gim/model.ts',"import '../viewer/demo.js';");
  files('desktop/src/viewer/demo.ts','export {};');
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/forbidden import \.\.\/viewer\/demo\.js/);
});

test('checker rejects an AppState root field without a registered owner',()=>{
  const {files,run}=fixture();
  const source=readFileSync(resolve('src/app/state.ts'),'utf8');
  files('desktop/src/app/state.ts',source.replace('class AppState {','class AppState { unownedFeature = null;'));
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/unownedFeature has no AppState owner and release entry/);
});

test('checker rejects ui imports of measurement probes',()=>{
  const {files,run}=fixture();
  // layers.md lets ui consume only service results, pure types and whitelisted
  // selectors; map probes are injected by services through presentation ports.
  // Value imports are the reviewed violation; type-only imports stay banned
  // as well so probes cannot creep back in through erased edges.
  files('desktop/src/ui/demoBaseLayer.ts',"import {observeMap} from '../measurement/mapMeasurement.js';\nexport {};");
  files('desktop/src/ui/demoProbeTypes.ts',"import type {MapProbe} from '../measurement/mapMeasurement.js';\nexport {};");
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/ui[\\\/]demoBaseLayer\.ts: forbidden import \.\.\/measurement\/mapMeasurement\.js/);
  assert.match(rejected.stderr,/ui[\\\/]demoProbeTypes\.ts: forbidden import \.\.\/measurement\/mapMeasurement\.js/);
});

test('checker rejects SDK implementation imports',()=>{
  const {files,run}=fixture();
  files('desktop/src/gim/model.ts',"import type {SourceRecord} from '@gim/gim-sdk/source/sourceDocument.js';");
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/gim\/model\.ts: use the SDK capability export/);
});

test('checker rejects even a type-only Semantic import of raw source records',()=>{
  const {files,run}=fixture();
  files('packages/gim-sdk/src/semantic/recognition/facts.ts',
    "import type {SourceRecord} from '../../shared/sourceRecord.js';");
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/semantic\/recognition\/facts\.ts: Semantic must consume adapted facts/);
});

test('checker allows Semantic entry points but rejects Adapter access to catalog and decision internals',()=>{
  const {files,run}=fixture();
  files('packages/gim-sdk/src/adapters/reader.ts',[
    "import type {SourceFormatFacts} from '../semantic/recognition/sourceFormatFacts.js';",
    "import {resolveObjectEvidence} from '../semantic/recognition/objectEvidenceDecision.js';",
  ].join('\n'));
  const accepted=run();
  assert.equal(accepted.status,0,accepted.stderr);
  files('packages/gim-sdk/src/adapters/catalog.ts',[
    "import {standardTerms} from '../semantic/standardCatalog.js';",
    "export {prepareObjectDecision} from '../semantic/recognition/objectEvidenceCandidates.js';",
    "export const policy=()=>import('../semantic/catalog/sourceCompatibilityPolicy.json');",
  ].join('\n'));
  const rejected=run();
  assert.equal(rejected.status,1);
  for(const path of ['standardCatalog.js','objectEvidenceCandidates.js','sourceCompatibilityPolicy.json'])
    assert.ok(rejected.stderr.split('\n').some(line=>line.includes('Adapter may call only Semantic entry points')&&line.includes(path)),path);
});

test('checker rejects a cycle within a runtime family through dynamic dependencies',()=>{
  const {files,run}=fixture();
  files('desktop/src/features/substation/presentation/substationPresentation.ts',"export const load=()=>import('../runtime/substationIfcRuntime.js');");
  files('desktop/src/features/substation/runtime/substationIfcRuntime.ts',"export const load=()=>import('../presentation/substationPresentation.js');");
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/Circular runtime module dependency/);
});

test('checker prevents shared cleanup from depending on the substation Spatial worker', () => {
  const { files, run } = fixture();
  files('desktop/src/app/session/projectCleanup.ts',
    "export const load = () => import('../../features/substation/runtime/spatial/substationSpatialWorkerClient.js');");
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Spatial workflow and worker belong to the substation feature/);
  assert.match(rejected.stderr, /Session uses injected project routing and presentation ports/);
});

test('checker keeps feature entry wiring in host composition', () => {
  const { files, run } = fixture();
  files('desktop/src/app/composition/projectRuntimes.ts',
    "export const open = () => import('../../features/equipment/application/openEquipmentProject.js');");
  assert.equal(run().status, 0);
  files('desktop/src/ui/projectView.ts',
    "export const open = () => import('../app/composition/projectRuntimes.js');");
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Host composition is only entered by the application/);
});

test('checker prevents the cleanup coordinator from reaching the DOM shim or Viewer', () => {
  const { files, run } = fixture();
  files('desktop/src/app/session/projectCleanup.ts', [
    "import { container } from '../../services/presentation/dom.js';",
    "import { releaseProjectViewer } from '../../services/project/projectViewerLifecycle.js';",
    "export const load = () => import('../../viewer/viewerRuntime.js');",
    "export const closed = () => window.dispatchEvent(new Event('gim:project-closed'));",
  ].join('\n'));
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Session uses injected project routing and presentation ports.*presentation\/dom\.js/);
  assert.match(rejected.stderr, /Session uses injected project routing and presentation ports.*projectViewerLifecycle\.js/);
  assert.match(rejected.stderr, /Session uses injected project routing and presentation ports.*viewerRuntime\.js/);
  assert.match(rejected.stderr, /Session uses presentation ports instead of browser globals.*window/);
});

test('checker keeps Powerline parsing with its scope and projection construction outside UI', () => {
  const { files, run } = fixture();
  files('desktop/src/services/legacyCleanup.ts',
    "export const load=()=>import('../features/powerline/runtime/lineParserWorkerClient.js');");
  files('desktop/src/ui/lineTree.ts',
    "import {buildLineNavigationIndex} from '../features/powerline/presentation/lineNavigationProjection.js';");
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Powerline runtime belongs to the project scope/);
  assert.match(rejected.stderr, /UI consumes Powerline projections and selection queries/);
});

test('checker keeps equipment independent of station presentation and shared DEV startup independent of features', () => {
  const { files, run } = fixture();
  files('desktop/src/features/equipment/application/openEquipmentProject.ts',
    "const station = () => import('../../substation/presentation/substationPresentation.js');");
  files('desktop/src/services/dev-geometry/geometryOnlyRuntime.ts',
    "import { equipmentPresentationFor } from '../../features/equipment/presentation/equipmentPresentationPort.js';");
  files('desktop/src/services/dev-geometry/devLodRuntime.ts',
    "import { stationViewPolicy } from '../../features/substation/runtime/stationViewPolicy.js';");
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Equipment must not depend on another feature/);
  assert.match(rejected.stderr, /shared DEV geometry must stay independent of features/);
  assert.match(rejected.stderr, /devLodRuntime\.ts: shared DEV geometry must stay independent of features/);
});

test('checker keeps Worker infrastructure between host orchestration and worker-safe dependencies', () => {
  const { files, run } = fixture();
  files('desktop/src/features/powerline/runtime/lineParserWorkerClient.ts',
    "import { WorkerRequests } from '../../../infrastructure/workers/workerRequests.js';");
  files('desktop/src/infrastructure/workers/engineeringWorker.ts',
    "import { createEngineeringWorkerHandler } from '../../services/engineering/engineeringWorkerHandler.js';");
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  files('desktop/src/infrastructure/workers/engineeringWorkerClient.ts',
    "export const lazy = () => import('../../app/state.js'); import '../../services/engineering/engineeringService.js';");
  files('desktop/src/gim/model.ts',
    "import { EngineeringWorkerClient } from '../infrastructure/workers/engineeringWorkerClient.js';");
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Worker infrastructure cannot depend on host composition or rendering/);
  assert.match(rejected.stderr, /Worker infrastructure belongs to host orchestration/);
  assert.match(rejected.stderr, /forbidden import .*engineeringService\.js/);
});

test('checker keeps the native port outside domain code and cache codecs usable in Workers', () => {
  const { files, run } = fixture();
  files('desktop/src/infrastructure/cache/engineeringCacheStore.ts',
    "import { writeCacheFile } from '../native/projectFiles.js';");
  files('desktop/src/infrastructure/native/invokeTimed.ts',
    "import { invoke } from '@tauri-apps/api/core';");
  files('desktop/src/infrastructure/cache/engineeringCacheCodec.ts',
    "import { SPATIAL_PROJECTION_POLICY } from '../../services/engineering/compositionSpatial.js';");
  assert.equal(run().status, 0);
  files('desktop/src/infrastructure/cache/otherCodec.ts',
    "import '@desktop/database.js'; import '../workers/engineeringWorkerClient.js';");
  files('desktop/src/gim/source.ts',
    "import '../infrastructure/cache/engineeringCacheStore.js';");
  files('desktop/src/gim/native.ts',
    "import '../infrastructure/native/projectFiles.js';");
  files('desktop/src/infrastructure/native/projectFiles.ts',
    "import '../workers/engineeringWorkerClient.js'; import '@tauri-apps/api/core';");
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /forbidden import @desktop\/database\.js/);
  assert.match(rejected.stderr, /Cache infrastructure cannot depend on feature, Worker or rendering runtimes/);
  assert.match(rejected.stderr, /Engineering cache belongs to host infrastructure/);
  assert.match(rejected.stderr, /Native project files belong to host orchestration/);
  assert.match(rejected.stderr, /Native project files cannot depend on application runtimes/);
  assert.match(rejected.stderr, /forbidden import @tauri-apps\/api\/core/);
});

test('checker rejects eager renderer dependencies behind an opening helper',()=>{
  const {files,run}=fixture();
  files('desktop/src/app/session/openProject.ts',"export {render} from './openHelper.js';");
  files('desktop/src/app/session/openHelper.ts',"export const render=()=>import('three');");
  const accepted=run();
  assert.equal(accepted.status,0,accepted.stderr);
  files('desktop/src/app/session/openHelper.ts',"import 'three'; export const render=()=>{};");
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/openProject\.ts: eager renderer dependency three/);
});

test('checker keeps host transport and SDK parser dependencies explicit', () => {
  const {files,run} = fixture();
  files('desktop/bridge/unregistered.ts', "export { getViewerRuntime } from '../src/viewer/viewerRuntime.js';");
  files('desktop/src/shared/escape.ts', "export { loadAllIfcFiles } from '../features/substation/runtime/substationIfcRuntime.js';");
  files('packages/gim-sdk/src/parser/new.ts', "export { buildPowerlineProject } from '@gim/powerline-core/domain.js';");
  const result = run();
  assert.equal(result.status, 1);
  const diagnostics = result.stdout + result.stderr;
  assert.match(diagnostics, /only registered host transport ports/);
  assert.match(diagnostics, /shared values cannot import application runtimes/);
  assert.match(diagnostics, /SDK parser consumes format primitives only/);
});

test('checker reports whitelisted viewer bridge imports that no source uses',()=>{
  const {files,run}=fixture();
  const live=readFileSync(resolve('scripts/check-engineering-boundaries.mjs'),'utf8');
  const anchor="['viewer/ifcRegionalRuntime.ts:@desktop/ifcLodCache.js', false],";
  assert.ok(live.includes(anchor),'viewer bridge whitelist anchor moved; update this test');
  // A dead whitelist entry has no matching import and must fail the check.
  files('desktop/scripts/check-engineering-boundaries.mjs',live.replace(anchor,
    `${anchor}\n  ['viewer/ifcGhost.ts:@desktop/runtime.js', false],`));
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/stale entry with no matching import: viewer\/ifcGhost\.ts:@desktop\/runtime\.js/);
  // Removing a real bridge file turns its own whitelist entry stale.
  const withoutLoader=live.replace("import '@desktop/ifcLodCache.js';\nexport {};","");
  files('desktop/scripts/check-engineering-boundaries.mjs',live);
  files('desktop/src/viewer/ifcBimLoader.ts',withoutLoader);
  const rejectedLive=run();
  assert.equal(rejectedLive.status,1);
  assert.match(rejectedLive.stderr,/stale entry with no matching import: viewer\/ifcBimLoader\.ts:@desktop\/ifcLodCache\.js/);
});
