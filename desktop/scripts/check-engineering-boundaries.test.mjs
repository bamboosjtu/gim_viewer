import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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
    ...['engineering','gim','shared'].map(name=>`packages/gim-sdk/src/${name}`),
    'desktop/scripts','desktop/node_modules'])mkdirSync(join(folder,dir),{recursive:true});
  symlinkSync(resolve('node_modules/typescript'),join(folder,'desktop/node_modules/typescript'),'junction');
  copyFileSync(resolve('package.json'),join(folder,'desktop/package.json'));
  for(const name of ['check-engineering-boundaries','core-boundaries','package-boundaries','presentation-boundaries','native-contract-boundaries'])
    copyFileSync(resolve('scripts',`${name}.mjs`),join(folder,'desktop/scripts',`${name}.mjs`));
  files('desktop/scripts/sdk-internal-imports.json','{}');
  files('desktop/src/measurement/core.ts',"export * from '@gim/measurement-core/source';");
  for(const name of ['substationRuntime','substationPresentation','substationRuntimeTelemetry','substationSpatialRuntime',
    'substationDocumentRuntime','substationIfcRuntime','substationIfcSource','substationDevRuntime','substationLoadingState',
    'devLodRuntime','devLodTemplateStore','devLodArtifactWriter','devLodSourceWorkset','devLodReadiness','devLodDiagnostics','devLodTypes'])
    files(`desktop/src/services/${name}.ts`,'export {};');
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

test('checker rejects an unused SDK internal-import exception',()=>{
  const {files,run}=fixture();
  files('desktop/scripts/sdk-internal-imports.json',JSON.stringify({'gim/model.ts':['@gim/gim-sdk/gim/sourceDocument.js']}));
  const rejected=run();
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/gim\/model\.ts: remove unused SDK internal-import exception/);
});

test('checker rejects a cycle within a runtime family through dynamic dependencies',()=>{
  const {files,run}=fixture();
  files('desktop/src/services/substationPresentation.ts',"export const load=()=>import('./substationIfcRuntime.js');");
  files('desktop/src/services/substationIfcRuntime.ts',"export const load=()=>import('./substationPresentation.js');");
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
