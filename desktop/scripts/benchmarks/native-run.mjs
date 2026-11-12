import {CaptureController,diagnosticPlan} from './diagnostics.mjs';
import {SystemCapture,systemCapabilities} from './system-diagnostics.mjs';
import {analyzeRun,exportRunTrace} from './observability.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {hostname,cpus,totalmem,release,arch} from 'node:os';
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,cpSync,readdirSync,openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileSha256,directoryFingerprint} from './acceptance-build.mjs';
import {CdpConnection,WorkerHeapSampler} from './cdp.mjs';
import {bareContainerKind} from './container-magic.mjs';
import {checkedWebviewProfile} from './cache-roots.mjs';
import {digest,runReadiness} from './compare.mjs';
import {workspacePath,sha256} from './samples.mjs';
import {startProcessSampler} from './process-sampler.mjs';
import {cachePublicationAssessment} from './profiles.mjs';
import {createSettleWindow,collectFinalEvidence,cachePublicationMoment,semanticStallReason} from './completion.mjs';
import {assessCorrectness} from './correctness.mjs';
import {assertBenchmarkExecutable} from './benchmark-build-attestation.mjs';
import {classifyWorkerHeapEvidence} from './worker-memory-completeness.mjs';
import {confirmedEnvironmentSuspend} from './environment.mjs';
import {calibrateBatch} from './batch-calibration.mjs';
import {MEASUREMENT_VERSION} from '../../../packages/measurement-core/src/version.mjs';
import {writeArtifactInventory} from './artifacts.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const reasonCode=error=>/^[a-z][a-z0-9-]{0,80}$/.test(error?.message??'')?error.message:/^CDP /.test(error?.message??'')?'cdp-request-failed':'native-run-failed';
function fileTail(path,maxBytes=8192){
  if(!existsSync(path))return null;
  try{const fd=openSync(path,'r');try{const size=fstatSync(fd).size,bytes=Buffer.alloc(Math.min(size,maxBytes));
    readSync(fd,bytes,0,bytes.length,size-bytes.length);return bytes.toString('utf8');}finally{closeSync(fd);}}
  catch{return null;}
}
async function port(){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
async function stop(child){if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);if(child.exitCode===null&&child.signalCode===null)throw Error('Owned application cleanup failed');}

