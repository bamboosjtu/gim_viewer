import {test} from 'node:test';import assert from 'node:assert/strict';
import {heapObservationCoverage} from './heap-observation-coverage.mjs';
const point=(atMs,bytes=100)=>({atMs,bytes});
test('real GC boundary samples explain only their confirmed pause and keep the full wall gap',()=>{
 const result=heapObservationCoverage({createdMs:0,endedMs:5000,samples:[point(100),point(1000,200),point(4200,120),point(4900)],
  pauses:[{verified:true,startMs:1000,endMs:4200,beforeBytes:200,afterBytes:120}],uncertaintyMs:1});
 assert.equal(result.complete,true);assert.equal(result.maxWallGapMs,3200);assert.ok(result.maxUnobservedGapMs<2000);assert.equal(result.observedPeakBytes,200);
});
test('a long native/JSON operation without actual GC observations remains incomplete',()=>{
 assert.equal(heapObservationCoverage({createdMs:0,endedMs:5000,samples:[point(100),point(4900)]}).complete,false);
 assert.equal(heapObservationCoverage({createdMs:0,endedMs:5000,samples:[point(100),point(4900)],pauses:[{verified:false,startMs:100,endMs:4900,beforeBytes:1,afterBytes:1}]}).complete,false);
});
test('partial GC evidence, overlapping pauses and clock uncertainty cannot invent coverage',()=>{
 const result=heapObservationCoverage({createdMs:0,endedMs:6000,samples:[point(100),point(5900)],pauses:[
  {verified:true,startMs:1000,endMs:3000,beforeBytes:100,afterBytes:90},{verified:true,startMs:2000,endMs:3500,beforeBytes:90,afterBytes:80}]});
 assert.equal(result.complete,false);assert.equal(result.maxUnobservedGapMs,3300);
 assert.equal(heapObservationCoverage({createdMs:0,endedMs:2010,samples:[point(5),point(2005)],uncertaintyMs:1}).complete,false);
});
