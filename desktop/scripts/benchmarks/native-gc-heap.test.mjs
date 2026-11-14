import {test} from 'node:test';import assert from 'node:assert/strict';
import {NativeGcHeapTrace} from './native-gc-heap.mjs';
import {classifyWorkerHeapEvidence} from './worker-memory-completeness.mjs';
test('the GC collector excludes default Chromium categories from its recording',async()=>{
 const calls=[];let receive;
 const browser={onEvent(callback){receive=callback;return()=>{};},async send(method,params){calls.push({method,params});if(method==='Tracing.end')receive({method:'Tracing.tracingComplete',params:{dataLossOccurred:false}});}};
 const trace=new NativeGcHeapTrace(browser,{evaluate:async()=>{}},{});
 await trace.start();await trace.stop();
 assert.deepEqual(calls[0].params.traceConfig.includedCategories,['v8','blink.user_timing']);
 assert.deepEqual(calls[0].params.traceConfig.excludedCategories,['*']);
});
function fixture(){
 const trace=new NativeGcHeapTrace({}, {}, {evaluate:async()=>{}});trace.closedTrace=true;trace.loss=false;
 trace.clocks=[{name:'clock-a',before:1000,after:1002},{name:'clock-b',before:6000,after:6002}];
 trace.events=[{name:'clock-a',ts:1000000},{name:'clock-b',ts:6000000}];
 // Mark names are nonce-scoped, so expose the same prefix as real marks.
 trace.clocks.forEach(c=>{const e=trace.events.find(e=>e.name===c.name);c.name=trace.prefix+c.name;e.name=c.name;});
 trace.associate({workerId:'owned',family:'engineering',runId:'run'},'session',{targetId:'target',isolateId:'isolate',created:1200});trace.ended('owned',5800);
 const target=trace.targets.get('target');trace.events.push({name:target.name,ts:1300000,pid:7,tid:8},
  {name:'MajorGC',ph:'X',ts:2000000,dur:3200000,pid:7,tid:8,args:{usedHeapSizeBefore:200,usedHeapSizeAfter:120}});
 const series=new Map([['owned',[{atMs:1300,earliestAtMs:1299,latestAtMs:1300,bytes:100},{atMs:1900,bytes:150},{atMs:5500,bytes:120}]]]);
 return {trace,series};
}
test('actual nonce-bound GC counters fill a confirmed pause while failed RPC evidence stays visible',()=>{
 const {trace,series}=fixture(),result=trace.coverage(series,6000),coverage=result.coverage.get('owned');
 assert.equal(coverage.complete,true);assert.equal(coverage.mappingVerified,true);assert.equal(coverage.gcSamples,2);
 assert.equal(coverage.maxWallGapMs,3200);assert.ok(coverage.maxUnobservedGapMs<2000);
 const records=new Map([['owned',{workerId:'owned',failedSamples:3,lastFailureReason:'runtime-timeout'}]]),workers={owned:{family:'engineering',state:'terminated',createdMs:0,endedMs:4600,tasks:1}};
 assert.equal(classifyWorkerHeapEvidence(workers,new Set(['owned']),records).unavailable.length,1);
 assert.equal(classifyWorkerHeapEvidence(workers,new Set(['owned']),records,1000,result.coverage).unavailable.length,0);
 assert.equal(records.get('owned').failedSamples,3);
});
test('GC on another thread, ambiguous ownership and dropped trace data never explain a gap',()=>{
 let {trace,series}=fixture();trace.events[trace.events.length-1].tid=99;assert.equal(trace.coverage(series,6000).coverage.get('owned').complete,false);
 ({trace,series}=fixture());trace.loss=true;assert.equal(trace.coverage(series,6000).coverage.get('owned').complete,false);
 ({trace,series}=fixture());trace.associate({workerId:'other',family:'dev'},'other-session',{targetId:'other-target',isolateId:'other-isolate',created:1200});trace.ended('other',5800);
 trace.events.push({name:trace.targets.get('other-target').name,ts:1400000,pid:7,tid:8});assert.equal(trace.coverage(series,6000).coverage.get('owned').complete,false);
});
test('unverified clock brackets cannot turn GC counters into trusted timed observations',()=>{
 const {trace,series}=fixture();trace.clocks[1].after=7000;
 assert.equal(trace.coverage(series,6000).coverage.get('owned').complete,false);
});
