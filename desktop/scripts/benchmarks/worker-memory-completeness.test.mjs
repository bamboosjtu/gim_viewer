import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyWorkerHeapCoverage,classifyWorkerHeapEvidence,recordWorkerHeapSample} from './worker-memory-completeness.mjs';

test('short Worker targets are explicit gaps without invalidating long-lived heap coverage',()=>{
  const workers={short:{state:'terminated',createdMs:100,endedMs:800,tasks:1},
    long:{state:'terminated',createdMs:100,endedMs:5000,tasks:1},active:{state:'running',createdMs:100,tasks:1}};
  const result=classifyWorkerHeapCoverage(workers,new Set(),1000);
  assert.deepEqual(result.shortLived,[{workerId:'short',reason:'ended-before-heap-sample',lifetimeMs:700}]);
  assert.deepEqual(result.required,['long','active']);
});
test('unavailable sampling has a reason and is distinct from a never observed Worker',()=>{
  const workers={unavailable:{state:'running',createdMs:100,tasks:1},missing:{state:'running',createdMs:100,tasks:1}};
  const records=new Map([['unavailable',{workerId:'unavailable',availability:'unavailable',reason:'runtime-timeout-or-unsupported',samples:2}]]);
  const result=classifyWorkerHeapEvidence(workers,new Set(),records,1000);
  assert.deepEqual(result.missing,['missing']);
  assert.deepEqual(result.unavailable,[records.get('unavailable')]);
});
test('never executed Worker instances do not require a heap sample',()=>{
  const workers={idle:{family:'dev',state:'terminated',createdMs:100,endedMs:150,tasks:0}};
  const result=classifyWorkerHeapEvidence(workers,new Set(),new Map(),1000);
  assert.deepEqual(result.missing,[]);
  assert.deepEqual(result.notApplicable,[{workerId:'idle',reason:'never-executed'}]);
});
test('a successful early heap sample does not hide later Worker sampling failures',()=>{
  const workers={dev:{family:'dev',state:'running',createdMs:0,tasks:1}};
  const records=new Map([['dev',{workerId:'dev',availability:'available',successfulSamples:1,failedSamples:3,
    lastFailureReason:'previous-sample-pending',maxSampleGapMs:4500,maxSampleDelayMs:2200}]]);
  const result=classifyWorkerHeapEvidence(workers,new Set(['dev']),records,1000);
  assert.deepEqual(result.missing,[]);
  assert.equal(result.unavailable[0].reason,'previous-sample-pending');
  assert.equal(result.unavailable[0].failedSamples,3);
});
test('a long sampling gap remains incomplete even when every received sample succeeded',()=>{
  const workers={dev:{family:'dev',state:'running',createdMs:0,tasks:1}};
  const records=new Map([['dev',{workerId:'dev',availability:'available',successfulSamples:2,failedSamples:0,
    maxSampleGapMs:3500,maxSampleDelayMs:50}]]);
  const result=classifyWorkerHeapEvidence(workers,new Set(['dev']),records,1000);
  assert.equal(result.unavailable[0].reason,'worker-heap-sampling-gap');
});

test('a delayed first real sample cannot hide the unsampled target startup interval',()=>{
  const row=recordWorkerHeapSample(undefined,{workerId:'dev',family:'dev',availability:'available',targetCreatedAtMs:100,atMs:2600,sampleDelayMs:20});
  assert.equal(row.successfulSamples,1);assert.equal(row.failedSamples,0);assert.equal(row.maxSampleGapMs,2500);
  const result=classifyWorkerHeapEvidence({dev:{family:'dev',state:'running',createdMs:0,tasks:1}},new Set(['dev']),new Map([['dev',row]]));
  assert.equal(result.unavailable[0].reason,'worker-heap-sampling-gap');
});
test('failed attempts never split or shorten a gap between real successful samples',()=>{
 const base={workerId:'worker',family:'engineering',targetCreatedAtMs:0,sampleDelayMs:0};
 let row=recordWorkerHeapSample(undefined,{...base,atMs:100,availability:'available'});
 row=recordWorkerHeapSample(row,{...base,atMs:2100,availability:'unavailable',reason:'runtime-timeout'});
 row=recordWorkerHeapSample(row,{...base,atMs:2350,availability:'unavailable',reason:'runtime-request-outstanding'});
 row=recordWorkerHeapSample(row,{...base,atMs:4100,availability:'available'});
 assert.equal(row.maxSampleGapMs,4000);assert.equal(row.lastSuccessfulSampleAtMs,4100);assert.equal(row.failedSamples,2);
});
