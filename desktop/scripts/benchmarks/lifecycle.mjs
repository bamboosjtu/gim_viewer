import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {median} from './compare.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(cdp,predicate,timeout=900000){
  const deadline=performance.now()+timeout;
  while(performance.now()<deadline){const value=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');if(value.openError)throw Error('lifecycle-open-failed');if(predicate(value))return value;await delay(250);}
  throw Error('lifecycle-wait-timeout');
}
async function closeAndCheck(cdp,processSampler){
  await cdp.evaluate('globalThis.__gimBenchmark.close()',undefined,30000);
  let resources;
  for(let i=0;i<40;i++){resources=await cdp.evaluate('globalThis.__gimBenchmark.resources()');if(Object.values(resources).every(v=>v===0))break;await delay(250);}
  await delay(3000);
  const memory=await processSampler.checkpoint('after-project-close');
  return {resources,memory,passed:Object.values(resources).every(v=>v===0)&&memory.availability==='available'};
}
/** Reuse one app process so process exit cannot conceal project-resource leaks. */
export function lifecycleExercise({sample,secondSample,cycles=10,timeoutMs=900000}){
  return async({cdp,processSampler,manifest,runId,build,out,evidence})=>{
    const rows=[];const expected=evidence;
    const open=async(target,tag)=>{
      const config={runId:`${runId}-${tag}`,sourceSha256:target.sourceSha256,buildId:build.sourceFingerprint,mode:'benchmark'};
      await cdp.evaluate(`globalThis.__gimBenchmark.open(...${JSON.stringify([target.sampleId,manifest.nonce,config])}).catch(()=>{});undefined`);
    };
    for(let i=0;i<cycles;i++){
      if(i){await open(sample,`cycle-${i+1}`);await waitFor(cdp,s=>!s.opening&&s.progress.automaticSettled&&s.progress.cacheSettled&&s.progress.backgroundSettled&&!s.measurement.activeTasks.length,timeoutMs);}
      const actual=await cdp.evaluate('globalThis.__gimBenchmark.evidence()',undefined,30000);
      const equivalent=actual.passed&&['semanticDigest','pendingDigest','pendingCount','pendingSourceCount',
        'placementDigest','baseGeometryDigest','baseArtifactDigest'].every(key=>actual[key]===expected[key]);
      rows.push({cycle:i+1,equivalent,...await closeAndCheck(cdp,processSampler)});
      writeFileSync(join(out,'lifecycle-progress.json'),JSON.stringify(rows,null,2));
    }
    // Close after the product session has begun; the open Promise must settle.
    let previous=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
    await open(sample,'cancel');await waitFor(cdp,s=>s.session.generation!==previous.session.generation&&s.session.sourceSha256===sample.sourceSha256&&!s.progress.automaticSettled,30000);
    const cancellation=await closeAndCheck(cdp,processSampler);
    let replacement=null;
    if(secondSample){
      previous=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
      await open(sample,'replace-a');await waitFor(cdp,s=>s.session.generation!==previous.session.generation&&s.session.sourceSha256===sample.sourceSha256&&!s.progress.automaticSettled,30000);
      await open(secondSample,'replace-b');await waitFor(cdp,s=>!s.opening&&s.session.sourceSha256===secondSample.sourceSha256&&s.progress.automaticSettled&&s.progress.cacheSettled&&s.progress.backgroundSettled&&!s.measurement.activeTasks.length,timeoutMs);
      const result=await cdp.evaluate('globalThis.__gimBenchmark.evidence()',undefined,30000),closed=await closeAndCheck(cdp,processSampler);
      replacement={sourceMatches:result.sourceSha256===secondSample.sourceSha256,evidencePassed:result.passed,...closed,passed:result.passed&&closed.passed};
    }
    const before=rows.slice(1,4).map(r=>r.memory.bytes).filter(Number.isFinite),after=rows.slice(-3).map(r=>r.memory.bytes).filter(Number.isFinite);
    const retainedGrowth=before.length===3&&after.length===3?median(after)/median(before)-1:null;
    return {kind:'same-process-ten-open-close',cycles:rows,cancellation,replacement,retainedGrowth,
      outcome:rows.length===10&&rows.every(row=>row.passed&&row.equivalent)&&cancellation.passed&&(!replacement||replacement.passed&&replacement.sourceMatches)&&retainedGrowth!==null&&retainedGrowth<=0.1?'PASS':'FAIL',
      forcedGc:false,comparison:'median-post-close-cycles-2-to-4-vs-last-3'};
  };
}
