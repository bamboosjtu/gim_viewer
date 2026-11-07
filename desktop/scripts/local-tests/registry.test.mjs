import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateLocalRegistryShape,applyProjectRoleChecks,planLocalRegistry} from './registry.mjs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
const sha=value=>String(value).repeat(64);
const rows=['substation','line','equipment'].map((role,i)=>({role,path:`model${i}.gim`,sourceSha256:sha(i)}));
test('local registry declares substation, line and equipment roles',()=>{
  assert.equal(validateLocalRegistryShape({version:'gim-local-tests-v1',samples:rows}).length,3);
  assert.throws(()=>validateLocalRegistryShape({version:'gim-local-tests-v1',samples:rows.slice(0,2)}),/missing-equipment/);
  assert.throws(()=>validateLocalRegistryShape({version:'gim-local-tests-v1',samples:[...rows.slice(0,2),{...rows[2],role:'unknown'}]}),/role-invalid/);
});
test('actual product branch must match each registered role',()=>{
  const results=rows.map((source,i)=>({status:'PASS',sourceSha256:source.sourceSha256,projectType:i===1?'substation':i===0?'substation':'equipment'}));
  assert.equal(applyProjectRoleChecks(results,rows),1);
  assert.equal(results[1].status,'FAIL');assert.equal(results[1].error,'registered-project-type-mismatch');
  const partial=[{status:'PARTIAL',sourceSha256:rows[2].sourceSha256,projectType:'substation'}];
  assert.equal(applyProjectRoleChecks(partial,rows),1);
});
test('committed mini example declares all roles and marks unconfigured equipment',()=>{
  const example=JSON.parse(readFileSync(new URL('../../local-tests/mini-samples.example.json',import.meta.url),'utf8'));
  assert.deepEqual(example.samples.map(row=>row.role),['substation','line','equipment']);
  assert.equal(validateLocalRegistryShape(example).length,3);
  assert.equal(example.samples[2].sourceSha256,'<SHA256>');
});
test('absent local archives are reported as skipped without loading a model',async()=>{
  const root=resolve('..'),file=join(root,'tmp','local-tests','fixture.json');
  const samples=rows.map(row=>({...row,path:`absent-${randomUUID()}.gim`}));
  const plan=await planLocalRegistry(root,{file,samples});
  assert.equal(plan.available.length,0);
  assert.deepEqual(plan.skipped.map(row=>row.reason),['source-missing','source-missing','source-missing']);
});
