import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {basename,join,relative} from 'node:path';
import {digest,runReadiness,compareRuns} from './compare.mjs';
import {coldWarmEquivalent} from './profiles.mjs';
import {runNative} from './native-run.mjs';
import {artifactDirectory,loadBatchInputs} from './batch-input.mjs';
import {writeBatchReports} from './batch-report.mjs';
import {workspacePath} from './samples.mjs';

const terminal=new Set(['PASS','FAIL','ERROR','INPUT_ERROR','INCONCLUSIVE','SKIPPED','DUPLICATE','CANCELLED']);
const safeError=error=>/^[a-z][a-z0-9-]{0,100}$/.test(error?.message??'')?error.message:'native-run-error';
function recordReport(row,report,state){
  const readiness=runReadiness(report);
  Object.assign(row,{status:readiness.outcome,error:[report.reason,...readiness.reasons].filter(Boolean).join(';'),runId:report.runId,
    conditions:report.conditions,checks:report.evidence?.checks??[],workload:report.evidence?.progress?.workload??null,
    correctness:report.correctness,cacheVerified:report.cacheVerified,measurementComplete:report.measurementComplete,
    processSamples:report.processSampling?.samples,processSamplesAvailable:report.processSampling?.available,
    missingWorkerHeaps:report.missingWorkerMemory?.length,failedGeometry:report.evidence?.progress?.workload?.failed,
    pendingTasks:report.measurement?.activeTasks?.length,backgroundSettled:report.evidence?.progress?.backgroundSettled,
    cachePublication:report.evidence?.progress?.cache?.linePersistence??null,linePackAssessment:report.evidence?.cache?.linePackAssessment??null,
    geometryFailureReasons:Object.entries(report.evidence?.geometryDiagnostics?.reasons??{}).map(([reason,count])=>`${reason}:${count}`).join(';')});
  for(const key of ['firstResponseMs','firstGeometryMs','automaticLoadMs','cachePublishMs','processPrivatePeakBytes'])row[key]=report.metrics?.[key]??null;
  const context={runId:report.runId,sampleId:row.sampleId,sampleLabel:row.sampleLabel,sourceSha256:row.sourceSha256,repetition:row.repetition,cacheState:row.cacheState};
  for(const [stage,stats]of Object.entries(report.measurement?.phases??{}))state.stages.push({...context,stage,count:stats.count,totalMs:stats.totalMs,maxMs:stats.maxMs,
    ...Object.fromEntries(['p50','p95','p99'].flatMap(key=>[[`${key}LowerMs`,stats[key]?.lowerMs],[`${key}UpperMs`,stats[key]?.upperMs]]))});
  const heaps=new Map((report.workerMemory??[]).map(worker=>[worker.workerId,worker]));
  for(const [workerId,worker]of Object.entries(report.measurement?.workers??{})){
    const heap=heaps.get(workerId);state.workers.push({...context,workerId,family:worker.family,heapAvailability:heap?'available':'unavailable',heapSamples:heap?.samples??0,
      observedHeapPeakBytes:heap?.observedPeakBytes??null,maxSampleDelayMs:heap?.maxSampleDelayMs??null});
  }
}

