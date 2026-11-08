import {existsSync,readFileSync,writeFileSync,readdirSync,unlinkSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {basename,join,relative,resolve} from 'node:path';
import {digest,runReadiness,compareRuns,partialSignature} from './compare.mjs';
import {coldWarmEquivalent} from './profiles.mjs';
import {runNative} from './native-run.mjs';
import {sourceFingerprint} from './acceptance-build.mjs';
import {artifactDirectory,loadBatchInputs} from './batch-input.mjs';
import {writeBatchReports} from './batch-report.mjs';
import {workspacePath} from './samples.mjs';
import {isStartupInfrastructureFailure,STARTUP_ATTEMPTS,startupRetryDelayMs} from './startup-retry.mjs';
import {warmPreparation} from './warm-preparation.mjs';
import {calibrateBatch} from './batch-calibration.mjs';

const terminal=new Set(['PASS','PARTIAL','FAIL','ERROR','INPUT_ERROR','INCONCLUSIVE','SKIPPED','DUPLICATE','CANCELLED']);
const safeError=error=>/^[a-z][a-z0-9-]{0,100}$/.test(error?.message??'')?error.message:'native-run-error';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function recordReport(row,report,state){
  const readiness=runReadiness(report);
  Object.assign(row,{status:readiness.outcome,error:[report.reason,...readiness.reasons].filter(Boolean).join(';'),runId:report.runId,
    conditions:report.conditions,checks:report.evidence?.checks??[],workload:report.evidence?.progress?.workload??null,
    projectType:report.projectType??null,correctness:report.correctness,defectAssessment:report.defectAssessment??null,
    pendingCount:report.pendingCount??null,pendingSourceCount:report.pendingSourceCount??null,
    pendingDigest:report.pendingDigest??null,semanticDigestScope:report.semanticDigestScope??null,
    geometryStructuralFingerprint:report.geometryStructuralFingerprint??null,
    devContentDigest:report.contentEvidence?.digest??null,
    devContentCovered:report.contentEvidence?.coveredOccurrences??null,
    devContentComplete:report.contentEvidence?.complete??null,
    inputVariant:report.inputVariant??null,inputVariantCode:report.inputVariantCode??null,
    inputIntegrity:report.inputIntegrity??null,cacheFailureCode:report.cacheFailureCode??null,
    measurementDetailDropped:report.measurementDetailDropped??null,
    measurementDetailStatus:report.measurementDetailStatus??null,
    measurementLifecycleComplete:report.measurementLifecycleComplete??null,
    measurementIncompleteItems:(report.measurementIncompleteItems??[]).join(';'),
    memoryEvidenceComplete:report.memoryEvidenceComplete??null,
    memoryIncompleteItems:(report.memoryIncompleteItems??[]).join(';'),
    templateDiagnosticsStatus:report.templateDiagnosticsStatus??null,
    lateBackgroundTasks:report.lateBackgroundTasks??false,finalEvidenceIssue:report.finalEvidenceIssue??null,
    measurementLifecycleIssues:(report.measurementLifecycleIssues??[]).join(';'),
    cancelledBeforeStart:report.measurement?.loss?.cancelledBeforeStart??0,
    environmentSuspend:report.environmentSuspend?.code??null,
    measurementAggregatedDetail:Object.entries(report.measurementAggregatedDetail??{}).map(([kind,count])=>`${kind}:${count}`).join(';'),
    cachePublished:report.cachePublished??report.cacheVerified,coverageComplete:report.coverageComplete??null,
    engineeringCacheStatus:report.evidence?.progress?.cache?.engineering??null,
    devCatalogMisses:report.evidence?.catalogCacheEvidence?.missCount??null,
    sourceFailureCatalogMisses:report.evidence?.catalogCacheEvidence?.sourceFailureMissCount??null,
    unexplainedCatalogMisses:report.evidence?.catalogCacheEvidence?.unexplainedMissCount??null,
    catalogProofComplete:report.evidence?.catalogCacheEvidence?.accounted??null,
    devPartialOccurrences:report.evidence?.progress?.workload?.partial??null,
    partialGeometryReasons:Object.entries(report.evidence?.partialGeometryReasons??{}).map(([reason,count])=>`${reason}:${count}`).join(';'),
    geometryDiagnosticScope:report.evidence?.geometryDiagnosticScope??null,
    sourceReferenceStatuses:Object.entries(report.evidence?.engineeringCoverage?.referenceStatuses??{}).map(([status,count])=>`${status}:${count}`).join(';'),
    coverageIncompleteReasons:(report.evidence?.engineeringCoverage?.incompleteReasons??[]).join(';'),
    unresolvedReferenceCount:(report.evidence?.engineeringCoverage?.referenceStatuses?.missing??0)+
      (report.evidence?.engineeringCoverage?.referenceStatuses?.ambiguous??0),
    partialEvidenceStatus:report.defectAssessment?.status??null,
    partialEvidenceDigest:report.defectAssessment?.coverageDigest??report.defectAssessment?.sourceSetDigest??null,
    partialSignature:report.correctness==='partial'?partialSignature(report):null,
    cacheVerified:report.cacheVerified,measurementComplete:report.measurementComplete,
    processSamples:report.processSampling?.samples,processSamplesAvailable:report.processSampling?.available,
    missingWorkerHeaps:report.missingWorkerMemory?.length,unavailableWorkerHeaps:report.unavailableWorkerMemory?.length,
    shortLivedWorkerHeaps:report.shortLivedWorkerMemory?.length,
    notApplicableWorkerHeaps:report.notApplicableWorkerMemory?.length,
    failedGeometry:report.evidence?.progress?.workload?.failed,
    pendingTasks:report.measurement?.activeTasks?.length,backgroundSettled:report.evidence?.progress?.backgroundSettled,
    cachePublication:report.projectType==='substation'?
      row.cacheState==='warm'&&report.cacheVerified&&report.evidence?.progress?.cachePersistenceStatus==='not-observed'
        ?'reused':report.evidence?.progress?.cachePersistenceStatus??null:
      report.evidence?.progress?.cache?.linePersistence??null,
    linePackAssessment:report.evidence?.cache?.linePackAssessment??null,
    failedGeometryReasons:Object.entries(report.evidence?.geometryDefects?.failedReasons??{}).map(([reason,count])=>`${reason}:${count}`).join(';'),
    geometryStatuses:Object.entries(report.evidence?.geometryStatuses??{}).map(([status,count])=>`${status}:${count}`).join(';'),
    failedSourceSetDigest:report.evidence?.geometryDefects?.failedSourceSetDigest??null,
    failedSourceCount:report.evidence?.geometryDefects?.failedSourceCount??0});
  for(const key of ['firstResponseMs','modelTreeReadyMs','firstGeometryMs','allGeometryReadyMs','automaticLoadMs','cachePublishMs','settledMs','writeDrainMs','processPrivatePeakBytes'])row[key]=report.metrics?.[key]??null;
  const writeStats=report.measurement?.phases?.['host:host.cacheWrite'];
  const writeBytes=writeStats?.workload?.bytes;
  row.cacheWriteBytes=Number.isFinite(writeBytes)?writeBytes:null;
  row.cacheWriteMsPerMiB=writeBytes>0?writeStats.totalMs/(writeBytes/2**20):null;
  const context={runId:report.runId,sampleId:row.sampleId,sampleLabel:row.sampleLabel,sourceSha256:row.sourceSha256,repetition:row.repetition,cacheState:row.cacheState};
  for(const [stage,stats]of Object.entries(report.measurement?.phases??{}))state.stages.push({...context,stage,count:stats.count,totalMs:stats.totalMs,maxMs:stats.maxMs,
    workloadBytes:stats.workload?.bytes??null,msPerMiB:stats.workload?.bytes>0?stats.totalMs/(stats.workload.bytes/2**20):null,
    ...Object.fromEntries(['p50','p95','p99'].flatMap(key=>[[`${key}LowerMs`,stats[key]?.lowerMs],[`${key}UpperMs`,stats[key]?.upperMs]]))});
  for(const task of report.measurement?.slowestTasks??[])state.slowTasks.push({...context,...task});
  for(const phase of report.measurement?.slowestPhases??[])state.slowPhases.push({...context,...phase});
  for(const diagnostic of report.templateDiagnostics??[])state.templateDiagnostics.push({...context,...diagnostic});
  const heaps=new Map((report.workerMemory??[]).map(worker=>[worker.workerId,worker]));
  const unavailable=new Map((report.unavailableWorkerMemory??[]).map(worker=>[worker.workerId,worker]));
  const shortLived=new Map((report.shortLivedWorkerMemory??[]).map(worker=>[worker.workerId,worker]));
  const notApplicable=new Map((report.notApplicableWorkerMemory??[]).map(worker=>[worker.workerId,worker]));
  for(const [workerId,worker]of Object.entries(report.measurement?.workers??{})){
    const heap=heaps.get(workerId),unavailableRow=unavailable.get(workerId);
    state.workers.push({...context,workerId,family:worker.family,
      heapAvailability:unavailableRow?'unavailable':heap?'available':shortLived.has(workerId)?'short-lived':notApplicable.has(workerId)?'not-applicable':'missing',
      heapSamples:heap?.samples??unavailableRow?.successfulSamples??0,failedHeapSamples:unavailableRow?.failedSamples??heap?.failedSamples??0,
      heapReason:unavailableRow?.reason??shortLived.get(workerId)?.reason??notApplicable.get(workerId)?.reason??(heap?null:'worker-target-not-observed'),
      observedHeapPeakBytes:heap?.observedPeakBytes??null,maxSampleDelayMs:unavailableRow?.maxSampleDelayMs??heap?.maxSampleDelayMs??null,
      maxSampleGapMs:unavailableRow?.maxSampleGapMs??heap?.maxSampleGapMs??null});
  }
}

/** One owned process at a time. Errors are data; only cancellation stops the queue. */
export async function executeBatch({root,buildManifest,inputs,out,privateOut,preset='survey',repetitions=1,anonymize=true,
  timeoutMs=3600000,signal,execute=runNative,onProgress=()=>{},waitRetry=delay,environmentCalibration=null}){
  if(!['survey','baseline'].includes(preset))throw Error('Invalid preset');
  if(!Number.isInteger(repetitions)||repetitions<1||repetitions>100||!Number.isFinite(timeoutMs)||timeoutMs<1000)throw Error('Invalid repetitions/timeout');
  const cacheStates=preset==='baseline'?['cold','warm']:['cold'];
  privateOut??=artifactDirectory(root,join(root,'tmp','gim-bench','batches',`batch-${Date.now()}`));
  const build=JSON.parse(readFileSync(workspacePath(root,buildManifest),'utf8'));
  const body={version:'gim-batch-profile-v1',preset,repetitions,cacheStates,mode:'benchmark',detailPolicy:'task-phase-timeline-v2',lifecyclePolicy:'worker-terminal-v2',contentPolicy:'dev-l0-glb-sha256-v1',cacheProofPolicy:'source-failure-catalog-v1',webviewProfilePolicy:'paired-webview-profile-v1',timeoutMs,
    startupRetryPolicy:'pre-open-infrastructure-v1',maxStartupAttempts:STARTUP_ATTEMPTS,
    cases:inputs.samples.map(({paths,...sample})=>sample)};
  const profileDigest=digest(body),state={version:'gim-batch-results-v1',status:'RUNNING',outcome:'INCONCLUSIVE',preset,repetitions,
    buildFingerprint:build.sourceFingerprint,profileDigest,anonymize,environmentCalibration,selectionFrozen:true,baselineEligible:false,rows:[],runs:[],attempts:[],stages:[],slowTasks:[],slowPhases:[],templateDiagnostics:[],workers:[],pairs:[],updatedAt:null};
  const privateRuns=[];
  const controllerFile=join(privateOut,'controller.private.json'),nonce=randomBytes(24).toString('hex');
  writeFileSync(join(privateOut,'output.private.json'),JSON.stringify({out,nonce}));
  writeFileSync(controllerFile,JSON.stringify({pid:process.pid,nonce,
    processStartedAt:new Date(Date.now()-process.uptime()*1000).toISOString(),startedAt:new Date().toISOString()}));
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
        const warm=cacheState==='warm'?warmPreparation(cold?.report):null;
        if(warm&&!warm.ready){
          const coldRow=state.rows.find(item=>item.inputId===sample.inputId&&item.repetition===repetition&&item.cacheState==='cold');
          row.status='SKIPPED';row.error=coldRow?.startupFailures?.length&&warm.reason==='warm-preparation-incomplete'
            ?`cold-startup-infrastructure-unavailable:${coldRow.startupFailures.at(-1)}`:warm.reason;save();continue;
        }
        row.status='RUNNING';save();onProgress({inputId:row.inputId,sample:row.sampleLabel,sourceSha256:row.sourceSha256,repetition,cacheState,completed:state.rows.filter(row=>terminal.has(row.status)).length,total:state.rows.length});
        try{
          let result;
          row.startupFailures=[];
          for(let attempt=1;attempt<=STARTUP_ATTEMPTS;attempt++){
            if(controller.signal.aborted)break;
            result=await execute({root,buildManifest,sample,profileDigest,mode:'benchmark',scenario:sample.actions.length?'open-and-fidelity':'open',
              actions:sample.actions,timeoutMs,cacheState,environmentCalibration,...(cold?{dataRoot:cold.dataRoot}:{}),signal:controller.signal,
              onStarted:started=>{row.runId=started.runId;
                privateRuns.push({inputId:sample.inputId,repetition,cacheState,attempt,runId:started.runId,out:started.out,dataRoot:started.dataRoot});
                writeFileSync(join(privateOut,'runs.private.json'),JSON.stringify(privateRuns,null,2));save();}});
            row.attempts=attempt;
            const infrastructureFailure=isStartupInfrastructureFailure(result.report);
            state.attempts.push({inputId:sample.inputId,sampleId:sample.sampleId,repetition,cacheState,attempt,
              runId:result.report.runId,reason:result.report.reason??null,outcome:runReadiness(result.report).outcome,
              startupInfrastructureFailure:infrastructureFailure});
            if(!privateRuns.some(run=>run.runId===result.report.runId))
              privateRuns.push({inputId:sample.inputId,repetition,cacheState,attempt,runId:result.report.runId,out:result.out,dataRoot:result.dataRoot});
            if(!infrastructureFailure)break;
            row.startupFailures.push(result.report.reason);
            if(attempt===STARTUP_ATTEMPTS||controller.signal.aborted)break;
            row.error=`startup-infrastructure-retry:${result.report.reason}`;save();
            await waitRetry(startupRetryDelayMs(attempt));
          }
          if(!result){row.status='CANCELLED';row.error='batch-cancelled';save();continue;}
          recordReport(row,result.report,state);
          if(isStartupInfrastructureFailure(result.report)&&row.attempts===STARTUP_ATTEMPTS)
            row.error=`startup-infrastructure-retries-exhausted:${result.report.reason}`;
          const report=result.report;
          state.runs.push(Object.fromEntries(['version','runId','processInstanceId','conditions','buildFingerprint','projectType','correctness','defectAssessment','semanticDigest','semanticDigestScope','pendingDigest','pendingCount','pendingSourceCount','geometryStructuralFingerprint','contentEvidence','inputIntegrity','environmentSuspend','inputVariant','cacheFailureCode','cacheFailureCount','cacheVerified','cachePublished','coverageComplete','measurementLifecycleComplete','measurementComplete','measurementIncompleteItems','memoryEvidenceComplete','memoryIncompleteItems','requiredMetrics','metrics','processSampling','crashed','reason'].map(key=>[key,report[key]])));
          if(controller.signal.aborted){row.status='CANCELLED';row.error='batch-cancelled';}
          else if(cacheState==='cold')cold=result;
          else{const pair={sampleId:sample.sampleId,repetition,...coldWarmEquivalent(cold.report,result.report)};state.pairs.push(pair);
            if(pair.outcome==='FAIL'){row.status='FAIL';row.error=[row.error,...pair.reasons].filter(Boolean).join(';');}}
        }catch(error){row.status=controller.signal.aborted?'CANCELLED':error?.message==='warm-webview-profile-unavailable'?'INCONCLUSIVE':'ERROR';
          row.error=controller.signal.aborted?'batch-cancelled':safeError(error);
          writeFileSync(join(privateOut,`${row.inputId}-${repetition}-${cacheState}.private.log`),String(error?.stack??error));}
        writeFileSync(join(privateOut,'runs.private.json'),JSON.stringify(privateRuns,null,2));save();
      }
    }
  }finally{clearInterval(stopTimer);signal?.removeEventListener('abort',abort);}
  state.status=controller.signal.aborted?'CANCELLED':'COMPLETE';
  state.outcome=state.rows.some(row=>['FAIL','ERROR','INPUT_ERROR'].includes(row.status))?'FAIL':
    state.rows.every(row=>['PASS','DUPLICATE'].includes(row.status))?'PASS':
    state.rows.every(row=>['PASS','PARTIAL','DUPLICATE'].includes(row.status))?'PARTIAL':'INCONCLUSIVE';
  const groups=new Map();for(const run of state.runs){const key=digest([run.conditions.sampleId,run.conditions.scenario,run.conditions.cacheState,run.conditions.routeDigest]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);}
  state.baselineEligible=preset==='baseline'&&['PASS','PARTIAL'].includes(state.outcome)&&state.pairs.length===inputs.samples.length*repetitions
    &&state.pairs.every(pair=>['PASS','PARTIAL'].includes(pair.outcome))
    &&[...groups.values()].every(runs=>['PASS','PARTIAL'].includes(compareRuns(runs,runs).outcome));
  save();try{unlinkSync(controllerFile);}catch{/* Completed report is authoritative. */}
  return {out,result:state};
}

