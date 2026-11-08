import {createHash} from 'node:crypto';
const identityKeys=['machineId','runtimeSha256','buildMode','measurementVersion','detailPolicy','lifecyclePolicy','contentPolicy','mode','scenario','cacheState','sourceSha256','sampleId','profileDigest','workloadDigest','routeDigest','viewportDigest'];
export function digest(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function median(values){const rows=[...values].sort((a,b)=>a-b);return rows.length%2?rows[(rows.length-1)/2]:(rows[rows.length/2-1]+rows[rows.length/2])/2;}
const sha=value=>/^[a-f0-9]{64}$/.test(value??'');
export function contentEvidenceIssue(run){
  if(run.projectType==='transmission_line')return null;
  if(!['substation','equipment'].includes(run.projectType))return 'project-type-unverified';
  const proof=run.contentEvidence;
  if(proof?.complete!==true||proof.scope!=='DEV-L0-GLB-artifacts'||
    !Number.isSafeInteger(proof.coveredOccurrences)||!Number.isSafeInteger(proof.expectedShownOccurrences)||
    proof.coveredOccurrences!==proof.expectedShownOccurrences||proof.missingArtifactSha!==0||proof.duplicateArtifactIds!==0)
    return 'dev-content-evidence-incomplete';
  if(proof.availability==='not-applicable'&&proof.coveredOccurrences===0)return null;
  return proof.availability==='available'&&sha(proof.digest)&&sha(proof.placementFingerprint)
    ?null:'dev-content-evidence-incomplete';
}
const contentSignature=run=>run.contentEvidence?.availability==='available'
  ?`${run.contentEvidence.digest}:${run.contentEvidence.placementFingerprint}`:'not-applicable';
export function partialSignature(run){const row=run.defectAssessment??{};
  return row.kind==='coverage'?`coverage:${row.coverageDigest}`:
    row.kind==='combined'?`combined:${row.sourceSetDigest}:${row.failedOccurrences}:${row.coverageDigest}`:
    row.kind==='input-variant'?`input-variant:${row.variant}:${run.cacheFailureCode}`:
      `source-geometry:${row.sourceSetDigest}:${row.failedOccurrences}`;
}
export function runReadiness(run){
  if(run.environmentSuspend?.code==='INFRA_SUSPEND')return {outcome:'INCONCLUSIVE',reasons:['INFRA_SUSPEND']};
  if(run.inputIntegrity==='corrupt')return {outcome:'INPUT_ERROR',reasons:['INPUT_CORRUPT']};
  if(run.crashed)return {outcome:'FAIL',reasons:['native-process-crashed']};
  if(run.correctness==='failed')return {outcome:'FAIL',reasons:[run.defectAssessment?.status??'product-invariant-failed']};
  if((run.cacheFailureCount??((run.evidence?.progress?.cache?.writeFailures??0)+(run.evidence?.progress?.cache?.readFailures??0)))>0)
    return {outcome:'FAIL',reasons:['cache-io-failed']};
  const reasons=[];
  for(const key of identityKeys)if(run.conditions?.[key]==null)reasons.push(`missing-condition:${key}`);
  if(run.conditions?.mode!=='benchmark')reasons.push('not-benchmark-mode');
  if(!['passed','partial'].includes(run.correctness))reasons.push('correctness-unverified');
  if(run.correctness==='partial'){
    const row=run.defectAssessment;
    const valid=row?.sourceSha256===run.conditions?.sourceSha256&&(
      row.kind==='coverage'?row.status==='evidence-backed'&&/^[a-f0-9]{64}$/.test(row.coverageDigest??''):
      row.kind==='combined'?row.status==='evidence-backed'&&/^[a-f0-9]{64}$/.test(row.sourceSetDigest??'')&&
        /^[a-f0-9]{64}$/.test(row.coverageDigest??'')&&Number.isSafeInteger(row.failedOccurrences)&&row.failedOccurrences>0:
      row.kind==='input-variant'?row.status==='cache-not-persistable'&&run.cacheFailureCode==='CACHE_NOT_PERSISTABLE'&&
        ['bare-7z','bare-zip'].includes(row.variant):
        row.status==='evidence-backed'&&/^[a-f0-9]{64}$/.test(row.sourceSetDigest??'')&&
        Number.isSafeInteger(row.failedOccurrences)&&row.failedOccurrences>0);
    if(!valid)reasons.push('partial-defect-unverified');
  }
  if(run.version==='gim-benchmark-v1'&&run.projectType==='substation'&&
    (run.semanticDigestScope!=='engineering-with-pending-v2'||
      !/^[a-f0-9]{64}$/.test(run.evidence?.semanticDigest??'')||
      !/^[a-f0-9]{64}$/.test(run.pendingDigest??'')||!Number.isSafeInteger(run.pendingCount)||run.pendingCount<0||
      !Number.isSafeInteger(run.pendingSourceCount)||run.pendingSourceCount<0))reasons.push('pending-evidence-missing');
  if(run.measurementComplete!==true)reasons.push('measurement-incomplete');
  if((run.version==='gim-benchmark-v1'&&run.measurementLifecycleComplete!==true)||
    run.measurementLifecycleComplete===false||run.measurement?.lifecycleComplete===false)
    reasons.push('measurement-lifecycle-incomplete');
  if((run.measurementDetailDropped??run.measurement?.loss?.detailEvents??0)>0)
    reasons.push(`measurement-detail-truncated:${run.measurementDetailDropped??run.measurement.loss.detailEvents}`);
  if(run.version==='gim-benchmark-v1'&&run.processSampling?.complete!==true)reasons.push('native-process-memory-incomplete');
  if(run.conditions?.profileDigest==='unfrozen')reasons.push('profile-not-frozen');
  if(run.cacheVerified!==true&&!(run.correctness==='partial'&&run.defectAssessment?.kind==='input-variant'))
    reasons.push(run.cacheFailureCode??'cache-state-unverified');
  if(!run.processInstanceId)reasons.push('process-identity-missing');
  for(const name of run.requiredMetrics??[])if(!Number.isFinite(run.metrics?.[name])||run.metrics[name]<0)reasons.push(`missing-metric:${name}`);
  if(!run.requiredMetrics?.length)reasons.push('required-metrics-missing');
  return {outcome:reasons.length?'INCONCLUSIVE':run.correctness==='partial'?'PARTIAL':'PASS',reasons};
}
function checkGroup(runs){
  const checks=runs.map(runReadiness);if(checks.some(r=>r.outcome==='FAIL'))return {outcome:'FAIL',reasons:checks.flatMap(r=>r.reasons)};
  const reasons=checks.flatMap(r=>r.reasons);
  if(!runs.length||new Set(runs.map(r=>r.processInstanceId)).size!==runs.length)reasons.push('independent-processes-required');
  for(const key of identityKeys)if(runs.some(r=>r.conditions?.[key]!==runs[0]?.conditions?.[key]))reasons.push(`mixed-condition:${key}`);
  if(runs.some(r=>JSON.stringify(r.requiredMetrics)!==JSON.stringify(runs[0]?.requiredMetrics)))reasons.push('mixed-required-metrics');
  if(new Set(checks.map(row=>row.outcome)).size>1)reasons.push('mixed-completeness');
  if(checks[0]?.outcome==='PARTIAL'){
    const reference=partialSignature(runs[0]);
    if(runs.some(run=>partialSignature(run)!==reference))reasons.push('mixed-partial-coverage');
  }
  return {outcome:reasons.length?'INCONCLUSIVE':checks[0]?.outcome??'INCONCLUSIVE',reasons:[...new Set(reasons)]};
}
export function compareRuns(baseline,candidate,{retestBaseline=[],retestCandidate=[],requireContentEvidence=false}={}){
  const b=checkGroup(baseline),c=checkGroup(candidate),reasons=[...b.reasons,...c.reasons];
  if(b.outcome==='FAIL'||c.outcome==='FAIL')return {outcome:'FAIL',reasons};
  if(baseline.length!==candidate.length)reasons.push('repetition-count-differs');
  if(b.outcome!==c.outcome)reasons.push('coverage-status-differs');
  if(b.outcome==='PARTIAL'&&c.outcome==='PARTIAL'&&partialSignature(baseline[0])!==partialSignature(candidate[0]))
    reasons.push('partial-coverage-differs');
  for(const key of identityKeys)if(baseline[0]?.conditions?.[key]!==candidate[0]?.conditions?.[key])reasons.push(`incomparable:${key}`);
  if(JSON.stringify(baseline[0]?.requiredMetrics)!==JSON.stringify(candidate[0]?.requiredMetrics))reasons.push('incomparable:required-metrics');
  if(requireContentEvidence){
    for(const run of [...baseline,...candidate]){const issue=contentEvidenceIssue(run);if(issue)reasons.push(issue);}
    if(!reasons.length){
      if(new Set(baseline.map(contentSignature)).size!==1||new Set(candidate.map(contentSignature)).size!==1)
        reasons.push('dev-content-varies-within-repetitions');
      else if(contentSignature(baseline[0])!==contentSignature(candidate[0]))reasons.push('dev-content-digest-differs');
    }
  }
  if(reasons.length)return {outcome:'INCONCLUSIVE',reasons:[...new Set(reasons)],metrics:[]};
  const metrics=baseline[0].requiredMetrics.map(name=>{
    const base=median(baseline.map(r=>r.metrics[name])),next=median(candidate.map(r=>r.metrics[name]));
    return {name,baseline:base,candidate:next,regression:base===0?(next===0?0:null):next/base-1,threshold:0.10};
  });
  const regressions=metrics.filter(m=>m.regression===null||m.regression>0.10);
  if(!regressions.length)return {outcome:b.outcome,reasons:[],metrics};
  if(!retestBaseline.length||!retestCandidate.length)return {outcome:'INCONCLUSIVE',requiresRetest:true,reasons:['regression-retest-required'],metrics};
  if(identityKeys.some(key=>retestBaseline[0]?.conditions?.[key]!==baseline[0]?.conditions?.[key]||retestCandidate[0]?.conditions?.[key]!==candidate[0]?.conditions?.[key])
    ||new Set([...baseline,...candidate,...retestBaseline,...retestCandidate].map(r=>r.processInstanceId)).size!==baseline.length+candidate.length+retestBaseline.length+retestCandidate.length)
    return {outcome:'INCONCLUSIVE',reasons:['retest-conditions-or-processes-differ'],metrics};
  const retest=compareRuns(retestBaseline,retestCandidate,{requireContentEvidence});
  if(retest.requiresRetest)return {outcome:'FAIL',reasons:['confirmed-regression'],metrics,retest:retest.metrics};
  return {outcome:retest.outcome,reasons:retest.reasons,metrics,retest:retest.metrics};
}
/** Promotion is an explicit CLI action; run/report/compare never invoke this. */
export function approveBaseline(candidate,approver,{acceptPartial=false}={}){
  if(!approver?.trim()||!['PASS','PARTIAL'].includes(candidate.outcome)||candidate.outcome==='PARTIAL'&&!acceptPartial||candidate.selectionFrozen!==true||!candidate.runs?.length)throw Error('Complete frozen candidate and explicit approver required');
  const groups=new Map();for(const run of candidate.runs){const key=digest(run.conditions);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);}
  if([...groups.values()].some(runs=>!['PASS','PARTIAL'].includes(checkGroup(runs).outcome)))throw Error('Baseline runs are incomplete');
  if(candidate.outcome==='PARTIAL'&&candidate.runs.some(run=>run.correctness==='partial'&&run.defectAssessment?.status!=='evidence-backed'))
    throw Error('Partial coverage lacks runtime evidence');
  if(candidate.runs.some(run=>run.cacheFailureCode==='CACHE_NOT_PERSISTABLE'))throw Error('Non-persistable cache cannot become a baseline');
  for(const run of candidate.runs){const issue=contentEvidenceIssue(run);if(issue)throw Error(`Baseline ${issue}`);}
  if([...groups.values()].some(runs=>new Set(runs.map(contentSignature)).size>1))throw Error('Baseline DEV content differs between repetitions');
  if(candidate.version==='gim-batch-results-v1'&&!candidate.baselineEligible)throw Error('Complete baseline batch required');
  if((candidate.version==='gim-benchmark-candidate-v1'||candidate.runs.some(run=>run.version==='gim-benchmark-v1'))&&candidate.measurementAcceptance?.outcome!=='PASS')throw Error('Measurement acceptance evidence required before baseline approval');
  return {...candidate,approval:{approver:approver.trim(),at:new Date().toISOString(),candidateDigest:digest(candidate),partialAccepted:candidate.outcome==='PARTIAL'}};
}

export function baselineApprovalIssue(baseline){
  if(!baseline.approval)return 'baseline-not-approved';
  const {approval,...candidate}=baseline;
  if(approval.candidateDigest!==digest(candidate))return 'baseline-approval-digest-mismatch';
  if((baseline.outcome==='PARTIAL'||(baseline.runs??[]).some(run=>run.correctness==='partial'))&&approval.partialAccepted!==true)
    return 'partial-baseline-not-accepted';
  return null;
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
        compareRuns(b.get(key),c.get(key),{retestBaseline:rb.get(key)??[],retestCandidate:rc.get(key)??[],
          requireContentEvidence:options.requireContentEvidence===true}))});
  }
  return {outcome:comparisons.some(row=>row.outcome==='FAIL')?'FAIL':comparisons.length&&comparisons.every(row=>row.outcome==='PASS')?'PASS':
    comparisons.length&&comparisons.every(row=>['PASS','PARTIAL'].includes(row.outcome))?'PARTIAL':'INCONCLUSIVE',
    requiresRetest:comparisons.some(row=>row.requiresRetest),comparisons};
}
