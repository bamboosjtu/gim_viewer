import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyWorkerHeapCoverage,classifyWorkerHeapEvidence} from './worker-memory-completeness.mjs';

test('short mapped targets remain explicitly unavailable without invalidating long-lived heap coverage',()=>{
  const workers={short:{state:'terminated',createdMs:100,endedMs:800,tasks:1},
    long:{state:'terminated',createdMs:100,endedMs:5000,tasks:1},active:{state:'running',createdMs:100,tasks:1}};
  const result=classifyWorkerHeapCoverage(workers,new Set(),new Set(['short','long','active']),1000);
  assert.deepEqual(result.shortLived,[{workerId:'short',reason:'ended-before-heap-sample',lifetimeMs:700}]);
  assert.deepEqual(result.required,['long','active']);
});
test('unavailable sampling has a reason and is distinct from a never observed Worker',()=>{
  const workers={unavailable:{state:'running',createdMs:100,tasks:1},missing:{state:'running',createdMs:100,tasks:1}};
  const records=new Map([['unavailable',{workerId:'unavailable',availability:'unavailable',reason:'runtime-timeout-or-unsupported',samples:2}]]);
  const result=classifyWorkerHeapEvidence(workers,new Set(),records,new Set(),1000);
  assert.deepEqual(result.missing,['missing']);
  assert.deepEqual(result.unavailable,[records.get('unavailable')]);
});
