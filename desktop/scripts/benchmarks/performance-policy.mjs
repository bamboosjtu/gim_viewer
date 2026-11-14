import {median} from './statistics.mjs';
/** Developer-local decision support. Recommendations are never approval. */
export const PERFORMANCE_POLICY=Object.freeze({version:'gim-performance-policy-v1',goal:'meaningful-measurable-benefit-for-performance-work',
  performanceWork:'at least one meaningful improvement is required; no observed improvement is not an optimization success',
  featureAndCorrectnessWork:'avoid excessive regressions; report concrete rationale and costs',
  acceptance:'developer decides; no fixed time, memory or growth acceptance thresholds',memoryUnit:'decimal-GB',approval:'human-only',
  interactiveMetric:'firstResponseMs navigation-ready proxy; excludes executable launch; input latency not proven'});
const values=(runs,key)=>runs.map(r=>r.metrics?.[key]).filter(v=>Number.isFinite(v)&&v>=0);
export function performanceMeasurements(runs){
  const reasons=[],cold=runs.filter(r=>r.conditions?.cacheState==='cold');
  const complete=runs.length>0&&runs.every(r=>r.conditions?.mode==='benchmark'&&['passed','partial'].includes(r.correctness)&&
    !r.crashed&&!r.reason&&r.measurementComplete===true&&r.memoryEvidenceComplete===true&&r.processSampling?.complete===true);
  const memory=values(runs,'processPrivatePeakBytes'),settled=values(runs,'settledMs'),interactive=values(cold,'firstResponseMs');
  if(!complete)reasons.push('measurement-evidence-incomplete');
  if(memory.length!==runs.length)reasons.push('peak-memory-missing');
  if(settled.length!==runs.length)reasons.push('settled-time-missing');
  if(interactive.length!==cold.length)reasons.push('cold-start-evidence-missing');
  return {evidenceComplete:complete&&reasons.length===0,reasons,approval:'PENDING',
    maximumMemoryBytes:memory.length?Math.max(...memory):null,maximumSettledMs:settled.length?Math.max(...settled):null,
    maximumColdInteractiveMs:interactive.length?Math.max(...interactive):null};
}
export function lifecycleRetention(growth){
  const evidenceComplete=Number.isFinite(growth)&&growth>=-1;
  return {policyVersion:PERFORMANCE_POLICY.version,growth,evidenceComplete,increased:evidenceComplete&&growth>0,
    speedBenefitEstablished:false,requiresHumanReview:true,approval:'PENDING',
    interpretation:'within-run post-close retention; not cross-build peak-memory cost or proof of speed benefit'};
}
export function performanceComparison(baseline,candidate,{comparable=true,comparisonIssues=[],measurementRuns=candidate,correctnessChanges=[]}={}){
  const geometryPolicy=run=>run.conditions?.geometryTimingPolicy;
  const geometryComparable=[...baseline,...candidate].every(run=>!!geometryPolicy(run))&&new Set([...baseline,...candidate].map(geometryPolicy)).size===1;
  const names=new Set(['firstResponseMs','firstGeometryMs','geometryCommitMs','settledMs','automaticLoadMs','processPrivatePeakBytes',
    ...(baseline[0]?.requiredMetrics??[]),...(candidate[0]?.requiredMetrics??[])]);
  const metrics=[...names].map(name=>{
    const b=values(baseline,name),c=values(candidate,name),before=b.length===baseline.length?median(b):null,after=c.length===candidate.length?median(c):null;
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
  const memory=metrics.find(m=>m.name==='processPrivatePeakBytes'),measurements=performanceMeasurements(measurementRuns);
  const beforeMemory=values(baseline,'processPrivatePeakBytes'),afterMemory=values(candidate,'processPrivatePeakBytes');
  const maximumMemoryGrowthFraction=beforeMemory.length&&afterMemory.length&&Math.max(...beforeMemory)>0
    ?Math.max(...afterMemory)/Math.max(...beforeMemory)-1:null;
  const changed=metrics.filter(m=>m.baseline!==null&&m.candidate!==null&&m.delta!==0);
  const memoryIncreased=(memory?.regression??0)>0;
  const timeRegressed=changed.some(m=>m.name.endsWith('Ms')&&m.delta>0);
  const keyTimes=metrics.filter(m=>['firstResponseMs','settledMs'].includes(m.name));
  const matchingSpeedEvidence=keyTimes.every(m=>m.baseline!==null&&m.candidate!==null);
  const firstGeometry=metrics.find(m=>m.name==='firstGeometryMs');if(firstGeometry&&!geometryComparable)Object.assign(firstGeometry,{comparable:false,comparisonIssue:'geometry-timing-policy-changed; compare geometryCommitMs separately'});
  const observedImprovementMetrics=changed.filter(m=>m.comparable&&m.delta<0).map(m=>m.name);
  const hasTradeoff=memoryIncreased||timeRegressed||!geometryComparable;
  const recommendation=!comparable?'EVIDENCE_INCOMPLETE':hasTradeoff?'REGRESSION_REQUIRES_HUMAN_REVIEW':
    observedImprovementMetrics.length?'IMPROVEMENT_REQUIRES_HUMAN_REVIEW':'NO_IMPROVEMENT_OBSERVED';
  return {policy:PERFORMANCE_POLICY,approval:'PENDING',comparable,comparisonIssues,measurements,metrics,
    memoryGrowthFraction:memory?.regression??null,maximumMemoryGrowthFraction,matchingSpeedEvidence,
    correctnessChanges,geometryComparable,
    sameLevelBenefit:'human-assessment-required; no weighted score',requiresHumanReview:true,hasTradeoff,recommendation,
    observedImprovementMetrics,meaningfulImprovement:'developer-assessment-required',optimizationAccepted:false,
    interpretation:'performance work requires a meaningful measurable benefit; feature/correctness costs and regressions remain visible; acceptance and any further retest scope belong to the developer'};
}
