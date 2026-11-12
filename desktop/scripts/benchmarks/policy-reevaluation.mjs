import {absolutePerformance,performanceComparison,lifecycleRetention,PERFORMANCE_POLICY} from './performance-policy.mjs';
import {compareRuns,runReadiness} from './compare.mjs';
import {retainedMemory} from './statistics.mjs';
/** New derived assessment only. Original measurements and verdicts stay intact. */
export function reevaluatePolicy(baseline,candidate,{lifecycle=null}={}){
  for(const input of [baseline,candidate])if(input.artifactRole==='public-derived'||!input.runs?.length)throw Error('private-native-reports-required');
  const key=r=>JSON.stringify([r.conditions.sampleId,r.conditions.sourceSha256,r.conditions.scenario,r.conditions.cacheState,r.conditions.mode]);
  const group=rows=>{const m=new Map();for(const r of rows){const k=key(r),v=m.get(k)??[];v.push(r);m.set(k,v);}return m;};
  const b=group(baseline.runs),c=group(candidate.runs),cases=[];
  for(const k of new Set([...b.keys(),...c.keys()])){
    const before=b.get(k)??[],after=c.get(k)??[],example=after[0]??before[0];
    const absoluteRuns=candidate.runs.filter(r=>r.conditions.sampleId===example.conditions.sampleId&&r.conditions.scenario===example.conditions.scenario&&r.conditions.mode===example.conditions.mode);
    const comparison=before.length&&after.length?compareRuns(before,after):{outcome:'INCONCLUSIVE',reasons:['scenario-missing']};
    const assessment=performanceComparison(before,after,{comparable:comparison.outcome!=='FAIL'&&(!comparison.reasons?.length||comparison.reasons.every(r=>r==='human-performance-review-required'||r==='memory-growth-over-50-percent')),comparisonIssues:comparison.reasons,absoluteRuns});
    cases.push({sampleId:example.conditions.sampleId,sampleLabel:baseline.rows?.find(r=>r.sampleId===example.conditions.sampleId)?.sampleLabel??example.conditions.sampleId,
      cacheState:example.conditions.cacheState,scenario:example.conditions.scenario,
      repetitions:{baseline:before.length,candidate:after.length},performance:assessment,
      correctness:[...new Set(after.map(r=>r.correctness))],evidenceIssues:[...new Set(after.flatMap(r=>[
        ...runReadiness(r).reasons,...(r.memoryIncompleteItems??[]),...(r.measurementDetailStatus==='aggregate-only'?['detail-aggregate-only']:[])]))]});
  }
  const samples=[...new Set(candidate.runs.map(r=>r.conditions.sampleId))].map(sampleId=>({sampleId,
    absolute:absolutePerformance(candidate.runs.filter(r=>r.conditions.sampleId===sampleId))}));
  const sum=(runs,name)=>runs.every(r=>Number.isFinite(r.metrics?.[name]))?runs.reduce((n,r)=>n+r.metrics[name],0):null;
  const totals={};for(const name of ['firstResponseMs','settledMs']){const before=sum(baseline.runs,name),after=sum(candidate.runs,name);
    totals[name]={baseline:before,candidate:after,savedMs:before!==null&&after!==null?before-after:null,
      interpretation:'sum of per-run times, not batch wall-clock time; mixed cold/warm retained separately in cases'};}
  let lifecycleAssessment=null;
  if(lifecycle){const e=lifecycle.exercise,rows=e?.cycles??[];
    const {earlyMedianBytes,lateMedianBytes,growth}=retainedMemory(rows);
    lifecycleAssessment={originalOutcome:e?.outcome,resourceChecksPassed:rows.length===10&&rows.every(r=>r.passed&&r.equivalent)&&e.cancellation?.passed===true,
      retention:lifecycleRetention(growth),earlyMedianBytes,lateMedianBytes,metrics:lifecycle.metrics,
      absolute:absolutePerformance([lifecycle]),matchingCandidateRuns:candidate.runs.filter(r=>r.conditions?.sampleId===lifecycle.conditions?.sampleId&&
        r.buildFingerprint===lifecycle.buildFingerprint&&r.conditions?.mode==='benchmark'&&r.conditions?.scenario==='open').length,
      comparison:'within-run retention is not a cross-build speed comparison; diagnostic runs excluded'};
  }
  return {version:'gim-policy-reevaluation-v2',artifactRole:'derived-policy-assessment',authority:false,approval:'PENDING',policy:PERFORMANCE_POLICY,
    referenceApproved:!!baseline.approval,originalOutcomes:{baseline:baseline.outcome,candidate:candidate.outcome,baselineEligible:candidate.baselineEligible},
    baselineBuild:baseline.buildFingerprint,candidateBuild:candidate.buildFingerprint,samples,cases,totals,lifecycle:lifecycleAssessment,
    remainingIssues:[...new Set(cases.flatMap(r=>[...r.performance.comparisonIssues,...r.evidenceIssues]))],
    interpretation:'observed percentages and seconds are reported without a weighted score; human decides benefit equivalence and final approval'};
}
export function reevaluationRows(report){
  return report.cases.map(row=>{
    const metrics=Object.fromEntries(row.performance.metrics.map(m=>[m.name,m])),first=metrics.firstResponseMs,settled=metrics.settledMs,memory=metrics.processPrivatePeakBytes;
    return {sample:row.sampleLabel,cacheState:row.cacheState,comparable:row.performance.comparable,
      baselineInteractiveSeconds:first.baseline===null?null:first.baseline/1000,candidateInteractiveSeconds:first.candidate===null?null:first.candidate/1000,
      baselineSettledSeconds:settled.baseline===null?null:settled.baseline/1000,candidateSettledSeconds:settled.candidate===null?null:settled.candidate/1000,
      savedSeconds:settled.savedMs===null?null:settled.savedMs/1000,timeReductionPercent:settled.reductionFraction===null?null:settled.reductionFraction*100,
      baselineMemoryGB:memory.baseline===null?null:memory.baseline/1e9,candidateMemoryGB:memory.candidate===null?null:memory.candidate/1e9,
      memoryGrowthPercent:row.performance.memoryGrowthFraction===null?null:row.performance.memoryGrowthFraction*100,
      fullyMet:row.performance.absolute.fullyMet,approval:report.approval,
      issues:[...row.performance.comparisonIssues,...row.evidenceIssues].join(';')};
  });
}
