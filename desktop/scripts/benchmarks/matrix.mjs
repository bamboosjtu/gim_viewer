import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runNative} from './native-run.mjs';
import {verifyProfile,coldWarmEquivalent} from './profiles.mjs';
import {median,runReadiness,partialSignature} from './compare.mjs';
import {warmPreparation} from './warm-preparation.mjs';

/** No sample substitution or promotion. Every frozen case retains its outcome. */
export async function runMatrix({root,buildManifest,registry,profile,repetitions=profile.repetitions,mode=profile.mode,execute=runNative}){
  verifyProfile(profile);if(!Number.isInteger(repetitions)||repetitions<1)throw Error('Invalid repetitions');
  const out=join(root,'output','gim-bench',`matrix-${Date.now()}`);mkdirSync(out,{recursive:true});
  const runs=[],pairs=[],required=profile.cases.length*repetitions*2;
  const save=(active=null)=>writeFileSync(join(out,'progress.json'),JSON.stringify({profileDigest:profile.digest,completed:runs.length,required,active,pairs},null,2));
  for(let repetition=0;repetition<repetitions;repetition++)for(const row of profile.cases){
    const sample=registry.samples.find(s=>s.sampleId===row.sampleId&&s.sourceSha256===row.sourceSha256);if(!sample)throw Error('Frozen sample missing');
    save({sampleId:sample.sampleId,repetition,cacheState:'cold'});
    const cold=await execute({root,buildManifest,sample,profileDigest:profile.digest,scenario:row.scenario,actions:row.actions,timeoutMs:row.timeoutMs,mode});
    runs.push({...cold.report,repetition});writeFileSync(join(out,'runs.partial.json'),JSON.stringify(runs));save({sampleId:sample.sampleId,repetition,cacheState:'warm'});
    const preparation=warmPreparation(cold.report);
    if(!preparation.ready){
      pairs.push({sampleId:sample.sampleId,repetition,outcome:cold.report.correctness==='failed'?'FAIL':'INCONCLUSIVE',
        reasons:[preparation.reason],cacheFailureCode:cold.report.cacheFailureCode??null,
        inputVariant:cold.report.inputVariant??null,
        partialSignature:cold.report.correctness==='partial'?partialSignature(cold.report):null});continue;
    }
    const warm=await execute({root,buildManifest,sample,profileDigest:profile.digest,scenario:row.scenario,actions:row.actions,timeoutMs:row.timeoutMs,mode,cacheState:'warm',dataRoot:cold.dataRoot});
    runs.push({...warm.report,repetition});pairs.push({sampleId:sample.sampleId,repetition,...coldWarmEquivalent(cold.report,warm.report)});save();
    writeFileSync(join(out,'runs.partial.json'),JSON.stringify(runs));
  }
  const families=new Set(runs.flatMap(run=>Object.values(run.measurement?.workers??{}).map(worker=>worker.family)));
  const missingFamilies=profile.requiredWorkerFamilies.filter(family=>!families.has(family));
  const checks=runs.map(runReadiness),failed=checks.some(check=>check.outcome==='FAIL')||pairs.some(pair=>pair.outcome==='FAIL');
  const complete=runs.length===required&&repetitions>=3&&!missingFamilies.length&&checks.every(check=>['PASS','PARTIAL'].includes(check.outcome))&&pairs.every(pair=>['PASS','PARTIAL'].includes(pair.outcome));
  const outcome=failed?'FAIL':complete?(checks.some(check=>check.outcome==='PARTIAL')||pairs.some(pair=>pair.outcome==='PARTIAL')?'PARTIAL':'PASS'):'INCONCLUSIVE';
  const summaries=[];for(const row of profile.cases)for(const cacheState of ['cold','warm']){
    const samples=runs.filter(run=>run.conditions.sampleId===row.sampleId&&run.conditions.cacheState===cacheState);
    const metrics={};for(const key of ['firstResponseMs','firstGeometryMs','automaticLoadMs','processPrivatePeakBytes']){
      const values=samples.map(run=>run.metrics[key]).filter(Number.isFinite);metrics[key]=values.length===samples.length&&values.length?median(values):null;
    }summaries.push({sampleId:row.sampleId,cacheState,runs:samples.length,metrics});
  }
  const result={version:'gim-benchmark-candidate-v1',outcome,selectionFrozen:true,profileDigest:profile.digest,requiredRuns:required,missingFamilies,pairs,summaries,runs,
    approval:null,baselinePromotion:'explicit-approval-required'};
  writeFileSync(join(out,'candidate.json'),JSON.stringify(result,null,2));save();return {out,result};
}
