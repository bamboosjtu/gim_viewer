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
    files(`desktop/src/services/${name}.ts`,'export {};');
  for(const name of ['substationBackgroundRuntime','substationColdCore','substationDevRuntime','substationDocumentRuntime',
    'substationIfcRuntime','substationIfcSource','substationIndexPublication','substationSpatialRuntime',
    'substationSpatialSemanticCache','substationWarmAttempt','substationWarmCore','substationLoadingState'])
    files(`desktop/src/features/substation/runtime/${name}.ts`,'export {};');
  files('desktop/src/features/substation/application/substationRuntime.ts','export {};');
  files('desktop/src/features/substation/application/substationOpenStages.ts','export {};');
  files('desktop/src/features/substation/application/substationColdSource.ts','export {};');
  files('desktop/src/features/substation/application/substationColdPersistence.ts','export {};');
  files('desktop/src/features/substation/presentation/substationPresentation.ts','export {};');
  files('desktop/src/features/substation/runtime/substationRuntimeTelemetry.ts','export {};');
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

test('checker rejects a cycle within a runtime family through dynamic dependencies',()=>{
  const {files,run}=fixture();
  files('desktop/src/features/substation/presentation/substationPresentation.ts',"export const load=()=>import('../runtime/substationIfcRuntime.js');");
  files('desktop/src/features/substation/runtime/substationIfcRuntime.ts',"export const load=()=>import('../presentation/substationPresentation.js');");
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/Circular runtime module dependency/);
});

test('checker rejects eager renderer dependencies behind an opening helper',()=>{
  const {files,run}=fixture();
  files('desktop/src/services/openGimService.ts',"export {render} from './openHelper.js';");
  files('desktop/src/services/openHelper.ts',"export const render=()=>import('three');");
  const accepted=run();
  assert.equal(accepted.status,0,accepted.stderr);
  files('desktop/src/services/openHelper.ts',"import 'three'; export const render=()=>{};");
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/openGimService\.ts: eager renderer dependency three/);
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