/** Each call owns one native process and raw report; cold/warm share cache and WebView profile. */
export async function runNative({root,buildManifest,sample,profileDigest='unfrozen',mode='benchmark',scenario='open',cacheState='cold',dataRoot,timeoutMs=300000,doctor=false,actions=[],diagnostic,additionalSamples=[],exercise,signal,onStarted=()=>{},onReady=async()=>{},environmentCalibration=null}){
  const plan=diagnosticPlan(diagnostic?.kind?null:diagnostic??(mode==='diagnostic'?{captures:[]}:null),diagnostic?.kind?diagnostic:null);
  if(plan&&mode!=='diagnostic')throw Error('diagnostic-mode-required');
  if(process.platform!=='win32')throw Error('Native benchmark requires Windows');
  if(!environmentCalibration&&!doctor){
    try{environmentCalibration=calibrateBatch(root);}
    catch{environmentCalibration={version:'gim-batch-calibration-v1',availability:'unavailable',reason:'workspace-calibration-failed'};}
  }
  if(doctor)sample={sampleId:'capability-probe',sourceSha256:null,paths:[]};
  else if(!/^gim-[a-f0-9]{16}$/.test(sample.sampleId)||!/^[a-f0-9]{64}$/.test(sample.sourceSha256))throw Error('Invalid registered sample identity');
  const build=JSON.parse(readFileSync(workspacePath(root,buildManifest),'utf8'));
  if(build.profile!=='native-release-benchmark')throw Error('Explicit native benchmark build required');
  if(build.frontendProbeVerified!==true)throw Error('Benchmark executable has no verified frontend probe; rebuild with bench build');
  const folder=dirname(buildManifest),executable=join(folder,'GIM-Reader.exe'),runtime=join(folder,'webview2-fixed-runtime');
  assertBenchmarkExecutable(executable,build.benchmarkChunk);
  if(await fileSha256(executable)!==build.executableSha256||(await directoryFingerprint(runtime)).sha256!==build.runtime.sha256)throw Error('Benchmark build/runtime changed');
  const samplerExecutable=join(folder,'measurement_sampler.exe');
  if(!build.samplerSha256||await fileSha256(samplerExecutable)!==build.samplerSha256)throw Error('Native sampler build/hash missing');
  const inputRoot=join(root,'tmp','gim-bench','inputs');mkdirSync(inputRoot,{recursive:true});
  let source='';
  let inputVariant=null;
  if(!doctor){const original=workspacePath(root,join(root,sample.paths[0]));if(await sha256(original)!==sample.sourceSha256)throw Error('Source SHA changed');
    source=join(inputRoot,`${sample.sampleId}.gim`);if(!existsSync(source))cpSync(original,source);
    if(await sha256(source)!==sample.sourceSha256)throw Error('Input snapshot SHA changed');
    const descriptor=openSync(source,'r');try{const head=Buffer.alloc(6);readSync(descriptor,head,0,6,0);
      const kind=bareContainerKind(head);if(kind)inputVariant=`bare-${kind}`;
    }finally{closeSync(descriptor);}}
  const runId=`run-${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`,out=join(root,'tmp','gim-bench','runs',runId);
  mkdirSync(out,{recursive:true});
  if(mode==='benchmark'||mode==='diagnostic')writeFileSync(join(out,'events.jsonl'),'');
  dataRoot=dataRoot?workspacePath(root,dataRoot):join(out,'cache');mkdirSync(dataRoot,{recursive:true});
  if(cacheState==='cold'&&readdirSync(dataRoot).length)throw Error('Cold cache root must be new/empty');
  // The product's IFC LOD cache lives in WebView2 IndexedDB. A warm process
  // must reuse the cold process's profile as well as its SQLite data root.
  const profile=checkedWebviewProfile(root,dataRoot,cacheState);mkdirSync(profile,{recursive:true});
  writeFileSync(join(out,'profile.private.json'),JSON.stringify({profile,dataRoot,cacheState,policy:'paired-webview-profile-v1'}));
  const manifest={nonce:randomBytes(32).toString('hex'),sampleId:sample.sampleId,sourcePath:source,sourceSha256:sample.sourceSha256??'',dataRoot,probeOnly:doctor};
  manifest.samples=[];
  for(const extra of additionalSamples){
    if(extra.sampleId===sample.sampleId)continue;
    if(!/^gim-[a-f0-9]{16}$/.test(extra.sampleId))throw Error('Invalid additional sample identity');
    const file=workspacePath(root,join(root,extra.paths[0])),snapshot=join(inputRoot,`${extra.sampleId}.gim`);
    if(await sha256(file)!==extra.sourceSha256)throw Error('Additional source SHA changed');if(!existsSync(snapshot))cpSync(file,snapshot);
    if(await sha256(snapshot)!==extra.sourceSha256)throw Error('Additional input snapshot SHA changed');
    manifest.samples.push({sampleId:extra.sampleId,sourcePath:snapshot,sourceSha256:extra.sourceSha256});
  }
  const manifestPath=join(out,'run.private.json');writeFileSync(manifestPath,JSON.stringify(manifest));
  onStarted({runId,out,dataRoot});
  const debugPort=await port(),env={...process.env,TEMP:out,TMP:out,TMPDIR:out,LOCALAPPDATA:out,APPDATA:out,
    GIM_BENCHMARK_MANIFEST:manifestPath,WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_BROWSER_EXECUTABLE_FOLDER:runtime,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1 --enable-logging --log-file="${join(out,'webview.private.log')}" --v=1`};
  let systemCapture;
  if(plan?.system){systemCapture=new SystemCapture(plan.system);await systemCapture.start();}
  const applicationStartedAtMs=performance.now();
  const child=spawn(executable,[],{cwd:folder,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let spawnFailed=false;child.on('error',()=>{spawnFailed=true;});
  // Raw output is private. Cap bytes; logs are never copied into report.json.
  let logFailures=0;
  for(const name of ['stdout','stderr']){let bytes=0;child[name].on('data',data=>{try{if(bytes<4*1024*1024)appendFileSync(join(out,`${name}.private.log`),data);}catch{logFailures++;}bytes+=data.length;});}
  const gpuEvidence={requested:plan?.gpu===true,samples:0,available:0,unavailable:0,unsupported:0};
  let traceOutputBytes=0,traceOutputTruncated=false;
  let captures,captureResults=null,systemResult=null,diagnosticCapabilities=null;
  let cdp,sampler,observation=null,cleanupComplete=false,reason=null,finalEvidenceFailure=null,lateBackgroundTasks=false,crashed=false,heapRows=0,processPeak=null,settledMs=null;
  let openAttempted=false,endpointError=null,exitBeforeCleanup=null;
  const heaps=new Map(),heapRecords=new Map(),processSamples=[];let events=0,hostSamplingFailures=0,streamFailures=0,evidence=null,automaticMs=null,cachePublishMs=null,productPeak=null;
  let templateDiagnostics=[],templateDiagnosticsStatus='not-applicable';
  const processSampler=startProcessSampler(samplerExecutable,child,executable,env,row=>{processSamples.push(row);if(row.availability==='available'&&Number.isFinite(row.bytes))processPeak=Math.max(processPeak??0,row.bytes);});
  const acknowledgements=new Map();let ackRunning=false,ackTimer,hostGapStart=null;const hostSamplingGaps=[];
  const flushAcks=async()=>{
    if(ackRunning||!acknowledgements.size||!cdp||cdp.closed)return;
    ackRunning=true;const batch=[...acknowledgements].slice(0,64);
    try{await cdp.evaluate(`for(const [run,id] of ${JSON.stringify(batch.map(([,value])=>value))})globalThis.__gimBenchmark.ack(run,id);undefined`);
      for(const [key]of batch)acknowledgements.delete(key);
    }catch{/* A delayed page response is retried; ack is idempotent. */}finally{ackRunning=false;}
  };
  let applicationReadyMs=null,settledObservedAtMs=null;
  const actionResults=[];const actionTargets=[];
  let exerciseResult=null;
  let finalEvidenceStability=null;
  const gpuSamples=[];let gpuSamplesOmitted=0;
  const started=performance.now();let lastSnapshotAt=started,observationGapMs=0;
  try{
    while(performance.now()-started<30000){
      if(signal?.aborted)throw Error('run-cancelled');
      if(spawnFailed||child.exitCode!==null)throw Error('native-startup-failed');
      try{
        const targets=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`,{signal:AbortSignal.timeout(1000)})).json();
        const pages=targets.filter(t=>t.type==='page'&&(/^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)/.test(t.url)));
        writeFileSync(join(out,'endpoint.private.json'),JSON.stringify({targets},null,2));
        if(pages.length===1){cdp=await CdpConnection.connect(pages[0].webSocketDebuggerUrl,debugPort);break;}
      }catch(error){endpointError={message:String(error?.message??error),cause:String(error?.cause??''),stack:String(error?.stack??'')};
        writeFileSync(join(out,'endpoint.private.json'),JSON.stringify({error:endpointError}));}
      if(performance.now()-started>=16000){
        const log=join(out,'webview.private.log');
        if(fileTail(log)?.includes('Terminating current process after 15 seconds with no connection.'))
          throw Error('native-cdp-unavailable');
      }
      await delay(250);
    }
    if(!cdp){
      const log=join(out,'webview.private.log');
      const gpuFailure=fileTail(log)?.includes("GPU process isn't usable");
      throw Error(gpuFailure?'webview-gpu-process-launch-failed':'native-cdp-unavailable');
    }
    while(await cdp.evaluate('typeof globalThis.__gimBenchmark')!=='object'){if(performance.now()-started>45000)throw Error('benchmark-api-unavailable');await delay(250);}
    applicationReadyMs=performance.now()-applicationStartedAtMs;
    const database=await cdp.evaluate("globalThis.__TAURI_INTERNALS__.invoke('get_db_path')");
    if(resolve(database).toLowerCase()!==join(dataRoot,'gim_cache_schema_v1.db').toLowerCase())throw Error('native-cache-root-mismatch');
    await onReady(cdp,{runId,out,build});
    sampler=new WorkerHeapSampler(cdp,row=>{
      appendFileSync(join(out,'heap.jsonl'),JSON.stringify(row)+'\n');heapRows++;
      if(row.kind==='heap-sample'&&row.workerId){const previous=heapRecords.get(row.workerId);
        heapRecords.set(row.workerId,{workerId:row.workerId,family:row.family??previous?.family??null,
          availability:row.availability,reason:row.availability==='available'?null:row.reason??'unknown',
          lastFailureReason:row.availability==='available'?previous?.lastFailureReason??null:row.reason??'unknown',
          samples:(previous?.samples??0)+1,successfulSamples:(previous?.successfulSamples??0)+(row.availability==='available'?1:0),
          failedSamples:(previous?.failedSamples??0)+(row.availability==='available'?0:1),
          maxSampleGapMs:Math.max(previous?.maxSampleGapMs??0,
            Number.isFinite(previous?.lastSampleAtMs)&&Number.isFinite(row.atMs)
              ?Math.max(0,row.atMs-previous.lastSampleAtMs):0),
          maxSampleDelayMs:Math.max(previous?.maxSampleDelayMs??0,row.sampleDelayMs??0),lastSampleAtMs:row.atMs});}
      if(['worker-target-ended','heap-sampling-stopped'].includes(row.kind)&&row.workerId){
        const previous=heapRecords.get(row.workerId);
        if(previous&&Number.isFinite(previous.lastSampleAtMs)&&Number.isFinite(row.atMs))
          heapRecords.set(row.workerId,{...previous,maxSampleGapMs:Math.max(previous.maxSampleGapMs??0,
            Math.max(0,row.atMs-previous.lastSampleAtMs))});
      }
      if(row.availability==='available'){const old=heaps.get(row.workerId);heaps.set(row.workerId,{workerId:row.workerId,family:row.family,isolateId:row.isolateId,samples:(old?.samples??0)+1,observedPeakBytes:Math.max(old?.observedPeakBytes??0,row.bytes),maxSampleDelayMs:Math.max(old?.maxSampleDelayMs??0,row.sampleDelayMs)});}
    });
    if(plan){captures=new CaptureController(cdp,out,plan);sampler.onDiagnosticTarget=(identity,sessionId)=>captures.target(identity,sessionId);}
    if(mode==='benchmark'||mode==='diagnostic')await sampler.start();
    cdp.onEvent(message=>{
      if(message.method!=='Runtime.bindingCalled'||message.params.name!=='__gimMeasurementEmit')return;
      try{
        const frame=JSON.parse(message.params.payload);
        if(typeof frame.runId!=='string'||!Number.isSafeInteger(frame.batchId)||!Array.isArray(frame.events)||frame.events.length>128)throw Error('invalid-frame');
        for(const event of frame.events)if(event.kind==='worker'&&event.name==='created'&&event.workerUrl)sampler.associate(event.workerUrl,frame.contexts[event.contextIndex]);
        for(const record of frame.events)if(record.trace?.name==='gpu.elapsed'){
          gpuEvidence.samples++;if(record.trace.action in gpuEvidence&&typeof gpuEvidence[record.trace.action]==='number')gpuEvidence[record.trace.action]++;
          if(gpuSamples.length<8192)gpuSamples.push({...record,context:frame.contexts[record.contextIndex]});else gpuSamplesOmitted++;
        }
        for(const record of frame.events)captures?.event({...record,context:frame.contexts[record.contextIndex],controllerReceivedMs:performance.now()});
        const raw=JSON.stringify(frame)+'\n',size=Buffer.byteLength(raw);
        if(!plan||traceOutputBytes+size<=plan.maxTraceBytes){appendFileSync(join(out,'events.jsonl'),raw);traceOutputBytes+=size;}else traceOutputTruncated=true;
        events+=frame.events.length;
        if(acknowledgements.size>=128)throw Error('ack-window-overflow');
        acknowledgements.set(`${frame.runId}:${frame.batchId}`,[frame.runId,frame.batchId]);
      }catch{streamFailures++;}
    });
    await cdp.send('Runtime.addBinding',{name:'__gimMeasurementEmit'});await cdp.evaluate('globalThis.__gimBenchmark.stream()');
    ackTimer=setInterval(()=>{flushAcks().catch(()=>{streamFailures++;});},50);
    if(doctor){
      const supported={};for(const domain of ['Profiler','HeapProfiler']){try{await cdp.send(domain+'.enable');await cdp.send(domain+'.disable');supported[domain]='available';}catch{supported[domain]='unavailable';}}
      const gpu=await cdp.evaluate("(()=>{const canvas=document.createElement('canvas');const gl=canvas.getContext('webgl2');if(!gl)return {availability:'unsupported',reason:'webgl2-missing'};const available=!!gl.getExtension('EXT_disjoint_timer_query_webgl2');gl.getExtension('WEBGL_lose_context')?.loseContext();return {availability:available?'available':'unsupported',actualCaptureVerified:false};})()");
      diagnosticCapabilities={cdp:supported,gpu};
      await cdp.evaluate('globalThis.__gimBenchmark.capabilityProbe()');await delay(3500);
      observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');await cdp.evaluate('globalThis.__gimBenchmark.endCapabilityProbe()');
    }else{
      // Start without blocking the sampling loop on the open Promise.
      const args=[sample.sampleId,manifest.nonce,{runId,sourceSha256:sample.sourceSha256,buildId:build.sourceFingerprint,mode}];
      await processSampler.checkpoint('open-start');
      if(plan?.gpu)await cdp.evaluate('globalThis.__GIM_GPU_DIAGNOSTICS__=true');
      await captures?.start();
      if(signal?.aborted)throw Error('run-cancelled');
      openAttempted=true;
      await cdp.evaluate(`globalThis.__gimBenchmark.open(...${JSON.stringify(args)}).catch(()=>{}); undefined`);
      const settleWindow=createSettleWindow({cacheState});
      let completed=false,lastCheckpointAt=0,lastProgressAt=performance.now(),progressKey='';
      while(performance.now()-started<timeoutMs){
        if(signal?.aborted)throw Error('run-cancelled');
        if(child.exitCode!==null){crashed=true;throw Error('native-process-exited');}
        const requestedAt=performance.now();
        try{observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');lastSnapshotAt=performance.now();if(hostGapStart!==null){if(hostSamplingGaps.length<128)hostSamplingGaps.push({startMs:hostGapStart,endMs:performance.now(),clockId:'controller'});hostGapStart=null;}}
        catch{observationGapMs=Math.max(observationGapMs,performance.now()-lastSnapshotAt);if(cdp.closed){crashed=true;throw Error('renderer-process-exited');}hostSamplingFailures++;hostGapStart??=requestedAt;await delay(1000);continue;}
        const now=performance.now();
        const nextProgress=JSON.stringify([observation.progress.semanticStatus,observation.progress.engineeringProgress,
          observation.progress.workload,
          observation.measurement?.taskOutcomes,observation.measurement?.counters?.['engineering:host.received']?.messages]);
        if(nextProgress!==progressKey){progressKey=nextProgress;lastProgressAt=now;}
        if(now-lastCheckpointAt>=30000){
          try{writeFileSync(join(out,'progress.private.json'),JSON.stringify({atMs:now-started,progress:observation.progress,
            activeTaskFamilies:observation.measurement?.activeTasks?.map(task=>task.family),
            lifecycleIssues:observation.measurement?.lifecycleIssues??[],lastProgressAgoMs:now-lastProgressAt},null,2));}
          catch{logFailures++;}
          lastCheckpointAt=now;
        }
        if(observation.progress.automaticSettled&&automaticMs===null){
          const moments=observation.moments;
          automaticMs=Math.max(...['coreSemanticReady','navigationUiReady','allIfcReady','devBaseRepresentationsSettled','devGeometryReady'].map(key=>moments[key]??0))||observation.openElapsedMs;
        }
        if(observation.openError)throw Error(observation.openErrorCode==='INPUT_CORRUPT'?'input-corrupt':'project-open-failed');
        if(observation.projectType==='substation'&&observation.progress.backgroundSettled&&!observation.progress.semantic){
          reason='settled-without-semantic';break;
        }
        if(observation.progress.semanticFailure){reason=observation.progress.engineeringFailureCode==='engineering-progress-stalled'
          ?'product-stalled':'engineering-semantic-failed';break;}
        const stalled=semanticStallReason(observation,now-lastProgressAt);
        if(stalled){reason=stalled;break;}
        if(automaticMs!==null&&settleWindow.observe(observation)){
          cachePublishMs??=cachePublicationMoment(observation);
          completed=true;settledObservedAtMs=observation.snapshotAtMs;settledMs=observation.openElapsedMs;break;
        }
        if(!observation.opening&&!observation.projectType)throw Error('project-open-unavailable');
        await delay(1000);
      }
      if(!reason){
        if(automaticMs===null)reason='automatic-completion-not-observed';
        else if(!observation.progress.cacheSettled)reason='cache-publication-not-observed';
        else if(cacheState==='cold'&&observation.projectType==='substation'&&!observation.cachePersistence?.observed)
          reason='substation-cache-publication-not-observed';
        else if(!observation.progress.backgroundSettled)reason='background-completion-not-observed';
        else if(!completed)reason='automatic-settle-timeout';
      }
      if(!reason&&actions.length){
        const targets=await cdp.evaluate('globalThis.__gimBenchmark.targets()');writeFileSync(join(out,'targets.private.json'),JSON.stringify(targets,null,2));
        for(const spec of actions){
          if(signal?.aborted)throw Error('run-cancelled');
          const target=spec.kind==='dev-fine'?(spec.selector==='canonical-first-boolean-base-v1'?targets.devBoolean?.[0]:targets.dev[0]):targets.ifc[0];
          if(!target){reason='scenario-target-unavailable';break;}
          const action={...target,kind:spec.kind};actionTargets.push(digest(action));const start=performance.now();
          try{const result=await cdp.evaluate(`globalThis.__gimBenchmark.action(${JSON.stringify(action)})`,undefined,130000);actionResults.push({...result,status:'completed',durationMs:performance.now()-start});}
          catch{actionResults.push({kind:spec.kind,status:'failed',durationMs:performance.now()-start});reason='scenario-action-failed';break;}
        }
        const actionWindow=createSettleWindow({cacheState});
        for(let i=0;i<120&&!reason;i++){
          observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
          if(actionWindow.observe(observation)){settledObservedAtMs=observation.snapshotAtMs;settledMs=observation.openElapsedMs;break;}
          await delay(1000);if(i===119)reason='scenario-settle-timeout';
        }
      }
      await processSampler.checkpoint('product-settled');productPeak=processPeak;
      if(!reason&&exercise)evidence=await cdp.evaluate('globalThis.__gimBenchmark.evidence()',undefined,30000);
    }
    if(exercise&&!reason)exerciseResult=await exercise({cdp,processSampler,sampler,manifest,runId,build,out,evidence});
    for(let attempt=0;attempt<50;attempt++){
      await flushAcks();
      const transport=await cdp.evaluate('globalThis.__gimBenchmark.transport()');
      if(transport.every(row=>row.pending===0&&row.buffered===0))break;
      await delay(100);if(attempt===49)streamFailures++;
    }
    if(acknowledgements.size)streamFailures++;
    observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
    lateBackgroundTasks=observation.measurement.activeTasks.length>0;
    for(let attempt=0;attempt<30&&observation.measurement.activeTasks.length&&!reason;attempt++){
      await delay(1000);observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
    }
    // A task that finished during the tail may have emitted new detail batches.
    // Drain those too before checking completeness and closing the binding.
    for(let attempt=0;attempt<50;attempt++){
      await flushAcks();
      const transport=await cdp.evaluate('globalThis.__gimBenchmark.transport()');
      if(transport.every(row=>row.pending===0&&row.buffered===0))break;
      await delay(100);if(attempt===49)streamFailures++;
    }
    if(acknowledgements.size)streamFailures++;
    observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
    lateBackgroundTasks ||= observation.measurement.activeTasks.length>0;
    for(let window=0;window<2&&observation.measurement.activeTasks.length&&!reason;window++){
      for(let attempt=0;attempt<120&&observation.measurement.activeTasks.length;attempt++){
        await delay(1000);observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
      }
      if(observation.measurement.activeTasks.length)break;
      for(let attempt=0;attempt<50;attempt++){
        await flushAcks();const transport=await cdp.evaluate('globalThis.__gimBenchmark.transport()');
        if(transport.every(row=>row.pending===0&&row.buffered===0))break;
        await delay(100);if(attempt===49)streamFailures++;
      }
      await delay(3000);
      observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
      settledObservedAtMs=observation.snapshotAtMs;settledMs=observation.openElapsedMs;
    }
    if(observation.measurement.activeTasks.length&&!reason)reason='post-settle-task-incomplete';
    if(!reason&&!doctor&&!exercise){
      const final=await collectFinalEvidence({initialSnapshot:observation,cacheState,
        readEvidence:()=>cdp.evaluate('globalThis.__gimBenchmark.evidence()',undefined,30000),
        readSnapshot:()=>cdp.evaluate('globalThis.__gimBenchmark.snapshot()')});
      evidence=final.evidence;observation=final.observation;finalEvidenceFailure=final.issue;
      finalEvidenceStability={attempts:final.attempts,driftCount:final.drifts.length,recovered:!final.issue&&final.drifts.length>0};
      writeFileSync(join(out,'final-evidence.private.json'),JSON.stringify({runId,...finalEvidenceStability,issue:final.issue,drifts:final.drifts},null,2));
      if(finalEvidenceStability.recovered){settledObservedAtMs=observation.snapshotAtMs;settledMs=observation.openElapsedMs;
        await processSampler.checkpoint('final-evidence-settled');productPeak=processPeak;}
      lateBackgroundTasks ||= finalEvidenceFailure==='active-tasks';
      if(finalEvidenceFailure)reason=finalEvidenceFailure==='active-tasks'?'post-settle-task-incomplete':
        finalEvidenceFailure==='progress-drift'?'final-evidence-drift':
          finalEvidenceFailure==='session-mismatch'?'final-evidence-session-mismatch':'final-evidence-unverified';
    }
  }catch(error){reason=reasonCode(error);try{writeFileSync(join(out,'failure.private.log'),String(error?.stack??error));}catch{logFailures++;}}
  finally{
    if(!doctor&&!exercise){
      try{
        if(!cdp||cdp.closed)throw Error('cdp-unavailable');
        const raw=await cdp.evaluate('globalThis.__gimBenchmark.templateDiagnostics()',undefined,5000);
        const sources=await cdp.evaluate('globalThis.__gimBenchmark.privateSources()',undefined,5000);
        if(!Array.isArray(raw)||!sources||typeof sources!=='object')throw Error('template-diagnostics-invalid');
        writeFileSync(join(out,'template-diagnostics.private.json'),JSON.stringify(raw,null,2));
        templateDiagnostics=raw.map(({key,devPath,...row})=>({...row,sourceId:sources[devPath]??null}));
        templateDiagnosticsStatus='available';
      }catch{templateDiagnosticsStatus='unavailable';}
    }
    if(mode==='diagnostic'&&cdp&&!cdp.closed){await cdp.evaluate('globalThis.__gimBenchmark.finishOperation('+JSON.stringify(settledObservedAtMs)+')').catch(()=>{});
      await delay(150);await flushAcks();await delay(100);}
    if(captures)captureResults=await captures.stop();
    if(systemCapture)systemResult=await systemCapture.stop();
    clearInterval(ackTimer);sampler?.stop();cdp?.close();const sampling=await processSampler.stop();if(sampling.failures)streamFailures+=sampling.failures;
    exitBeforeCleanup={code:child.exitCode,signal:child.signalCode};
    try{await stop(child);cleanupComplete=true;}catch{reason='owned-process-cleanup-failed';}}
  const suspended=reason==='renderer-process-exited'&&confirmedEnvironmentSuspend(
    reason,fileTail(join(out,'webview.private.log'),3*1024*1024),observationGapMs);
  if(suspended){reason='infra-suspend';crashed=false;}
  if(!openAttempted&&reason){
    const log=join(out,'webview.private.log');
    writeFileSync(join(out,'startup.private.json'),JSON.stringify({debugPort,applicationPid:child.pid??null,exitBeforeCleanup,
      spawnFailed,reason,endpointError,elapsedMs:performance.now()-started,processSamples:processSamples.slice(-10),
      webviewLogTail:fileTail(log)},null,2));
  }
  writeFileSync(join(out,'process-memory.json'),JSON.stringify(processSamples,null,2));
  const workerMemory=[...heaps.values()].map(row=>({...row,
    failedSamples:heapRecords.get(row.workerId)?.failedSamples??0,
    maxSampleGapMs:heapRecords.get(row.workerId)?.maxSampleGapMs??0,
    maxSampleDelayMs:heapRecords.get(row.workerId)?.maxSampleDelayMs??row.maxSampleDelayMs})),measurement=observation?.measurement??null;
  const processMemoryComplete=processSamples.length>=2&&processSamples.every(row=>row.availability==='available');
  const {missing:missingWorkers,unavailable:unavailableWorkers,shortLived:shortLivedWorkerMemory,
    notApplicable:notApplicableWorkerMemory}=classifyWorkerHeapEvidence(
    measurement?.workers,new Set(heaps.keys()),heapRecords,sampler?.periodMs??1000);
  const memoryIncompleteItems=[];
  if(!processMemoryComplete){
    if(processSamples.length<2)memoryIncompleteItems.push('process-tree:insufficient-samples');
    const reasons=new Map();for(const row of processSamples)if(row.availability!=='available'){
      const key=row.reason??'unavailable';reasons.set(key,(reasons.get(key)??0)+1);
    }
    for(const [key,count]of reasons)memoryIncompleteItems.push(`process-tree:${key}:${count}`);
  }
  for(const workerId of missingWorkers)memoryIncompleteItems.push(`worker-heap:missing:${workerId}`);
  for(const row of unavailableWorkers)memoryIncompleteItems.push(`worker-heap:${row.reason??'unavailable'}:${row.workerId}`);
  const memoryEvidenceComplete=processMemoryComplete&&!missingWorkers.length&&!unavailableWorkers.length;
  const measurementIncompleteItems=[
    ...(reason?[`run:${reason}`]:[]),...(streamFailures?[`stream-failures:${streamFailures}`]:[]),
    ...(!cleanupComplete?['owned-process-cleanup']:[]),
    ...(measurement?.aggregateComplete===true?[]:['measurement-aggregate']),
    ...(measurement?.lifecycleComplete===true||measurement?.lifecycleIssues?.length?[]:['lifecycle:unverified']),
    ...(measurement?.lifecycleIssues??[]).map(item=>`lifecycle:${item}`),
    ...Object.entries(measurement?.loss??{}).filter(([key,value])=>
      !['detailEvents','intentionalInterruptedTasks','cancelledBeforeStart','lateCancelledAcks'].includes(key)&&value>0)
      .map(([key,value])=>`collector:${key}:${value}`),
    ...((measurement?.activeTasks?.length??0)>0?[`active-tasks:${measurement.activeTasks.length}`]:[]),
  ];
  const conditions={machineId:digest({hostname:hostname(),cpu:cpus()[0]?.model,cores:cpus().length,memory:totalmem(),os:release(),arch:arch()}),runtimeSha256:build.runtime.sha256,buildMode:'release',measurementVersion:MEASUREMENT_VERSION,detailPolicy:'task-phase-timeline-v2',lifecyclePolicy:'worker-terminal-v2',contentPolicy:'dev-l0-glb-sha256-v1',cacheProofPolicy:'source-failure-catalog-v1',webviewProfilePolicy:'paired-webview-profile-v1',mode,scenario,cacheState,environmentCalibration,
    sampleId:sample.sampleId,sourceSha256:sample.sourceSha256,profileDigest,routeDigest:digest(actionTargets),viewportDigest:digest(observation?.viewport??null),viewport:observation?.viewport??null,
    workloadDigest:evidence?digest({workload:evidence.progress.workload,semantic:evidence.semanticDigest,placement:evidence.placementDigest}):null};
  const assessment=assessCorrectness(evidence);
  const cacheAssessment=cachePublicationAssessment(evidence,cacheState,observation?.projectType);
  const cacheFailureCode=inputVariant&&evidence&&observation?.projectType&&!cacheAssessment.published?'CACHE_NOT_PERSISTABLE':null;
  const variantPartialEligible=cacheFailureCode&&assessment.correctness==='passed'&&measurement?.aggregateComplete===true&&
    evidence?.progress?.cachePersistenceStatus!=='failed'&&evidence?.progress?.cache?.writeFailures===0&&evidence?.progress?.cache?.readFailures===0;
  const correctness=actionResults.some(row=>row.status==='failed')||crashed||
    ['project-open-failed','project-open-unavailable','engineering-semantic-failed','settled-without-semantic','product-stalled'].includes(reason)
    ?'failed':variantPartialEligible?'partial':assessment.correctness;
  const defectAssessment=variantPartialEligible?{kind:'input-variant',status:'cache-not-persistable',sourceSha256:sample.sourceSha256,variant:inputVariant}:assessment.defectAssessment;
  const report={version:'gim-benchmark-v1',runId,kind:doctor?'native-capability-probe':'native-scene',projectType:observation?.projectType??null,conditions,buildFingerprint:build.sourceFingerprint,processInstanceId:runId,
    evidenceAtMs:evidence?.evidenceAtMs??null,finalSnapshotAtMs:observation?.snapshotAtMs??null,
    finalEvidenceIssue:finalEvidenceFailure,finalEvidenceStability,lateBackgroundTasks,
    semanticDigest:evidence?.semanticDigest??null,
    semanticDigestScope:evidence?.semanticDigestScope??null,pendingDigest:evidence?.pendingDigest??null,
    pendingCount:evidence?.pendingCount??null,pendingSourceCount:evidence?.pendingSourceCount??null,
    geometryStructuralFingerprint:evidence?.geometryStructuralFingerprint??null,
    contentEvidence:evidence?.contentEvidence??null,
    correctness,defectAssessment,inputVariant,inputVariantCode:inputVariant?'INPUT_VARIANT':null,
    inputIntegrity:reason==='input-corrupt'?'corrupt':null,cacheFailureCode,cacheAssessment,
    measurementDetailDropped:measurement?.loss?.detailEvents??null,
    measurementDetailStatus:measurement?.detailComplete?'complete':measurement?.aggregateComplete?'aggregate-only':'incomplete',
    measurementAggregatedDetail:measurement?.aggregatedDetail??null,
    cacheFailureCount:(evidence?.progress?.cache?.writeFailures??0)+(evidence?.progress?.cache?.readFailures??0)+
      (evidence?.progress?.cachePersistenceStatus==='failed'?1:0),
    cacheVerified:cacheAssessment.published,cachePublished:cacheAssessment.published,coverageComplete:cacheAssessment.coverageComplete??null,
    measurementLifecycleComplete:measurement?.lifecycleComplete===true,
    measurementLifecycleIssues:measurement?.lifecycleIssues??[],
    measurementComplete:!reason&&streamFailures===0&&cleanupComplete&&measurement?.aggregateComplete===true&&
      measurement?.lifecycleComplete===true&&!measurement.activeTasks.length,
    measurementIncompleteItems,memoryEvidenceComplete,memoryIncompleteItems,
    requiredMetrics:['firstResponseMs','automaticLoadMs','processPrivatePeakBytes'],metrics:{
      firstResponseMs:observation?.moments.navigationUiReady??observation?.moments.coreSemanticReady??null,
      modelTreeReadyMs:observation?.projectType==='substation'?observation?.moments.engineeringTreeReady??null:
        observation?.moments.navigationUiReady??null,
      firstGeometryMs:observation?.moments.firstGeometryReady??observation?.moments.firstUsableGeometryReady??null,
      allGeometryReadyMs:Math.max(observation?.moments.allIfcReady??0,observation?.moments.devBaseRepresentationsSettled??0)||null,
      automaticLoadMs:automaticMs,cachePublishMs,
      settledMs,writeDrainMs:automaticMs!==null&&observation?.devArtifactWriteElapsedMs!=null
        ?Math.max(0,observation.devArtifactWriteElapsedMs-automaticMs):null,
      processPrivatePeakBytes:processMemoryComplete?productPeak??processPeak:null,
      wholeRunPrivatePeakBytes:processMemoryComplete?processPeak:null},
    completionDefinition:'automatic-representations-then-cache-and-spatial-terminal-with-quiet-window-not-all-L2',evidence,eventFormat:'context-table-v1',streamFailures,
    actionResults,actionTargetDigests:actionTargets,diagnostic:captureResults?.[0]??null,
    traceOutput:{bytes:traceOutputBytes,truncated:traceOutputTruncated,limit:plan?.maxTraceBytes??null},
    diagnostics:{configuration:plan,captures:captureResults,system:systemResult,gpu:{...gpuEvidence,method:'elapsed-query-command-range',availability:!gpuEvidence.requested?'not-requested':gpuEvidence.available?'available':gpuEvidence.unsupported||observation?.projectType==='transmission_line'?'unsupported':'unavailable'}},
    applicationStartup:{method:'controller-spawn-to-first-owned-benchmark-api-observation',elapsedMs:applicationReadyMs,startedAtMs:applicationStartedAtMs},
    diagnosticCapabilities,systemCapabilities:doctor?systemCapabilities():null,logFailures,
    exercise:exerciseResult,
    processSampling:{complete:processMemoryComplete,samples:processSamples.length,
      available:processSamples.filter(row=>row.availability==='available').length,
      rootOnlyObservedPeakBytes:Math.max(0,...processSamples.map(row=>Number.isFinite(row.rootPrivateBytes)?row.rootPrivateBytes:0))||null},
    crashed,reason,stalledStage:reason==='product-stalled'?observation?.progress?.engineeringProgress?.stage??'unknown':null,
    environmentSuspend:suspended?{code:'INFRA_SUSPEND',observationGapMs}:null,
    openAttempted,cleanupComplete,measurement,workerMemory,missingWorkerMemory:missingWorkers,
    unavailableWorkerMemory:unavailableWorkers,
    shortLivedWorkerMemory,notApplicableWorkerMemory,sampling:sampler?.snapshot()??null,heapRows,events,hostSamplingFailures,hostSamplingGaps,
    templateDiagnostics,templateDiagnosticsStatus,
    capabilityResult:observation?.capabilityResult??null,
    capabilityOutcome:doctor&&processMemoryComplete&&workerMemory.some(w=>w.family==='measurement-probe')&&
      measurement?.detailComplete&&measurement?.lifecycleComplete&&!measurement.activeTasks.length
      &&observation?.capabilityResult?.moduleExecutions===1&&observation?.capabilityResult?.roundTripValue===18?'PASS':'INCONCLUSIVE'};
  Object.assign(report,runReadiness(report));
  writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));
  if(plan?.gpu)writeFileSync(join(out,'gpu.private.json'),JSON.stringify({method:'elapsed-query-command-range',unit:'ms',
    samples:gpuSamples,omitted:gpuSamplesOmitted,availability:report.diagnostics.gpu.availability},null,2));
  try{if(plan){await analyzeRun(root,join(out,'report.json'));await exportRunTrace(root,join(out,'report.json'));}}
  finally{writeArtifactInventory(out,report);}
  return {out,report,dataRoot};
}