/** One owned process at a time. Errors are data; only cancellation stops the queue. */
export async function executeBatch({root,buildManifest,inputs,out,privateOut,preset='survey',repetitions=preset==='baseline'?3:1,anonymize=true,
  timeoutMs=3600000,signal,execute=runNative,onProgress=()=>{}}){
  if(!['survey','baseline'].includes(preset))throw Error('Invalid preset');
  if(!Number.isInteger(repetitions)||repetitions<1||repetitions>100||!Number.isFinite(timeoutMs)||timeoutMs<1000)throw Error('Invalid repetitions/timeout');
  if(preset==='baseline'&&repetitions<3)throw Error('Baseline mode requires at least three repetitions');
  const cacheStates=preset==='baseline'?['cold','warm']:['cold'];
  privateOut??=artifactDirectory(root,join(root,'tmp','gim-bench','batches',`batch-${Date.now()}`));
  const build=JSON.parse(readFileSync(workspacePath(root,buildManifest),'utf8'));
  const body={version:'gim-batch-profile-v1',preset,repetitions,cacheStates,mode:'benchmark',timeoutMs,
    cases:inputs.samples.map(({paths,...sample})=>sample)};
  const profileDigest=digest(body),state={version:'gim-batch-results-v1',status:'RUNNING',outcome:'INCONCLUSIVE',preset,repetitions,
    buildFingerprint:build.sourceFingerprint,profileDigest,anonymize,selectionFrozen:true,baselineEligible:false,rows:[],runs:[],stages:[],workers:[],pairs:[],updatedAt:null};
  const privateRuns=[];
  writeFileSync(join(out,'profile.json'),JSON.stringify({...body,digest:profileDigest},null,2));
  for(const entry of inputs.entries){
    const {privatePath,actions,...publicEntry}=entry;
    publicEntry.sampleLabel=anonymize?entry.sourceSha256??entry.inputId:privatePath?basename(privatePath):entry.inputId;
    if(!anonymize&&privatePath)publicEntry.sourcePath=relative(root,privatePath).replaceAll('\\','/');
    if(entry.status!=='READY')state.rows.push({...publicEntry,repetition:null,cacheState:'none'});
    else for(let repetition=1;repetition<=repetitions;repetition++)for(const cacheState of cacheStates)
      state.rows.push({...publicEntry,repetition,cacheState,status:'PENDING'});
  }
  const save=()=>{state.updatedAt=new Date().toISOString();writeBatchReports(out,state);};
  save();
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const stopTimer=setInterval(()=>{if(existsSync(join(out,'stop.request')))abort();},500);
  try{
    for(let repetition=1;repetition<=repetitions;repetition++)for(const sample of inputs.samples){
      let cold=null;
      for(const cacheState of cacheStates){
        const row=state.rows.find(row=>row.inputId===sample.inputId&&row.repetition===repetition&&row.cacheState===cacheState);
        if(controller.signal.aborted){row.status='CANCELLED';row.error='batch-cancelled';continue;}
        if(cacheState==='warm'&&(!cold||cold.report.correctness!=='passed'||!cold.report.cacheVerified||cold.report.reason)){
          row.status='SKIPPED';row.error='warm-preparation-incomplete';save();continue;
        }
        row.status='RUNNING';save();onProgress({inputId:row.inputId,sample:row.sampleLabel,sourceSha256:row.sourceSha256,repetition,cacheState,completed:state.rows.filter(row=>terminal.has(row.status)).length,total:state.rows.length});
        try{
          const result=await execute({root,buildManifest,sample,profileDigest,mode:'benchmark',scenario:sample.actions.length?'open-and-fidelity':'open',
            actions:sample.actions,timeoutMs,cacheState,...(cold?{dataRoot:cold.dataRoot}:{}),signal:controller.signal});
          recordReport(row,result.report,state);
          const report=result.report;
          state.runs.push(Object.fromEntries(['version','runId','processInstanceId','conditions','buildFingerprint','correctness','cacheVerified','measurementComplete','requiredMetrics','metrics','processSampling','crashed','reason'].map(key=>[key,report[key]])));
          privateRuns.push({inputId:sample.inputId,repetition,cacheState,out:result.out,dataRoot:result.dataRoot});
          if(controller.signal.aborted){row.status='CANCELLED';row.error='batch-cancelled';}
          else if(cacheState==='cold')cold=result;
          else{const pair={sampleId:sample.sampleId,repetition,...coldWarmEquivalent(cold.report,result.report)};state.pairs.push(pair);
            if(pair.outcome==='FAIL'){row.status='FAIL';row.error=[row.error,...pair.reasons].filter(Boolean).join(';');}}
        }catch(error){row.status=controller.signal.aborted?'CANCELLED':'ERROR';row.error=controller.signal.aborted?'batch-cancelled':safeError(error);
          writeFileSync(join(privateOut,`${row.inputId}-${repetition}-${cacheState}.private.log`),String(error?.stack??error));}
        writeFileSync(join(privateOut,'runs.private.json'),JSON.stringify(privateRuns,null,2));save();
      }
    }
  }finally{clearInterval(stopTimer);signal?.removeEventListener('abort',abort);}
  state.status=controller.signal.aborted?'CANCELLED':'COMPLETE';
  state.outcome=state.rows.some(row=>['FAIL','ERROR','INPUT_ERROR'].includes(row.status))?'FAIL':state.rows.every(row=>['PASS','DUPLICATE'].includes(row.status))?'PASS':'INCONCLUSIVE';
  const groups=new Map();for(const run of state.runs){const key=digest([run.conditions.sampleId,run.conditions.scenario,run.conditions.cacheState,run.conditions.routeDigest]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);}
  state.baselineEligible=preset==='baseline'&&state.outcome==='PASS'&&state.pairs.length===inputs.samples.length*repetitions
    &&[...groups.values()].every(runs=>compareRuns(runs,runs).outcome==='PASS');
  save();return {out,result:state};
}

export async function runBatch(options){
  const {root,directory,registry}=options;
  const out=artifactDirectory(root,options.out??join(root,'output','gim-bench',`batch-${Date.now()}`));
  if(existsSync(join(out,'results.json')))throw Error('Output already contains a batch; choose a new output directory');
  const privateOut=artifactDirectory(root,join(root,'tmp','gim-bench','batches',`batch-${Date.now()}`));
  const inputs=await loadBatchInputs(root,{directory,registry});
  writeFileSync(join(privateOut,'inputs.private.json'),JSON.stringify(inputs,null,2));
  writeFileSync(join(privateOut,'output.private.json'),JSON.stringify({out}));
  return executeBatch({...options,out,privateOut,inputs});
}
