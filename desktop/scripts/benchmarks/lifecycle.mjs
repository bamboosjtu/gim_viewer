import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {retainedMemory} from './statistics.mjs';
import {assessCorrectness} from './correctness.mjs';
import {digest,sha} from './evidence.mjs';
import {lifecycleRetention} from './performance-policy.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(cdp,predicate,timeout=900000,wait=delay){
  const deadline=performance.now()+timeout;
  while(performance.now()<deadline){const value=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');if(value.openError)throw Error('lifecycle-open-failed');if(predicate(value))return value;await wait(250);}
  throw Error('lifecycle-wait-timeout');
}
async function closeAndCheck(cdp,processSampler,wait){
  await cdp.evaluate('globalThis.__gimBenchmark.close()',undefined,30000);
  let resources;
  for(let i=0;i<40;i++){resources=await cdp.evaluate('globalThis.__gimBenchmark.resources()');if(Object.values(resources).every(v=>v===0))break;await wait(250);}
  await wait(3000);
  const memory=await processSampler.checkpoint('after-project-close');
  return {resources,memory,passed:Object.values(resources).every(v=>v===0)&&memory.availability==='available'};
}
const accepted=assessment=>assessment.correctness==='passed'||assessment.correctness==='partial'&&assessment.defectAssessment?.status==='evidence-backed';
export function lifecycleEvidenceEquivalent(expected,actual){
  const before=assessCorrectness(expected),after=assessCorrectness(actual);
  return accepted(before)&&accepted(after)&&sha(expected.sourceSha256)&&expected.sourceSha256===actual.sourceSha256&&
    expected.projectType===actual.projectType&&digest(before)===digest(after)&&
    ['semanticDigest','pendingDigest','pendingCount','pendingSourceCount','placementDigest','baseGeometryDigest','baseArtifactDigest']
      .every(key=>actual[key]===expected[key]);
}
/** Reuse one app process so process exit cannot conceal project-resource leaks. */
export function lifecycleExercise({sample,secondSample,cycles=10,timeoutMs=900000,wait=delay}){
  return async({cdp,processSampler,manifest,runId,build,out,evidence})=>{
    const rows=[];const expected=evidence,reference={sourceSha256:expected.sourceSha256,...assessCorrectness(expected)};
    const open=async(target,tag)=>{
      const config={runId:`${runId}-${tag}`,sourceSha256:target.sourceSha256,buildId:build.sourceFingerprint,mode:'benchmark'};
      await cdp.evaluate(`globalThis.__gimBenchmark.open(...${JSON.stringify([target.sampleId,manifest.nonce,config])}).catch(()=>{});undefined`);
    };
    for(let i=0;i<cycles;i++){
      if(i){await open(sample,`cycle-${i+1}`);await waitFor(cdp,s=>!s.opening&&s.progress.automaticSettled&&s.progress.cacheSettled&&s.progress.backgroundSettled&&!s.measurement.activeTasks.length,timeoutMs,wait);}
      const actual=await cdp.evaluate('globalThis.__gimBenchmark.evidence()',undefined,30000);
      const equivalent=lifecycleEvidenceEquivalent(expected,actual);
      rows.push({cycle:i+1,equivalent,...assessCorrectness(actual),...await closeAndCheck(cdp,processSampler,wait)});
      writeFileSync(join(out,'lifecycle-progress.json'),JSON.stringify(rows,null,2));
    }
    // Close after the product session has begun; the open Promise must settle.
    let previous=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
    await open(sample,'cancel');await waitFor(cdp,s=>s.session.generation!==previous.session.generation&&s.session.sourceSha256===sample.sourceSha256&&!s.progress.automaticSettled,30000,wait);
    const cancellation=await closeAndCheck(cdp,processSampler,wait);
    let replacement=null;
    if(secondSample){
      previous=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
      await open(sample,'replace-a');await waitFor(cdp,s=>s.session.generation!==previous.session.generation&&s.session.sourceSha256===sample.sourceSha256&&!s.progress.automaticSettled,30000,wait);
      await open(secondSample,'replace-b');await waitFor(cdp,s=>!s.opening&&s.session.sourceSha256===secondSample.sourceSha256&&s.progress.automaticSettled&&s.progress.cacheSettled&&s.progress.backgroundSettled&&!s.measurement.activeTasks.length,timeoutMs,wait);
      const result=await cdp.evaluate('globalThis.__gimBenchmark.evidence()',undefined,30000),closed=await closeAndCheck(cdp,processSampler,wait);
      const assessment=assessCorrectness(result),evidencePassed=accepted(assessment);
      replacement={sourceMatches:result.sourceSha256===secondSample.sourceSha256,evidencePassed,...assessment,...closed,passed:evidencePassed&&closed.passed};
    }
    const {growth:retainedGrowth}=retainedMemory(rows),performanceAssessment=lifecycleRetention(retainedGrowth);
    return {kind:'same-process-ten-open-close',reference,cycles:rows,cancellation,replacement,retainedGrowth,
      performanceAssessment,outcomeMeaning:'resource-integrity-and-retention-cap-only; not baseline approval',
      outcome:rows.length===10&&rows.every(row=>row.passed&&row.equivalent)&&cancellation.passed&&(!replacement||replacement.passed&&replacement.sourceMatches)&&performanceAssessment.withinLimit?'PASS':'FAIL',
      forcedGc:false,comparison:'median-post-close-cycles-2-to-4-vs-last-3'};
  };
}