export async function runBatch(options){
  const {root,directory,registry}=options;
  const out=artifactDirectory(root,options.out??join(root,'output','gim-bench',`batch-${Date.now()}`));
  if(existsSync(join(out,'results.json')))throw Error('Output already contains a batch; choose a new output directory');
  const privateOut=artifactDirectory(root,join(root,'tmp','gim-bench','batches',`batch-${Date.now()}`));
  const inputs=await loadBatchInputs(root,{directory,registry});
  if(inputs.samples.length&&!options.execute){
    const build=JSON.parse(readFileSync(workspacePath(root,options.buildManifest),'utf8'));
    if(build.frontendProbeVerified!==true)throw Error('benchmark-build-probe-unverified: run bench build before batch');
    if(build.sourceFingerprint!==sourceFingerprint(root))throw Error('benchmark-source-changed: rebuild before batch');
  }
  writeFileSync(join(privateOut,'inputs.private.json'),JSON.stringify(inputs,null,2));
  writeFileSync(join(privateOut,'output.private.json'),JSON.stringify({out}));
  let environmentCalibration=null;
  if(inputs.samples.length&&!options.execute){
    try{environmentCalibration=calibrateBatch(root);}
    catch{environmentCalibration={version:'gim-batch-calibration-v1',availability:'unavailable',reason:'workspace-calibration-failed'};}
  }
  return executeBatch({...options,out,privateOut,inputs,environmentCalibration});
}

