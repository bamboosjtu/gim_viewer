import {digest,reviewerValid} from './evidence.mjs';
import {measurementAcceptanceIssue} from './measurement-acceptance.mjs';
import {geometryChangeAllowed} from './geometry-review.mjs';
import {MEASUREMENT_VERSION} from '../../../packages/measurement-core/src/version.mjs';
export {digest} from './evidence.mjs';
const identityKeys=['machineId','runtimeSha256','buildMode','measurementVersion','detailPolicy','lifecyclePolicy','contentPolicy','cacheProofPolicy','webviewProfilePolicy','mode','scenario','cacheState','sourceSha256','sampleId','profileDigest','workloadDigest','routeDigest','viewportDigest'];
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
  if(run.recovery)return {outcome:'INCONCLUSIVE',reasons:['recovered-interruption']};
  if(run.environmentSuspend?.code==='INFRA_SUSPEND')return {outcome:'INCONCLUSIVE',reasons:['INFRA_SUSPEND']};
  if(run.inputIntegrity==='corrupt')return {outcome:'INPUT_ERROR',reasons:['INPUT_CORRUPT']};
  if(run.crashed)return {outcome:'FAIL',reasons:['native-process-crashed']};
  if(run.correctness==='failed')return {outcome:'FAIL',reasons:[run.defectAssessment?.status??'product-invariant-failed']};
  if((run.cacheFailureCount??((run.evidence?.progress?.cache?.writeFailures??0)+(run.evidence?.progress?.cache?.readFailures??0)))>0)
    return {outcome:'FAIL',reasons:['cache-io-failed']};
  const reasons=[];
  for(const key of identityKeys)if(run.conditions?.[key]==null)reasons.push(`missing-condition:${key}`);
  if(run.conditions?.measurementVersion!=null&&run.conditions.measurementVersion!==MEASUREMENT_VERSION)
    reasons.push('unsupported-measurement-version');
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
      !/^[a-f0-9]{64}$/.test(run.semanticDigest??run.evidence?.semanticDigest??'')||
      !/^[a-f0-9]{64}$/.test(run.pendingDigest??'')||!Number.isSafeInteger(run.pendingCount)||run.pendingCount<0||
      !Number.isSafeInteger(run.pendingSourceCount)||run.pendingSourceCount<0))reasons.push('pending-evidence-missing');
  if(run.measurementComplete!==true){reasons.push('measurement-incomplete');
    for(const item of run.measurementIncompleteItems??[])reasons.push(`measurement:${item}`);}
  if((run.version==='gim-benchmark-v1'&&run.measurementLifecycleComplete!==true)||
    run.measurementLifecycleComplete===false||run.measurement?.lifecycleComplete===false)
    reasons.push('measurement-lifecycle-incomplete');
  if(run.conditions?.profileDigest==='unfrozen')reasons.push('profile-not-frozen');
  if(run.cacheVerified!==true&&!(run.correctness==='partial'&&run.defectAssessment?.kind==='input-variant'))
    reasons.push(run.cacheFailureCode??'cache-state-unverified');
  if(!run.processInstanceId)reasons.push('process-identity-missing');
  for(const name of run.requiredMetrics??[])if(name!=='processPrivatePeakBytes'&&
    (!Number.isFinite(run.metrics?.[name])||run.metrics[name]<0))reasons.push(`missing-metric:${name}`);
  if(!run.requiredMetrics?.length)reasons.push('required-metrics-missing');
  return {outcome:reasons.length?'INCONCLUSIVE':run.correctness==='partial'?'PARTIAL':'PASS',reasons};
}
/** Suite evidence must be complete before per-run timing comparisons. */
export function suiteCompletenessIssues(suite){
  if(suite?.version==='gim-batch-results-v1'){
    const issues=[];
    if(suite.status!=='COMPLETE')issues.push('batch-not-complete');
    if(suite.baselineEligible!==true)issues.push('batch-baseline-ineligible');
    return issues;
  }
  if(suite?.version!=='gim-benchmark-candidate-v1')return [];
  const issues=[];
  if(!['PASS','PARTIAL'].includes(suite.outcome))issues.push(`matrix-outcome:${suite.outcome??'missing'}`);
  if(suite.selectionFrozen!==true)issues.push('matrix-selection-unfrozen');
  if(!Array.isArray(suite.missingFamilies)||suite.missingFamilies.length)
    issues.push(`matrix-worker-families-missing:${(suite.missingFamilies??[]).join(',')||'unverified'}`);
  const runs=suite.runs,pairs=suite.pairs;
  if(!Number.isSafeInteger(suite.requiredRuns)||suite.requiredRuns<2||suite.requiredRuns%2||
    !Array.isArray(runs)||runs.length!==suite.requiredRuns)issues.push('matrix-run-count-incomplete');
  if(!Array.isArray(pairs)||pairs.length!==suite.requiredRuns/2||
    pairs.some(pair=>!['PASS','PARTIAL'].includes(pair.outcome)))issues.push('matrix-cold-warm-pairs-incomplete');
  if(Array.isArray(runs)&&Array.isArray(pairs)){
    const counts=new Map();
    for(const run of runs){const key=JSON.stringify([run.conditions?.sampleId,run.repetition,run.conditions?.cacheState]);
      counts.set(key,(counts.get(key)??0)+1);}
    const expected=new Map();
    for(const pair of pairs)for(const cacheState of ['cold','warm']){
      const key=JSON.stringify([pair.sampleId,pair.repetition,cacheState]);expected.set(key,(expected.get(key)??0)+1);
    }
    if([...new Set([...counts.keys(),...expected.keys()])].some(key=>counts.get(key)!==expected.get(key)))
      issues.push('matrix-cold-warm-identity-incomplete');
  }
  return issues;
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
  const calibration=runs[0]?.conditions?.environmentCalibration;
  if(calibration&&runs.some(run=>{
    const row=run.conditions?.environmentCalibration;
    return row?.version!==calibration.version||row.availability==='unavailable'||
      !Number.isFinite(row.cpuMs)||!Number.isFinite(calibration.cpuMs)||
      row.cpuMs/calibration.cpuMs<0.85||row.cpuMs/calibration.cpuMs>1.15;
  }))reasons.push('mixed-environment-calibration');
  return {outcome:reasons.length?'INCONCLUSIVE':checks[0]?.outcome??'INCONCLUSIVE',reasons:[...new Set(reasons)]};
}
function memoryComparisonIssue(run){
  if(!(run.requiredMetrics??[]).includes('processPrivatePeakBytes'))return null;
  return run.memoryEvidenceComplete===false||run.processSampling?.complete===false||
    !Number.isFinite(run.metrics?.processPrivatePeakBytes)
    ?'memory-evidence-incomplete':null;
}
function calibrationComparison(baseline,candidate){
  const left=baseline[0]?.conditions?.environmentCalibration;
  const right=candidate[0]?.conditions?.environmentCalibration;
  if(!left&&!right)return {ratios:null,issue:null};
  if(left?.version!=='gim-batch-calibration-v1'||right?.version!=='gim-batch-calibration-v1'||
    left.method!==right.method||left.checksum!==right.checksum||
    left.availability==='unavailable'||right.availability==='unavailable')
    return {ratios:null,issue:'environment-calibration-unavailable'};
  const ratios={};
  for(const key of ['cpuMs','writeSyncMs','readWarmMs']){
    if(!(left[key]>0&&right[key]>0))return {ratios:null,issue:'environment-calibration-unavailable'};
    ratios[key]=right[key]/left[key];
  }
  const issue=Object.entries(ratios).some(([key,ratio])=>
    key==='cpuMs'?(ratio<0.85||ratio>1.15):(ratio<0.7||ratio>1.3))
    ?'environment-calibration-drift':null;
  return {ratios,issue};
}
export function compareRuns(baseline,candidate,{retestBaseline=[],retestCandidate=[],requireContentEvidence=false,geometryChanges=[]}={}){
  const b=checkGroup(baseline),c=checkGroup(candidate),reasons=[...b.reasons,...c.reasons];
  if(b.outcome==='FAIL'||c.outcome==='FAIL')return {outcome:'FAIL',reasons};
  if(baseline.length!==candidate.length)reasons.push('repetition-count-differs');
  for(const run of [...baseline,...candidate]){const issue=memoryComparisonIssue(run);if(issue)reasons.push(issue);}
  const calibration=calibrationComparison(baseline,candidate);
  if(calibration.issue)reasons.push(calibration.issue);
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
      else if(contentSignature(baseline[0])!==contentSignature(candidate[0])&&
        !geometryChangeAllowed(baseline[0],candidate[0],geometryChanges))reasons.push('dev-content-digest-differs');
    }
  }
  if(reasons.length)return {outcome:'INCONCLUSIVE',reasons:[...new Set(reasons)],calibrationRatio:calibration.ratios,metrics:[]};
  const metrics=baseline[0].requiredMetrics.map(name=>{
    const base=median(baseline.map(r=>r.metrics[name])),next=median(candidate.map(r=>r.metrics[name]));
    return {name,baseline:base,candidate:next,regression:base===0?(next===0?0:null):next/base-1,threshold:0.10};
  });
  const regressions=metrics.filter(m=>m.regression===null||m.regression>0.10);
  if(!regressions.length)return {outcome:b.outcome,reasons:[],calibrationRatio:calibration.ratios,metrics};
  if(!retestBaseline.length||!retestCandidate.length)return {outcome:'INCONCLUSIVE',requiresRetest:true,reasons:['regression-retest-required'],calibrationRatio:calibration.ratios,metrics};
  if(identityKeys.some(key=>retestBaseline[0]?.conditions?.[key]!==baseline[0]?.conditions?.[key]||retestCandidate[0]?.conditions?.[key]!==candidate[0]?.conditions?.[key])
    ||new Set([...baseline,...candidate,...retestBaseline,...retestCandidate].map(r=>r.processInstanceId)).size!==baseline.length+candidate.length+retestBaseline.length+retestCandidate.length)
    return {outcome:'INCONCLUSIVE',reasons:['retest-conditions-or-processes-differ'],metrics};
  const retest=compareRuns(retestBaseline,retestCandidate,{requireContentEvidence,geometryChanges});
  if(retest.requiresRetest)return {outcome:'FAIL',reasons:['confirmed-regression'],metrics,retest:retest.metrics};
  return {outcome:retest.outcome,reasons:retest.reasons,metrics,retest:retest.metrics};
}
/** Promotion is an explicit CLI action; run/report/compare never invoke this. */
const partialReasonFor=kinds=>kinds.size===1?({coverage:'engineering-coverage','source-geometry':'source-geometry',combined:'combined-source'})[[...kinds][0]]:'mixed-source';
export function createPartialReview(input,sourceReviewer,partialReason){
  const {approval,...candidate}=input;
  if(candidate?.outcome!=='PARTIAL'||candidate.selectionFrozen!==true||!candidate.runs?.length||
    !reviewerValid(sourceReviewer))throw Error('Frozen PARTIAL candidate and source reviewer required');
  const partialRuns=candidate.runs.filter(run=>run.correctness==='partial');
  if(!partialRuns.length||partialRuns.some(run=>run.defectAssessment?.status!=='evidence-backed'))
    throw Error('Partial source evidence is incomplete');
  const kinds=new Set(partialRuns.map(run=>run.defectAssessment?.kind));
  if(partialReason!==partialReasonFor(kinds))throw Error('Partial reason must match the controlled source limitation');
  const review={version:'gim-partial-review-v1',candidateDigest:digest(candidate),sourceReviewer:sourceReviewer.trim(),
    partialReason,reviewedAt:new Date().toISOString()};
  return {...review,reviewDigest:digest(review)};
}
export function partialReviewIssue(review,input){
  const {approval,...candidate}=input;
  if(!review)return 'partial-review-required';
  const {reviewDigest,...metadata}=review;
  if(metadata.version!=='gim-partial-review-v1'||reviewDigest!==digest(metadata))return 'partial-review-digest-mismatch';
  if(metadata.candidateDigest!==digest(candidate))return 'partial-review-candidate-mismatch';
  if(!reviewerValid(metadata.sourceReviewer))return 'partial-reviewer-invalid';
  const kinds=new Set(candidate.runs.filter(run=>run.correctness==='partial').map(run=>run.defectAssessment?.kind));
  if(metadata.partialReason!==partialReasonFor(kinds))return 'partial-review-reason-mismatch';
  return null;
}
export function approveBaseline(input,approver,{acceptPartial=false,partialReview=null,firstPartial=false,previousBaseline=null}={}){
  const {approval:priorApproval,...candidate}=input;
  if(priorApproval)throw Error('Candidate is already approved');
  if(candidate.recovery||candidate.runs?.some(run=>run.recovery))throw Error('Recovered interruption cannot become a baseline');
  const suiteIssues=suiteCompletenessIssues(candidate);if(suiteIssues.length)throw Error(`Baseline ${suiteIssues.join(';')}`);
  if(!reviewerValid(approver)||!['PASS','PARTIAL'].includes(candidate.outcome)||candidate.outcome==='PARTIAL'&&!acceptPartial||candidate.selectionFrozen!==true||!candidate.runs?.length)throw Error('Complete frozen candidate and explicit approver required');
  const groups=new Map();for(const run of candidate.runs){const key=digest(run.conditions);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);}
  if([...groups.values()].some(runs=>!['PASS','PARTIAL'].includes(checkGroup(runs).outcome)))throw Error('Baseline runs are incomplete');
  if(candidate.runs.some(run=>memoryComparisonIssue(run)))throw Error('Baseline memory evidence is incomplete');
  if(candidate.runs.some(run=>run.version==='gim-benchmark-v1'&&
    (run.conditions?.environmentCalibration?.version!=='gim-batch-calibration-v1'||
      run.conditions.environmentCalibration.availability==='unavailable')))
    throw Error('Baseline environment calibration is incomplete');
  if(candidate.outcome==='PARTIAL'&&candidate.runs.some(run=>run.correctness==='partial'&&run.defectAssessment?.status!=='evidence-backed'))
    throw Error('Partial coverage lacks runtime evidence');
  if(candidate.outcome==='PARTIAL'){
    const issue=partialReviewIssue(partialReview,candidate);if(issue)throw Error(`Partial baseline ${issue}`);
    if(partialReview.sourceReviewer.toLowerCase()===approver.trim().toLowerCase())
      throw Error('Partial baseline requires a distinct source reviewer');
    if(firstPartial===!!previousBaseline)throw Error('Partial baseline requires either first-partial review or a previous approved baseline');
    if(previousBaseline){
      const issue=baselineApprovalIssue(previousBaseline);if(issue)throw Error(`Previous baseline ${issue}`);
      const prior=new Map(previousBaseline.runs.map(run=>[digest([run.conditions?.sourceSha256,run.conditions?.scenario,run.conditions?.cacheState]),run]));
      for(const run of candidate.runs){
        const old=prior.get(digest([run.conditions?.sourceSha256,run.conditions?.scenario,run.conditions?.cacheState]));
        if(run.correctness==='partial'&&!old)throw Error('Previous baseline lacks a matching partial scenario');
        if(old&&run.correctness==='partial'&&(old.correctness!=='partial'||partialSignature(old)!==partialSignature(run)))
          throw Error('Partial coverage differs from the previous approved baseline');
      }
    }
  }
  if(candidate.runs.some(run=>run.cacheFailureCode==='CACHE_NOT_PERSISTABLE'))throw Error('Non-persistable cache cannot become a baseline');
  for(const run of candidate.runs){const issue=contentEvidenceIssue(run);if(issue)throw Error(`Baseline ${issue}`);}
  if([...groups.values()].some(runs=>new Set(runs.map(contentSignature)).size>1))throw Error('Baseline DEV content differs between repetitions');
  if(candidate.version==='gim-batch-results-v1'&&!candidate.baselineEligible)throw Error('Complete baseline batch required');
  if(candidate.version==='gim-benchmark-candidate-v1'||candidate.runs.some(run=>run.version==='gim-benchmark-v1')){
    const issue=measurementAcceptanceIssue(candidate);if(issue)throw Error(`Measurement acceptance evidence required before baseline approval: ${issue}`);
  }
  const approval={approver:approver.trim(),at:new Date().toISOString(),candidateDigest:digest(candidate),
    partialAccepted:candidate.outcome==='PARTIAL',...(candidate.outcome==='PARTIAL'?{
      partialReason:partialReview.partialReason,sourceReviewer:partialReview.sourceReviewer,
      sourceReviewDigest:partialReview.reviewDigest,sourceReviewedAt:partialReview.reviewedAt,firstPartial,
      previousBaselineDigest:previousBaseline?digest(previousBaseline):null}: {})};
  return {...candidate,approval:{...approval,approvalDigest:digest(approval)}};
}

