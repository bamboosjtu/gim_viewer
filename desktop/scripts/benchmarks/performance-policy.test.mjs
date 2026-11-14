import {test} from 'node:test';
import assert from 'node:assert/strict';
import {absolutePerformance,performanceComparison,lifecycleRetention} from './performance-policy.mjs';
import {reevaluatePolicy} from './policy-reevaluation.mjs';
import {benchmarkRun} from './test-fixtures.mjs';
const runs=(metrics={})=>[0,1,2].map(i=>benchmarkRun('r-'+i,{metrics:{firstResponseMs:9000,settledMs:29000,processPrivatePeakBytes:6e9,...metrics}}));
test('full targets use decimal bytes, strict time bounds, and every repetition',()=>{
  assert.equal(absolutePerformance(runs()).fullyMet,true);
  for(const metrics of [{firstResponseMs:10000},{settledMs:30000},{processPrivatePeakBytes:6e9+1}])assert.equal(absolutePerformance(runs(metrics)).fullyMet,false);
  const outlier=runs();outlier[2].metrics.settledMs=31000;assert.equal(absolutePerformance(outlier).fullyMet,false);
  outlier[2].metrics.settledMs=29000;outlier[2].memoryEvidenceComplete=false;
  assert.equal(absolutePerformance(outlier).fullyMet,false);assert.equal(absolutePerformance(outlier).numericTargetsMet,true);
  assert.equal(absolutePerformance(runs().map(r=>({...r,conditions:{...r.conditions,cacheState:'warm'}}))).fullyMet,false);
});
test('absolute targets remain informational while relative changes and raw seconds stay visible',()=>{
  const result=performanceComparison(runs({processPrivatePeakBytes:4e9}),runs({firstResponseMs:1000,settledMs:2000}));
  assert.equal(result.absolute.fullyMet,true);assert.equal(result.additionalBenefitCounted,true);
  assert.equal(result.metrics.find(m=>m.name==='settledMs').savedMs,27000);
  assert.equal(result.metrics.find(m=>m.name==='settledMs').baselineTotalMs,87000);
  assert.equal(result.memoryGrowthFraction,0.5);assert.equal(result.memoryOverLimit,false);assert.equal(result.approval,'PENDING');
  const warm=runs({firstResponseMs:1000,settledMs:2000}).map(r=>({...r,conditions:{...r.conditions,cacheState:'warm'}}));
  const warmView=performanceComparison(warm,warm,{absoluteRuns:[...runs(),...warm]});
  assert.equal(warmView.absolute.fullyMet,true);assert.equal(warmView.additionalBenefitCounted,true);
});
test('relative memory cap and unweighted speed tradeoffs require human review',()=>{
  const base=runs({firstResponseMs:15000,settledMs:60000,processPrivatePeakBytes:1e9});
  const next=runs({firstResponseMs:12000,settledMs:40000,processPrivatePeakBytes:1.5e9});
  const result=performanceComparison(base,next);assert.equal(result.requiresHumanReview,true);assert.equal(result.recommendation,'REVIEW_TRADEOFF');
  assert.equal(result.metrics.find(m=>m.name==='settledMs').savedMs,20000);
  next.forEach(r=>r.metrics.processPrivatePeakBytes++);assert.equal(performanceComparison(base,next).memoryOverLimit,true);
  const spike=runs({processPrivatePeakBytes:1e9});spike[2].metrics.processPrivatePeakBytes=2e9;
  assert.equal(performanceComparison(base,spike).memoryOverLimit,true);
  assert.equal(lifecycleRetention(0.5).withinLimit,true);assert.equal(lifecycleRetention(0.500001).withinLimit,false);
});
test('new assessment leaves historical FAIL and raw measurements unchanged',()=>{
  const baseline={runs:runs(),outcome:'PASS'},candidate={runs:runs(),outcome:'PARTIAL',baselineEligible:false};
  const life=benchmarkRun('life',{metrics:{firstResponseMs:null},exercise:{outcome:'FAIL',retainedGrowth:0.3,
    cycles:Array.from({length:10},(_,i)=>({passed:true,equivalent:true,memory:{bytes:i<5?100:130}})),cancellation:{passed:true}}});
  const bytes=JSON.stringify({baseline,candidate,life});const result=reevaluatePolicy(baseline,candidate,{lifecycle:life});
  assert.equal(result.lifecycle.originalOutcome,'FAIL');assert.equal(result.lifecycle.retention.withinLimit,true);
  assert.equal(result.lifecycle.retention.speedBenefitEstablished,false);assert.equal(result.lifecycle.absolute.fullyMet,false);
  assert.equal(result.referenceApproved,false);assert.equal(result.approval,'PENDING');assert.equal(JSON.stringify({baseline,candidate,life}),bytes);
  const missing=structuredClone(life);delete missing.exercise.cycles[2].memory.bytes;
  const incomplete=reevaluatePolicy(baseline,candidate,{lifecycle:missing});
  assert.equal(incomplete.lifecycle.retention.growth,null);assert.equal(incomplete.lifecycle.retention.withinLimit,false);
});
test('absolute target attainment never conceals a relative timing regression',()=>{
  const result=performanceComparison(runs({firstResponseMs:1000,settledMs:2000}),runs({firstResponseMs:1100,settledMs:2100}),{correctnessChanges:[{reason:'required source verification',evidence:['proof-report']}]});
  assert.equal(result.absolute.fullyMet,true);assert.equal(result.requiresHumanReview,true);
  assert.equal(result.recommendation,'REGRESSION_REQUIRES_CORRECTNESS_REVIEW');assert.equal(result.approval,'PENDING');assert.equal(result.correctnessChanges.length,1);
});
test('geometry commit and visible geometry timing policies are not silently compared as the same metric',()=>{
  const b=runs({firstGeometryMs:2000}),a=runs({firstGeometryMs:2100,geometryCommitMs:1900}).map(r=>({...r,conditions:{...r.conditions,geometryTimingPolicy:'in-viewport-model-draw-submitted-v2'}}));
  assert.equal(performanceComparison(b,a).geometryComparable,false);
  assert.equal(performanceComparison(b,a).metrics.find(m=>m.name==='firstGeometryMs').comparable,false);
});
