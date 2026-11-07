import {createHash} from 'node:crypto';
const identityKeys=['machineId','runtimeSha256','buildMode','measurementVersion','mode','scenario','cacheState','sourceSha256','sampleId','profileDigest','workloadDigest','routeDigest','viewportDigest'];
export function digest(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function median(values){const rows=[...values].sort((a,b)=>a-b);return rows.length%2?rows[(rows.length-1)/2]:(rows[rows.length/2-1]+rows[rows.length/2])/2;}
export function runReadiness(run){
  if(run.correctness==='failed'||run.crashed)return {outcome:'FAIL',reasons:['correctness-or-crash']};
  const reasons=[];
  for(const key of identityKeys)if(run.conditions?.[key]==null)reasons.push(`missing-condition:${key}`);
  if(run.conditions?.mode!=='benchmark')reasons.push('not-benchmark-mode');
  if(run.correctness!=='passed')reasons.push('correctness-unverified');
  if(run.measurementComplete!==true)reasons.push('measurement-incomplete');
  if(run.version==='gim-benchmark-v1'&&run.processSampling?.complete!==true)reasons.push('native-process-memory-incomplete');
  if(run.conditions?.profileDigest==='unfrozen')reasons.push('profile-not-frozen');
  if(run.cacheVerified!==true)reasons.push('cache-state-unverified');
  if(!run.processInstanceId)reasons.push('process-identity-missing');
  for(const name of run.requiredMetrics??[])if(!Number.isFinite(run.metrics?.[name])||run.metrics[name]<0)reasons.push(`missing-metric:${name}`);
  if(!run.requiredMetrics?.length)reasons.push('required-metrics-missing');
  return {outcome:reasons.length?'INCONCLUSIVE':'PASS',reasons};
}
function checkTriplet(runs){
  const checks=runs.map(runReadiness);if(checks.some(r=>r.outcome==='FAIL'))return {outcome:'FAIL',reasons:checks.flatMap(r=>r.reasons)};
  const reasons=checks.flatMap(r=>r.reasons);
  if(runs.length<3||new Set(runs.map(r=>r.processInstanceId)).size!==runs.length)reasons.push('three-independent-processes-required');
  for(const key of identityKeys)if(runs.some(r=>r.conditions?.[key]!==runs[0]?.conditions?.[key]))reasons.push(`mixed-condition:${key}`);
  if(runs.some(r=>JSON.stringify(r.requiredMetrics)!==JSON.stringify(runs[0]?.requiredMetrics)))reasons.push('mixed-required-metrics');
  return {outcome:reasons.length?'INCONCLUSIVE':'PASS',reasons:[...new Set(reasons)]};
}
export function compareRuns(baseline,candidate,{retestBaseline=[],retestCandidate=[]}={}){
  const b=checkTriplet(baseline),c=checkTriplet(candidate),reasons=[...b.reasons,...c.reasons];
  if(b.outcome==='FAIL'||c.outcome==='FAIL')return {outcome:'FAIL',reasons};
  for(const key of identityKeys)if(baseline[0]?.conditions?.[key]!==candidate[0]?.conditions?.[key])reasons.push(`incomparable:${key}`);
  if(JSON.stringify(baseline[0]?.requiredMetrics)!==JSON.stringify(candidate[0]?.requiredMetrics))reasons.push('incomparable:required-metrics');
  if(reasons.length)return {outcome:'INCONCLUSIVE',reasons:[...new Set(reasons)],metrics:[]};
  const metrics=baseline[0].requiredMetrics.map(name=>{
    const base=median(baseline.map(r=>r.metrics[name])),next=median(candidate.map(r=>r.metrics[name]));
    return {name,baseline:base,candidate:next,regression:base===0?(next===0?0:null):next/base-1,threshold:0.10};
  });
  const regressions=metrics.filter(m=>m.regression===null||m.regression>0.10);
  if(!regressions.length)return {outcome:'PASS',reasons:[],metrics};
  if(!retestBaseline.length||!retestCandidate.length)return {outcome:'INCONCLUSIVE',requiresRetest:true,reasons:['regression-retest-required'],metrics};
  if(identityKeys.some(key=>retestBaseline[0]?.conditions?.[key]!==baseline[0]?.conditions?.[key]||retestCandidate[0]?.conditions?.[key]!==candidate[0]?.conditions?.[key])
    ||new Set([...baseline,...candidate,...retestBaseline,...retestCandidate].map(r=>r.processInstanceId)).size!==baseline.length+candidate.length+retestBaseline.length+retestCandidate.length)
    return {outcome:'INCONCLUSIVE',reasons:['retest-conditions-or-processes-differ'],metrics};
  const retest=compareRuns(retestBaseline,retestCandidate);
  if(retest.requiresRetest)return {outcome:'FAIL',reasons:['confirmed-regression'],metrics,retest:retest.metrics};
  return {outcome:retest.outcome,reasons:retest.reasons,metrics,retest:retest.metrics};
}
/** Promotion is an explicit CLI action; run/report/compare never invoke this. */
export function approveBaseline(candidate,approver){
  if(!approver?.trim()||candidate.outcome!=='PASS'||candidate.selectionFrozen!==true||!candidate.runs?.length)throw Error('Complete frozen candidate and explicit approver required');
  const groups=new Map();for(const run of candidate.runs){const key=digest(run.conditions);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);}
  if([...groups.values()].some(runs=>checkTriplet(runs).outcome!=='PASS'))throw Error('Baseline runs are incomplete');
  if(candidate.version==='gim-batch-results-v1'&&!candidate.baselineEligible)throw Error('Complete baseline batch required');
  if((candidate.version==='gim-benchmark-candidate-v1'||candidate.runs.some(run=>run.version==='gim-benchmark-v1'))&&candidate.measurementAcceptance?.outcome!=='PASS')throw Error('Measurement acceptance evidence required before baseline approval');
  return {...candidate,approval:{approver:approver.trim(),at:new Date().toISOString(),candidateDigest:digest(candidate)}};
}

/** Compare corresponding scenarios; never mix different samples into one median. */
export function compareSuites(baseline,candidate,options={}){
  const group=rows=>{const result=new Map();for(const row of rows){const key=digest([row.conditions?.sampleId,row.conditions?.sourceSha256,row.conditions?.scenario,row.conditions?.cacheState,row.conditions?.mode]);if(!result.has(key))result.set(key,[]);result.get(key).push(row);}return result;};
  const b=group(baseline),c=group(candidate),rb=group(options.retestBaseline??[]),rc=group(options.retestCandidate??[]);
  const comparisons=[];
  for(const key of new Set([...b.keys(),...c.keys()])){
    const rows=b.get(key)??c.get(key),conditions=rows[0].conditions;
    comparisons.push({sampleId:conditions?.sampleId,sourceSha256:conditions?.sourceSha256,scenario:conditions?.scenario,cacheState:conditions?.cacheState,
      ...(!b.has(key)||!c.has(key)?{outcome:'INCONCLUSIVE',reasons:['scenario-missing']}:
        compareRuns(b.get(key),c.get(key),{retestBaseline:rb.get(key)??[],retestCandidate:rc.get(key)??[]}))});
  }
  return {outcome:comparisons.some(row=>row.outcome==='FAIL')?'FAIL':comparisons.length&&comparisons.every(row=>row.outcome==='PASS')?'PASS':'INCONCLUSIVE',
    requiresRetest:comparisons.some(row=>row.requiresRetest),comparisons};
}
