import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {workspaceTemp} from '../test-workspace.mjs';
import {assertBenchmarkFrontend,assertBenchmarkExecutable} from './benchmark-build-attestation.mjs';

test('benchmark build attestation rejects a normal frontend and an executable with stale assets',()=>{
  const root=mkdtempSync(join(workspaceTemp(),'benchmark-build-attestation-'));
  try{
    const assets=join(root,'dist','assets');mkdirSync(assets,{recursive:true});
    writeFileSync(join(assets,'index-normal.js'),'ordinary frontend');
    assert.throws(()=>assertBenchmarkFrontend(join(root,'dist')),/probe-missing/);
    const chunk='benchmarkHost-test.js';
    writeFileSync(join(assets,chunk),'globalThis.__gimBenchmark = {};');
    assert.equal(assertBenchmarkFrontend(join(root,'dist')),chunk);
    const executable=join(root,'GIM-Reader.exe');
    writeFileSync(executable,'embedded index-normal.js');
    assert.throws(()=>assertBenchmarkExecutable(executable,chunk),/probe-missing/);
    writeFileSync(executable,`embedded ${chunk}`);
    assert.doesNotThrow(()=>assertBenchmarkExecutable(executable,chunk));
  }finally{rmSync(root,{recursive:true,force:true});}
});
