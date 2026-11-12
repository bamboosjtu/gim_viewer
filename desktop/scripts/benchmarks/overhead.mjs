import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runNative} from './native-run.mjs';
import {partialSignature} from './compare.mjs';
import {median} from './statistics.mjs';
import {verifyProfile} from './profiles.mjs';
import {performanceComparison} from './performance-policy.mjs';

/** A matrix's actions belong to its frozen Profile, never the sample registry. */
export function resolveOverheadPlan({candidate,profile,sample}){
  if(!candidate&&!profile)throw Error('--profile or --candidate required');
  if(profile){
    verifyProfile(profile);
    if(candidate&&candidate.profileDigest!==profile.digest)throw Error('Frozen profile does not match candidate');
  }else if(candidate.version!=='gim-batch-results-v1'){
    throw Error('--profile is required with a matrix candidate to preserve its frozen actions');
  }
  const run=candidate?.runs?.find(row=>row.conditions?.sampleId===sample?.sampleId&&row.conditions?.sourceSha256===sample?.sourceSha256);
  const caseSpec=profile?profile.cases.find(row=>row.sampleId===sample?.sampleId&&row.sourceSha256===sample?.sourceSha256)
    :run?{scenario:run.conditions.scenario,actions:sample.actions??[],timeoutMs:3600000}:null;
  if(!sample||!caseSpec||candidate&&(!run||run.conditions.scenario!==caseSpec.scenario))
    throw Error('Sample and scenario must belong to the frozen profile or candidate');
  return {profile:profile??{digest:candidate.profileDigest},caseSpec};
}

export async function measureProbeOverhead({root,buildManifest,sample,profile,caseSpec,repetitions=3}){
  const runs=[];const out=join(root,'tmp','gim-bench',`overhead-${Date.now()}`);mkdirSync(out,{recursive:true});
  for(let round=0;round<repetitions;round++)for(const mode of round%2?['benchmark','off']:['off','benchmark']){
    writeFileSync(join(out,'progress.json'),JSON.stringify({round,mode,completed:runs.length},null,2));
    const result=await runNative({root,buildManifest,sample,profileDigest:profile.digest,scenario:caseSpec.scenario,actions:caseSpec.actions,timeoutMs:caseSpec.timeoutMs,mode});runs.push(result.report);
  }
  const off=runs.filter(r=>r.conditions.mode==='off'),on=runs.filter(r=>r.conditions.mode==='benchmark');
  const complete=repetitions>=3&&runs.every(r=>['passed','partial'].includes(r.correctness)&&r.cacheVerified&&r.processSampling.complete&&!r.reason)
    &&on.every(r=>r.measurementComplete)&&runs.every(r=>r.conditions.workloadDigest===runs[0].conditions.workloadDigest&&r.conditions.routeDigest===runs[0].conditions.routeDigest);
  const consistentCoverage=new Set(runs.map(r=>r.correctness)).size===1&&(
    runs[0].correctness!=='partial'||runs.every(r=>partialSignature(r)===partialSignature(runs[0])));
  const metrics=['firstResponseMs','automaticLoadMs','processPrivatePeakBytes'].map(name=>{
    const base=median(off.map(r=>r.metrics[name])),value=median(on.map(r=>r.metrics[name]));return {name,off:base,benchmark:value,regression:base>0?value/base-1:null};
  });
  const performanceAssessment=performanceComparison(off,on,{comparable:complete&&consistentCoverage});
  const outcome=!complete||!consistentCoverage||performanceAssessment.requiresHumanReview?'INCONCLUSIVE':runs[0].correctness==='partial'?'PARTIAL':'PASS';
  const result={kind:'same-build-probe-overhead',outcome,profileDigest:profile.digest,metrics,runs,performanceAssessment,
    independentProcesses:true,alternatingOrder:true,baselineApprovalStatus:'PENDING'};
  writeFileSync(join(out,'overhead.json'),JSON.stringify(result,null,2));return {out,result};
}