/** Finalize a controller that has already exited; never fabricate elapsed metrics. */
function controllerRecord(root,out){
  const base=join(root,'tmp','gim-bench','batches');if(!existsSync(base))return null;
  const matches=[];
  for(const entry of readdirSync(base,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const dir=join(base,entry.name),outputFile=join(dir,'output.private.json');
    if(!existsSync(outputFile))continue;
    try{const value=JSON.parse(readFileSync(workspacePath(root,outputFile),'utf8'));
      if(resolve(value.out)!==out)continue;
      const file=join(dir,'controller.private.json');
      if(!existsSync(file))continue;
      const safeFile=workspacePath(root,file);
      matches.push({file:safeFile,value:JSON.parse(readFileSync(safeFile,'utf8')),mappedNonce:value.nonce});
    }catch{/* Unreadable private record cannot establish ownership. */}
  }
  return matches.length===1?matches[0]:null;
}
function controllerAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return error?.code==='EPERM';}
}
function processStartedAt(pid){
  if(process.platform!=='win32'||!Number.isSafeInteger(pid)||pid<=0)return null;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
    {encoding:'utf8',windowsHide:true,timeout:5000});
  if(result.status!==0)return null;
  const value=Date.parse(result.stdout.trim());return Number.isFinite(value)?value:null;
}
function findUnreportedRunId(root,row){
  const runsRoot=join(root,'tmp','gim-bench','runs');if(!existsSync(runsRoot))return null;
  const matches=[];
  for(const entry of readdirSync(runsRoot,{withFileTypes:true})){
    if(!entry.isDirectory()||!/^run-[a-z0-9-]{8,80}$/.test(entry.name))continue;
    const folder=join(runsRoot,entry.name),manifest=join(folder,'run.private.json');
    if(!existsSync(manifest)||existsSync(join(folder,'report.json')))continue;
    try{const data=JSON.parse(readFileSync(workspacePath(root,manifest),'utf8'));
      if(data.sampleId===row.sampleId&&data.sourceSha256===row.sourceSha256)matches.push(entry.name);
    }catch{/* Incomplete private manifest is not a match. */}
    if(matches.length>1)return null;
  }
  return matches[0]??null;
}
export function recoverInterruptedBatch(root,outputDirectory,{force=false,getProcessStartAt=processStartedAt}={}){
  const out=workspacePath(root,outputDirectory),file=join(out,'results.json');
  const state=JSON.parse(readFileSync(file,'utf8'));
  if(state.status!=='RUNNING'&&!state.rows?.some(row=>['RUNNING','PENDING'].includes(row.status)))
    return {out,result:state,recovered:0};
  const owner=controllerRecord(root,out);
  const identityValid=owner&&Number.isSafeInteger(owner.value.pid)&&owner.value.pid>0&&
    /^[a-f0-9]{48}$/.test(owner.value.nonce??'')&&
    owner.value.nonce===owner.mappedNonce&&Number.isFinite(Date.parse(owner.value.processStartedAt));
  if(!identityValid&&!force)throw Error('batch-controller-ownership-unverified: use --force after confirming the controller stopped');
  if(owner&&controllerAlive(owner.value.pid)){
    const actual=getProcessStartAt(owner.value.pid),expected=Date.parse(owner.value.processStartedAt);
    if(actual!==null&&Number.isFinite(expected)&&Math.abs(actual-expected)<=2000)
      throw Error('batch-controller-still-running');
    if(actual===null&&!force)throw Error('batch-controller-identity-unverified: use --force after confirming the controller stopped');
  }
  let recovered=0;
  for(const row of state.rows??[]){
    if(!['RUNNING','PENDING'].includes(row.status))continue;
    const wasRunning=row.status==='RUNNING';
    row.status='CANCELLED';row.error=wasRunning?'controller-interrupted':'batch-not-executed';recovered++;
    row.settledMs=null;row.measurementComplete=false;
    if(wasRunning&&!row.runId)row.runId=findUnreportedRunId(root,row);
    if(!wasRunning||typeof row.runId!=='string'||!/^run-[a-z0-9-]{8,80}$/.test(row.runId))continue;
    const candidate=join(root,'tmp','gim-bench','runs',row.runId);
    if(!existsSync(candidate))continue;
    const runDir=workspacePath(root,candidate);
    const progressFile=join(runDir,'progress.private.json');
    let snapshot=null;
    try{if(existsSync(progressFile))snapshot=JSON.parse(readFileSync(progressFile,'utf8'));}catch{/* Snapshot is optional. */}
    row.interruptedAtMs=snapshot?.atMs??null;
    row.interruptedWritePending=snapshot?.progress?.cache?.writePending??null;
    row.interruptedCacheSettled=snapshot?.progress?.cacheSettled??false;
    if(existsSync(runDir)&&!existsSync(join(runDir,'report.json'))){
      writeFileSync(join(runDir,'report.json'),JSON.stringify({version:'gim-benchmark-v1',runId:row.runId,
        recovery:{kind:'controller-interruption-v1'},
        outcome:'INCONCLUSIVE',reason:'controller-interrupted',correctness:'unverified',
        measurementComplete:false,cacheVerified:false,cachePublished:false,
        metrics:{settledMs:null},progressSnapshot:snapshot},null,2));
    }
  }
  state.status='CANCELLED';state.outcome='INCONCLUSIVE';state.baselineEligible=false;
  state.recovery={kind:'controller-interruption-v1',recoveredRows:recovered};
  state.updatedAt=new Date().toISOString();writeBatchReports(out,state);
  if(owner)try{unlinkSync(owner.file);}catch{/* Recovered report remains conclusive. */}
  return {out,result:state,recovered};
}
