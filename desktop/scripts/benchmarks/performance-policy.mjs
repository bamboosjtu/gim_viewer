import {median} from './statistics.mjs';
/** Developer-local decision support. Recommendations are never approval. */
export const PERFORMANCE_POLICY=Object.freeze({version:'gim-performance-policy-v3',goal:'no-regression-relative-to-history-unless-evidence-backed-correctness-change',memoryGrowthLimit:0.5,
  memoryLimitBytes:6_000_000_000,coldInteractiveLimitMs:10_000,settledLimitMs:30_000,memoryUnit:'decimal-GB',approval:'human-only',
  interactiveMetric:'firstResponseMs navigation-ready proxy; excludes executable launch; input latency not proven'});
const values=(runs,key)=>runs.map(r=>r.metrics?.[key]).filter(v=>Number.isFinite(v)&&v>=0);
export function absolutePerformance(runs){
  const reasons=[],cold=runs.filter(r=>r.conditions?.cacheState==='cold');
  const complete=runs.length>0&&runs.every(r=>r.conditions?.mode==='benchmark'&&['passed','partial'].includes(r.correctness)&&
    !r.crashed&&!r.reason&&r.measurementComplete===true&&r.memoryEvidenceComplete===true&&r.processSampling?.complete===true);
  const memory=values(runs,'processPrivatePeakBytes'),settled=values(runs,'settledMs'),interactive=values(cold,'firstResponseMs');
  if(!complete)reasons.push('measurement-evidence-incomplete');
  if(memory.length!==runs.length)reasons.push('peak-memory-missing');
  if(settled.length!==runs.length)reasons.push('settled-time-missing');
  if(!cold.length||interactive.length!==cold.length)reasons.push('cold-start-evidence-missing');
  const memoryMet=memory.length===runs.length&&memory.length>0&&memory.every(v=>v<=PERFORMANCE_POLICY.memoryLimitBytes);
  const settledMet=settled.length===runs.length&&settled.length>0&&settled.every(v=>v<PERFORMANCE_POLICY.settledLimitMs);
  const coldMet=cold.length>0&&interactive.length===cold.length&&interactive.every(v=>v<PERFORMANCE_POLICY.coldInteractiveLimitMs);
  return {fullyMet:complete&&memoryMet&&settledMet&&coldMet,numericTargetsMet:memoryMet&&settledMet&&coldMet,
    memoryMet,settledMet,coldMet,evidenceComplete:complete,reasons,
    maximumMemoryBytes:memory.length?Math.max(...memory):null,maximumSettledMs:settled.length?Math.max(...settled):null,
    maximumColdInteractiveMs:interactive.length?Math.max(...interactive):null};
}
export function lifecycleRetention(growth){
  const withinLimit=Number.isFinite(growth)&&growth>=-1&&growth<=PERFORMANCE_POLICY.memoryGrowthLimit;
  return {policyVersion:PERFORMANCE_POLICY.version,growth,limit:PERFORMANCE_POLICY.memoryGrowthLimit,withinLimit,
    speedBenefitEstablished:false,requiresHumanReview:true,approval:'PENDING',
    interpretation:'within-run post-close retention; not cross-build peak-memory cost or proof of speed benefit'};
}
export function performanceComparison(baseline,candidate,{comparable=true,comparisonIssues=[],absoluteRuns=candidate,correctnessChanges=[]}={}){
  const geometryPolicy=run=>run.conditions?.geometryTimingPolicy??'legacy-model-commit-v1';
  const geometryComparable=new Set([...baseline,...candidate].map(geometryPolicy)).size<=1;
  const metricValues=(runs,name)=>name==='geometryCommitMs'?runs.map(r=>r.metrics?.geometryCommitMs??(geometryPolicy(r)==='legacy-model-commit-v1'?r.metrics?.firstGeometryMs:null)).filter(v=>Number.isFinite(v)&&v>=0):values(runs,name);
  const names=new Set(['firstResponseMs','firstGeometryMs','geometryCommitMs','settledMs','automaticLoadMs','processPrivatePeakBytes',
    ...(baseline[0]?.requiredMetrics??[]),...(candidate[0]?.requiredMetrics??[])]);
  const metrics=[...names].map(name=>{
    const b=metricValues(baseline,name),c=metricValues(candidate,name),before=b.length===baseline.length?median(b):null,after=c.length===candidate.length?median(c):null;
    const time=name.endsWith('Ms'),compatible=name!=='firstGeometryMs'||geometryComparable;
    return {name,baseline:before,candidate:after,comparable:compatible,delta:compatible&&before!==null&&after!==null?after-before:null,
      regression:compatible&&before>0&&after!==null?after/before-1:compatible&&before===0&&after===0?0:null,
      ...(time?{savedMs:compatible&&before!==null&&after!==null?before-after:null,
        reductionFraction:compatible&&before>0&&after!==null?1-after/before:null,
        speedupFraction:compatible&&after>0&&before!==null?before/after-1:null,
        baselineTotalMs:b.length===baseline.length?b.reduce((s,v)=>s+v,0):null,
        candidateTotalMs:c.length===candidate.length?c.reduce((s,v)=>s+v,0):null}:{}),
    };
  });
  const memory=metrics.find(m=>m.name==='processPrivatePeakBytes'),absolute=absolutePerformance(absoluteRuns);
  const beforeMemory=values(baseline,'processPrivatePeakBytes'),afterMemory=values(candidate,'processPrivatePeakBytes');
  const maximumMemoryGrowthFraction=beforeMemory.length&&afterMemory.length&&Math.max(...beforeMemory)>0
    ?Math.max(...afterMemory)/Math.max(...beforeMemory)-1:null;
  const memoryOverLimit=(memory?.regression??0)>PERFORMANCE_POLICY.memoryGrowthLimit||
    (maximumMemoryGrowthFraction??0)>PERFORMANCE_POLICY.memoryGrowthLimit;
  const changed=metrics.filter(m=>m.baseline!==null&&m.candidate!==null&&m.delta!==0);
  const memoryIncreased=(memory?.regression??0)>0;
  const timeRegressed=changed.some(m=>m.name.endsWith('Ms')&&m.delta>0);
  const keyTimes=metrics.filter(m=>['firstResponseMs','settledMs'].includes(m.name));
  const matchingSpeedEvidence=keyTimes.every(m=>m.baseline!==null&&m.candidate!==null);
  const firstGeometry=metrics.find(m=>m.name==='firstGeometryMs');if(firstGeometry&&!geometryComparable)Object.assign(firstGeometry,{comparable:false,comparisonIssue:'geometry-timing-policy-changed; compare geometryCommitMs separately'});
  const requiresHumanReview=!comparable||memoryOverLimit||memoryIncreased||timeRegressed||!geometryComparable;
  const recommendation=!comparable?'EVIDENCE_INCOMPLETE':memoryOverLimit?'MEMORY_LIMIT_EXCEEDED':
    timeRegressed?'REGRESSION_REQUIRES_CORRECTNESS_REVIEW':requiresHumanReview?'REVIEW_TRADEOFF':'NO_ADVERSE_TRADEOFF';
  return {policy:PERFORMANCE_POLICY,approval:'PENDING',comparable,comparisonIssues,absolute,metrics,
    memoryGrowthFraction:memory?.regression??null,maximumMemoryGrowthFraction,memoryOverLimit,matchingSpeedEvidence,
    correctnessChanges,geometryComparable,
    sameLevelBenefit:'human-assessment-required; no weighted score',requiresHumanReview,recommendation,
    additionalBenefitCounted:comparable&&absolute.evidenceComplete,
    interpretation:'relative regressions require evidence-backed correctness rationale and human review; absolute targets are informational and never waive regressions'};
}
