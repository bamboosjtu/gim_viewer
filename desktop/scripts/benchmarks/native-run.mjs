import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {hostname,cpus,totalmem,release,arch} from 'node:os';
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,cpSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileSha256,directoryFingerprint} from './acceptance-build.mjs';
import {CdpConnection,WorkerHeapSampler} from './cdp.mjs';
import {digest,runReadiness} from './compare.mjs';
import {workspacePath,sha256} from './samples.mjs';
import {startProcessSampler} from './process-sampler.mjs';
import {cacheVerified} from './profiles.mjs';
import {readyForSettle,cachePublicationMoment} from './completion.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const reasonCode=error=>/^[a-z][a-z0-9-]{0,80}$/.test(error?.message??'')?error.message:/^CDP /.test(error?.message??'')?'cdp-request-failed':'native-run-failed';
async function port(){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
async function stop(child){if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);if(child.exitCode===null&&child.signalCode===null)throw Error('Owned application cleanup failed');}

/** Each call owns one native process, profile, manifest, cache root and raw report. */
export async function runNative({root,buildManifest,sample,profileDigest='unfrozen',mode='benchmark',scenario='open',cacheState='cold',dataRoot,timeoutMs=300000,doctor=false,actions=[],diagnostic,additionalSamples=[],exercise,signal}){
  if(process.platform!=='win32')throw Error('Native benchmark requires Windows');
  if(doctor)sample={sampleId:'capability-probe',sourceSha256:null,paths:[]};
  else if(!/^gim-[a-f0-9]{16}$/.test(sample.sampleId)||!/^[a-f0-9]{64}$/.test(sample.sourceSha256))throw Error('Invalid registered sample identity');
  const build=JSON.parse(readFileSync(workspacePath(root,buildManifest),'utf8'));
  if(build.profile!=='native-release-benchmark')throw Error('Explicit native benchmark build required');
  const folder=dirname(buildManifest),executable=join(folder,'GIM-Reader.exe'),runtime=join(folder,'webview2-fixed-runtime');
  if(await fileSha256(executable)!==build.executableSha256||(await directoryFingerprint(runtime)).sha256!==build.runtime.sha256)throw Error('Benchmark build/runtime changed');
  const samplerExecutable=join(folder,'measurement_sampler.exe');
  if(!build.samplerSha256||await fileSha256(samplerExecutable)!==build.samplerSha256)throw Error('Native sampler build/hash missing');
  const inputRoot=join(root,'tmp','gim-bench','inputs');mkdirSync(inputRoot,{recursive:true});
  let source='';
  if(!doctor){const original=workspacePath(root,join(root,sample.paths[0]));if(await sha256(original)!==sample.sourceSha256)throw Error('Source SHA changed');
    source=join(inputRoot,`${sample.sampleId}.gim`);if(!existsSync(source))cpSync(original,source);
    if(await sha256(source)!==sample.sourceSha256)throw Error('Input snapshot SHA changed');}
  const runId=`run-${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`,out=join(root,'tmp','gim-bench','runs',runId);
  mkdirSync(out,{recursive:true});const profile=join(out,'webview-profile');mkdirSync(profile);
  dataRoot=dataRoot?workspacePath(root,dataRoot):join(out,'cache');mkdirSync(dataRoot,{recursive:true});
  if(cacheState==='cold'&&readdirSync(dataRoot).length)throw Error('Cold cache root must be new/empty');
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
  const debugPort=await port(),env={...process.env,TEMP:out,TMP:out,TMPDIR:out,LOCALAPPDATA:out,APPDATA:out,
    GIM_BENCHMARK_MANIFEST:manifestPath,WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_BROWSER_EXECUTABLE_FOLDER:runtime,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1 --enable-logging --log-file="${join(out,'webview.private.log')}" --v=1`};
  const child=spawn(executable,[],{cwd:folder,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let spawnFailed=false;child.on('error',()=>{spawnFailed=true;});
  // Raw output is private. Cap bytes; logs are never copied into report.json.
  let logFailures=0;
  for(const name of ['stdout','stderr']){let bytes=0;child[name].on('data',data=>{try{if(bytes<4*1024*1024)appendFileSync(join(out,`${name}.private.log`),data);}catch{logFailures++;}bytes+=data.length;});}
  let cdp,sampler,observation=null,cleanupComplete=false,reason=null,crashed=false,heapRows=0,processPeak=null;
  const heaps=new Map(),processSamples=[];let events=0,hostSamplingFailures=0,streamFailures=0,evidence=null,automaticMs=null,cachePublishMs=null,productPeak=null;
  const processSampler=startProcessSampler(samplerExecutable,child,executable,env,row=>{processSamples.push(row);if(row.availability==='available'&&Number.isFinite(row.bytes))processPeak=Math.max(processPeak??0,row.bytes);});
  const acknowledgements=new Map();let ackRunning=false,ackTimer,hostGapStart=null;const hostSamplingGaps=[];
  const flushAcks=async()=>{
    if(ackRunning||!acknowledgements.size||!cdp||cdp.closed)return;
    ackRunning=true;const batch=[...acknowledgements].slice(0,64);
    try{await cdp.evaluate(`for(const [run,id] of ${JSON.stringify(batch.map(([,value])=>value))})globalThis.__gimBenchmark.ack(run,id);undefined`);
      for(const [key]of batch)acknowledgements.delete(key);
    }catch{/* A delayed page response is retried; ack is idempotent. */}finally{ackRunning=false;}
  };
  const actionResults=[];const actionTargets=[];
  let exerciseResult=null;
  const started=performance.now();
  try{
    while(performance.now()-started<30000){
      if(signal?.aborted)throw Error('run-cancelled');
      if(spawnFailed||child.exitCode!==null)throw Error('native-startup-failed');
      try{
        const targets=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`,{signal:AbortSignal.timeout(1000)})).json();
        const pages=targets.filter(t=>t.type==='page'&&(/^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)/.test(t.url)));
        writeFileSync(join(out,'endpoint.private.json'),JSON.stringify({targets},null,2));
        if(pages.length===1){cdp=await CdpConnection.connect(pages[0].webSocketDebuggerUrl,debugPort);break;}
      }catch(error){writeFileSync(join(out,'endpoint.private.json'),JSON.stringify({error:error.message}));}
      await delay(250);
    }
    if(!cdp){
      const log=join(out,'webview.private.log');
      const gpuFailure=existsSync(log)&&readFileSync(log,'utf8').includes("GPU process isn't usable");
      throw Error(gpuFailure?'webview-gpu-process-launch-failed':'native-cdp-unavailable');
    }
    while(await cdp.evaluate('typeof globalThis.__gimBenchmark')!=='object'){if(performance.now()-started>45000)throw Error('benchmark-api-unavailable');await delay(250);}
    const database=await cdp.evaluate("globalThis.__TAURI_INTERNALS__.invoke('get_db_path')");
    if(resolve(database).toLowerCase()!==join(dataRoot,'gim_cache_schema_v1.db').toLowerCase())throw Error('native-cache-root-mismatch');
    sampler=new WorkerHeapSampler(cdp,row=>{
      appendFileSync(join(out,'heap.jsonl'),JSON.stringify(row)+'\n');heapRows++;
      if(row.availability==='available'){const old=heaps.get(row.workerId);heaps.set(row.workerId,{workerId:row.workerId,family:row.family,isolateId:row.isolateId,samples:(old?.samples??0)+1,observedPeakBytes:Math.max(old?.observedPeakBytes??0,row.bytes),maxSampleDelayMs:Math.max(old?.maxSampleDelayMs??0,row.sampleDelayMs)});}
    });
    if(diagnostic){sampler.configureDiagnostic({...diagnostic,mode,
      write:profile=>writeFileSync(join(out,diagnostic.kind==='cpu'?'diagnostic.private.cpuprofile':'diagnostic.private.heapprofile'),JSON.stringify(profile)),
      chunk:chunk=>appendFileSync(join(out,'diagnostic.private.heapsnapshot'),chunk)});}
    if(mode==='benchmark'||mode==='diagnostic')await sampler.start();
    cdp.onEvent(message=>{
      if(message.method!=='Runtime.bindingCalled'||message.params.name!=='__gimMeasurementEmit')return;
      try{
        const frame=JSON.parse(message.params.payload);
        if(typeof frame.runId!=='string'||!Number.isSafeInteger(frame.batchId)||!Array.isArray(frame.events)||frame.events.length>128)throw Error('invalid-frame');
        for(const event of frame.events)if(event.kind==='worker'&&event.name==='created'&&event.workerUrl)sampler.associate(event.workerUrl,frame.contexts[event.contextIndex]);
        appendFileSync(join(out,'events.jsonl'),JSON.stringify(frame)+'\n');events+=frame.events.length;
        if(acknowledgements.size>=128)throw Error('ack-window-overflow');
        acknowledgements.set(`${frame.runId}:${frame.batchId}`,[frame.runId,frame.batchId]);
      }catch{streamFailures++;}
    });
    await cdp.send('Runtime.addBinding',{name:'__gimMeasurementEmit'});await cdp.evaluate('globalThis.__gimBenchmark.stream()');
    ackTimer=setInterval(()=>{flushAcks().catch(()=>{streamFailures++;});},50);
    if(doctor){
      await cdp.evaluate('globalThis.__gimBenchmark.capabilityProbe()');await delay(3500);
      observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');await cdp.evaluate('globalThis.__gimBenchmark.endCapabilityProbe()');
    }else{
      // Start without blocking the sampling loop on the open Promise.
      const args=[sample.sampleId,manifest.nonce,{runId,sourceSha256:sample.sourceSha256,buildId:build.sourceFingerprint,mode}];
      await processSampler.checkpoint('open-start');
      await cdp.evaluate(`globalThis.__gimBenchmark.open(...${JSON.stringify(args)}).catch(()=>{}); undefined`);
      let stableSince=null,completed=false;
      while(performance.now()-started<timeoutMs){
        if(signal?.aborted)throw Error('run-cancelled');
        if(child.exitCode!==null){crashed=true;throw Error('native-process-exited');}
        const requestedAt=performance.now();
        try{observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');if(hostGapStart!==null){if(hostSamplingGaps.length<128)hostSamplingGaps.push({startMs:hostGapStart,endMs:performance.now(),clockId:'controller'});hostGapStart=null;}}
        catch{if(cdp.closed){crashed=true;throw Error('renderer-process-exited');}hostSamplingFailures++;hostGapStart??=requestedAt;await delay(1000);continue;}
        if(observation.progress.automaticSettled&&automaticMs===null){
          const moments=observation.moments;
          automaticMs=Math.max(...['coreSemanticReady','navigationUiReady','allIfcReady','devBaseRepresentationsSettled','devGeometryReady'].map(key=>moments[key]??0))||observation.openElapsedMs;
        }
        if(observation.openError)throw Error('project-open-failed');
        if(automaticMs!==null&&readyForSettle(observation)){
          cachePublishMs??=cachePublicationMoment(observation);
          stableSince??=performance.now();if(performance.now()-stableSince>=3000){completed=true;break;}
        }else stableSince=null;
        if(!observation.opening&&!observation.projectType)throw Error('project-open-unavailable');
        await delay(1000);
      }
      if(automaticMs===null)reason='automatic-completion-not-observed';
      else if(!observation.progress.cacheSettled)reason='cache-publication-not-observed';
      else if(!observation.progress.backgroundSettled)reason='background-completion-not-observed';
      else if(!completed)reason='automatic-settle-timeout';
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
        stableSince=null;
        for(let i=0;i<120&&!reason;i++){
          observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
          if(readyForSettle(observation)){stableSince??=performance.now();if(performance.now()-stableSince>=3000)break;}else stableSince=null;
          await delay(1000);if(i===119)reason='scenario-settle-timeout';
        }
      }
      await processSampler.checkpoint('product-settled');productPeak=processPeak;
      if(!reason)evidence=await cdp.evaluate('globalThis.__gimBenchmark.evidence()',undefined,30000);
    }
    if(exercise&&!reason)exerciseResult=await exercise({cdp,processSampler,sampler,manifest,runId,build,out,evidence});
    for(let attempt=0;attempt<50;attempt++){
      await flushAcks();
      const transport=await cdp.evaluate('globalThis.__gimBenchmark.transport()');
      if(transport.every(row=>row.pending===0&&row.buffered===0))break;
      await delay(100);if(attempt===49)streamFailures++;
    }
    if(acknowledgements.size)streamFailures++;
    await sampler.completeDiagnostics();
    observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
    for(let attempt=0;attempt<30&&observation.measurement.activeTasks.length&&!reason;attempt++){
      await delay(1000);observation=await cdp.evaluate('globalThis.__gimBenchmark.snapshot()');
    }
    if(observation.measurement.activeTasks.length&&!reason)reason='post-settle-task-incomplete';
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
  }catch(error){reason=reasonCode(error);try{writeFileSync(join(out,'failure.private.log'),String(error?.stack??error));}catch{logFailures++;}}
  finally{clearInterval(ackTimer);sampler?.stop();cdp?.close();const sampling=await processSampler.stop();if(sampling.failures)streamFailures+=sampling.failures;try{await stop(child);cleanupComplete=true;}catch{reason='owned-process-cleanup-failed';}}
  writeFileSync(join(out,'process-memory.json'),JSON.stringify(processSamples,null,2));
  const workerMemory=[...heaps.values()],measurement=observation?.measurement??null;
  const processMemoryComplete=processSamples.length>=2&&processSamples.every(row=>row.availability==='available');
  const expectedWorkers=Object.keys(measurement?.workers??{}),missingWorkers=expectedWorkers.filter(id=>!heaps.has(id));
  const conditions={machineId:digest({hostname:hostname(),cpu:cpus()[0]?.model,cores:cpus().length,memory:totalmem(),os:release(),arch:arch()}),runtimeSha256:build.runtime.sha256,buildMode:'release',measurementVersion:'gim-measurement-v1',mode,scenario,cacheState,
    sampleId:sample.sampleId,sourceSha256:sample.sourceSha256,profileDigest,routeDigest:digest(actionTargets),viewportDigest:digest(observation?.viewport??null),viewport:observation?.viewport??null,
    workloadDigest:evidence?digest({workload:evidence.progress.workload,semantic:evidence.semanticDigest,placement:evidence.placementDigest}):null};
  const report={version:'gim-benchmark-v1',runId,kind:doctor?'native-capability-probe':'native-scene',conditions,buildFingerprint:build.sourceFingerprint,processInstanceId:runId,
    correctness:actionResults.some(row=>row.status==='failed')||reason==='project-open-failed'||reason==='project-open-unavailable'?'failed':evidence?(evidence.passed?'passed':'failed'):'unverified',
    cacheVerified:cacheVerified(evidence,cacheState,observation?.projectType),
    measurementComplete:!reason&&processMemoryComplete&&streamFailures===0&&cleanupComplete&&!!measurement?.detailComplete&&!measurement.activeTasks.length&&!missingWorkers.length,
    requiredMetrics:['firstResponseMs','automaticLoadMs','processPrivatePeakBytes'],metrics:{firstResponseMs:observation?.moments.navigationUiReady??observation?.moments.coreSemanticReady??null,firstGeometryMs:observation?.moments.firstGeometryReady??observation?.moments.firstUsableGeometryReady??null,automaticLoadMs:automaticMs,cachePublishMs,processPrivatePeakBytes:productPeak??processPeak,wholeRunPrivatePeakBytes:processPeak},
    completionDefinition:'automatic-representations-then-cache-and-spatial-terminal-with-quiet-window-not-all-L2',evidence,eventFormat:'context-table-v1',streamFailures,
    actionResults,actionTargetDigests:actionTargets,diagnostic:sampler?.diagnosticResult??null,logFailures,
    exercise:exerciseResult,
    processSampling:{complete:processMemoryComplete,samples:processSamples.length,available:processSamples.filter(row=>row.availability==='available').length},
    crashed,reason,cleanupComplete,measurement,workerMemory,missingWorkerMemory:missingWorkers,sampling:sampler?.snapshot()??null,heapRows,events,hostSamplingFailures,hostSamplingGaps,
    capabilityResult:observation?.capabilityResult??null,
    capabilityOutcome:doctor&&processMemoryComplete&&workerMemory.some(w=>w.family==='measurement-probe')&&measurement?.detailComplete&&!measurement.activeTasks.length
      &&observation?.capabilityResult?.moduleExecutions===1&&observation?.capabilityResult?.roundTripValue===18?'PASS':'INCONCLUSIVE'};
  Object.assign(report,runReadiness(report));
  writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));return {out,report,dataRoot};
}