export function baselineApprovalIssue(baseline){
  const suiteIssues=suiteCompletenessIssues(baseline);if(suiteIssues.length)return suiteIssues[0];
  if(!baseline.approval)return 'baseline-not-approved';
  const {approval,...candidate}=baseline;
  if(approval.candidateDigest!==digest(candidate))return 'baseline-approval-digest-mismatch';
  const {approvalDigest,...metadata}=approval;
  if(approvalDigest!==digest(metadata))return 'baseline-approval-metadata-mismatch';
  if(baseline.version==='gim-benchmark-candidate-v1'||baseline.runs?.some(run=>run.version==='gim-benchmark-v1')){
    const issue=measurementAcceptanceIssue(baseline);if(issue)return issue;
  }
  if((baseline.outcome==='PARTIAL'||(baseline.runs??[]).some(run=>run.correctness==='partial'))&&
    (approval.partialAccepted!==true||!reviewerValid(approval.sourceReviewer)||
      approval.sourceReviewer.trim().toLowerCase()===approval.approver?.trim().toLowerCase()||
      !['engineering-coverage','source-geometry','combined-source','mixed-source'].includes(approval.partialReason)||
      !/^[a-f0-9]{64}$/.test(approval.sourceReviewDigest??'')||
      approval.firstPartial===!!approval.previousBaselineDigest))
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
          requireContentEvidence:options.requireContentEvidence===true,geometryChanges:options.geometryChanges??[]}))});
  }
  return {outcome:comparisons.some(row=>row.outcome==='FAIL')?'FAIL':comparisons.length&&comparisons.every(row=>row.outcome==='PASS')?'PASS':
    comparisons.length&&comparisons.every(row=>['PASS','PARTIAL'].includes(row.outcome))?'PARTIAL':'INCONCLUSIVE',
    requiresRetest:comparisons.some(row=>row.requiresRetest),comparisons};
}
