import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCapabilityInputs,verifyCapabilities} from './verify-capabilities.mjs';

test('real capability bundles satisfy closure boundaries', async () => {
  const capabilities=await verifyCapabilities();
  assert.equal(Object.keys(capabilities).length,6);
  assert.ok(capabilities.source.inputs>0);
});
test('transitive imports of policy fail even through a format or projection adapter', () => {
  assert.throws(()=>assertCapabilityInputs('source',['src/source/ifcSourceRecords.ts','src/semantic/recognizeSource.ts']),/recognizeSource/);
  assert.throws(()=>assertCapabilityInputs('projection',['src/projection/compositionTemplate.ts','src/semantic/classify.ts']),/classify/);
  assert.throws(()=>assertCapabilityInputs('geometry',['src/semantic/catalog/recognitionPolicy.json']),/recognitionPolicy/);
});

test('new intermediary modules inherit their directory role and unknown paths fail closed', () => {
  assert.throws(()=>assertCapabilityInputs('projection',['src/semantic/newHelper.ts']),/newHelper/);
  assert.throws(()=>assertCapabilityInputs('projection',['src/source/newParser.ts']),/newParser/);
  assert.throws(()=>assertCapabilityInputs('engineering',['src/unowned/helper.ts']),/unowned/);
  assert.doesNotThrow(()=>assertCapabilityInputs('source',['src/source/newParser.ts']));
});
