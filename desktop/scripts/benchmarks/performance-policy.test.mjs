import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performanceMeasurements,performanceComparison,lifecycleRetention,PERFORMANCE_POLICY} from './performance-policy.mjs';
import {benchmarkRun} from './test-fixtures.mjs';
const runs=(metrics={})=>[0,1,2].map(i=>benchmarkRun('r-'+i,{metrics:{firstResponseMs:9000,settledMs:29000,processPrivatePeakBytes:6e9,...metrics}}));

test('reports measurements without time, memory or growth acceptance targets',()=>{
  const result=performanceMeasurements(runs({firstResponseMs:120000,settledMs:600000,processPrivatePeakBytes:32e9}));
  assert.equal(result.evidenceComplete,true);assert.equal(result.maximumMemoryBytes,32e9);assert.equal(result.maximumSettledMs,600000);assert.equal(result.fullyMet,undefined);
  for(const key of ['memoryLimitBytes','coldInteractiveLimitMs','settledLimitMs','memoryGrowthLimit'])assert.equal(Object.hasOwn(PERFORMANCE_POLICY,key),false);
  const missing=runs();missing[2].memoryEvidenceComplete=false;assert.equal(performanceMeasurements(missing).evidenceComplete,false);
  assert.equal(performanceMeasurements(runs().map(r=>({...r,conditions:{...r.conditions,cacheState:'warm'}}))).evidenceComplete,true);
});
test('an observed improvement is not automatically meaningful or accepted',()=>{
  const result=performanceComparison(runs({processPrivatePeakBytes:4e9}),runs({firstResponseMs:1000,settledMs:2000}));
  assert.equal(result.metrics.find(m=>m.name==='settledMs').savedMs,27000);assert.equal(result.metrics.find(m=>m.name==='settledMs').baselineTotalMs,87000);
  assert.ok(result.observedImprovementMetrics.includes('settledMs'));assert.equal(result.meaningfulImprovement,'developer-assessment-required');
  assert.equal(result.requiresHumanReview,true);assert.equal(result.optimizationAccepted,false);assert.equal(result.approval,'PENDING');
  assert.equal(performanceComparison(runs(),runs()).recommendation,'NO_IMPROVEMENT_OBSERVED');
});
test('memory growth stays visible without an automatic acceptance cap',()=>{
  const result=performanceComparison(runs({processPrivatePeakBytes:1e9}),runs({processPrivatePeakBytes:20e9}));
  assert.equal(result.memoryGrowthFraction,19);assert.equal(result.memoryOverLimit,undefined);assert.equal(result.recommendation,'REGRESSION_REQUIRES_HUMAN_REVIEW');
  assert.equal(lifecycleRetention(19).evidenceComplete,true);assert.equal(lifecycleRetention(19).approval,'PENDING');assert.equal(lifecycleRetention(null).evidenceComplete,false);
});
test('correctness rationale never automatically excuses a regression',()=>{
  const result=performanceComparison(runs({firstResponseMs:1000,settledMs:2000}),runs({firstResponseMs:1100,settledMs:2100}),{correctnessChanges:[{reason:'required source verification',evidence:['proof-report']}]});
  assert.equal(result.requiresHumanReview,true);assert.equal(result.recommendation,'REGRESSION_REQUIRES_HUMAN_REVIEW');assert.equal(result.approval,'PENDING');assert.equal(result.correctnessChanges.length,1);
});
test('geometry commit and visible geometry keep distinct timing policies',()=>{
  const b=runs({firstGeometryMs:2000}),a=runs({firstGeometryMs:2100,geometryCommitMs:1900}).map(r=>({...r,conditions:{...r.conditions,geometryTimingPolicy:'different-timing-definition'}}));
  assert.equal(performanceComparison(b,a).geometryComparable,false);assert.equal(performanceComparison(b,a).metrics.find(m=>m.name==='firstGeometryMs').comparable,false);
});
