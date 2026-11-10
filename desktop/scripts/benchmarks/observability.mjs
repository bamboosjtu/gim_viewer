import {cpuHotspots} from './profile-summary.mjs';
import {MEASUREMENT_VERSION} from '../../../packages/measurement-core/src/version.mjs';
import {readFileSync,writeFileSync,existsSync,mkdirSync,createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {normalizeTrace,expandFrames,blockingPath,traceCoverage,exportChromeTrace} from './trace-analysis.mjs';
import {artifactFile} from './batch-input.mjs';
const identities=new Set(['inputId','sampleId','runId','workerId','taskId','sourceId','operationTraceId','executorId','scopeId','spanId','id','partialSignature','buildFingerprint','profileDigest']);
const arrays=new Set(['rows','runs','summaries','stages','slowTasks','slowPhases','templateDiagnostics','workers','domains','paths','taskPaths','ids','unattributed','issues','captures','diagnostics','system','gpu','hotspots','pipeline','metrics','counts','coverage','processSampling','memory','cases','actions','cacheStates']);
const enums=new Set(['PASS','PARTIAL','FAIL','INCONCLUSIVE','INPUT_ERROR','ERROR','SKIPPED','CANCELLED','DUPLICATE','RUNNING','PENDING','COMPLETE',
  'cold','warm','none','substation','equipment','transmission_line','benchmark','diagnostic','available','unavailable','unsupported','not-triggered',
  'not-requested','CDP-sample-delta-estimate','elapsed-query-command-range','ms','us','bytes','calls','truncated','complete','partial','unknown','closed','open','conflict','interval-only','Critical Path','Critical Path Candidates','Partial Blocking Path','scope-unclosed','effective-scope-missing','capability-disabled','clock-mapping-unavailable','span-evidence-partial','host','dev','engineering','line','spatial','ifc-conversion','ifc-regional','ifc-fine']);
const publicKeys=new Set(['exportId','status','outcome','correctness','cacheState','projectType','family','availability','state','kind','mode',
  'repetitions','repetition','planned','validRepetitions','passed','partial','failed','inconclusive','skipped','coverageGroups','startupRetries','count','totalMs','maxMs',
  'firstResponseMs','firstGeometryMs','allGeometryReadyMs','settledMs','automaticLoadMs','modelTreeReadyMs','cachePublishMs','writeDrainMs','processPrivatePeakBytes',
  'measurementComplete','memoryEvidenceComplete','measurementDetailDropped','measurementLifecycleComplete','traceComplete','cacheVerified','baselineEligible',
  'wallClockMs','requested','available','unavailable','unsupported','method','unit','startMs','endMs','durationMs','estimatedMs','value','samples','maxSampleGapMs','maxSampleDelayMs','observedPeakBytes','observedHeapPeakBytes','attempts','updatedAt','atMs','bytes','sampleDelayMs']);
for(const key of ['stage','heapAvailability','heapReason','heapSamples','failedHeapSamples','sampleLabel','sampleTier','group','error','reason','reasonCode','preset','version',
  'workloadBytes','msPerMiB','p50LowerMs','p50UpperMs','p95LowerMs','p95UpperMs','p99LowerMs','p99UpperMs','lod','priority','admittedPriority','slotCapacityAtEnqueue','slotCapacity','slotsBusyAtEnqueue','queueDepthAtEnqueue','slotsBusyAtAdmit','queueWaitMs','slotOccupancyMs','cacheReadMs','workerAwaitMs','workerQueueWaitTotalMs','workerDispatches','inputBudgetWaitMs','outputBytes','cacheStatus','memoryPressure','selector','anonymize'])publicKeys.add(key);
for(const value of ['not-applicable','short-lived','idle','ready','miss','hit','high','critical','normal','completed','failed','cancelled','queue','placement','survey','baseline','L0','L1','L2','gim-batch-profile-v1','gim-batch-results-v1','dev-fine','ifc-near','ifc-fine','canonical-first-base-v1','canonical-first-boolean-base-v1','smallest-source-canonical-small-object-v1'])enums.add(value);
for(const key of ['name','cacheWriteBytes','cacheWriteMsPerMiB','pendingCount','pendingSourceCount','devContentCovered','devContentComplete','cachePublished','coverageComplete','devCatalogMisses','sourceFailureCatalogMisses','unexplainedCatalogMisses','catalogProofComplete','devPartialOccurrences','unresolvedReferenceCount','processSamples','processSamplesAvailable','missingWorkerHeaps','unavailableWorkerHeaps','shortLivedWorkerHeaps','notApplicableWorkerHeaps','failedGeometry','failedSourceCount','pendingTasks','cancelledBeforeStart','lateBackgroundTasks','interruptedAtMs','interruptedWritePending','interruptedCacheSettled','backgroundSettled','startupFailures','measurementIncompleteItems','memoryIncompleteItems','measurementLifecycleIssues','cacheFailureCode','finalEvidenceIssue'])publicKeys.add(key);
const reasonFields=new Set(['error','reason','reasonCode','heapReason','cacheFailureCode','finalEvidenceIssue','startupFailures','measurementIncompleteItems','memoryIncompleteItems','measurementLifecycleIssues','issues']);
for(const key of ['timeoutMs','detailPolicy','lifecyclePolicy','contentPolicy','cacheProofPolicy','webviewProfilePolicy','startupRetryPolicy','maxStartupAttempts','measurementVersion','partialKind','partialCounts','failedOccurrences','failedSourceCount','unresolvedReferences'])publicKeys.add(key);
for(const value of ['task-phase-timeline-v2','worker-terminal-v2','dev-l0-glb-sha256-v1','source-failure-catalog-v1','paired-webview-profile-v1','pre-open-infrastructure-v1',MEASUREMENT_VERSION,'source-geometry','engineering-reference-coverage','coverage'])enums.add(value);
const phaseNames=new Set(('assemblyParseMs blobReadMs bounds decode decodeMs discovery exportWallMs mergeMs parse-dev parse-mod parse-phm parseMs part-merge primitive primitiveMs readRpcMs source-blob-wait source-rpc-wait validateMs validateParseMs cache-encode composition-projection extract normalize projection source-read spatial-projection delivery-and-worker-queue output-retention result-roundtrip send execution queue anchorQueue cacheHash cacheInvokeWall cacheNativeResolve cacheNativeWrite cachePack cachePrepare cacheRead cacheWrite cacheWriteQueue catalogCacheRead deserialize inputBudgetQueue memoryTemplate placementCommit requestWall sceneCommitQueue sceneSubmitWall sourceRpc templateBuild templateQueue templateSlotOccupancy templateWall vertexValidation workerQueue workerWall connectionEvidenceMs connectionGeometryMs earlyPreparationMs importWithBoundsMs openModelMs output-backpressure preparationMs remainingIndexMs semanticsMs sourceHashMs wasm-init wasmInitMs mesh-extraction open-model relationships finalize scan-and-model submission scheduled-task').split(' '));
const reasonWords=new Set(('input-corrupt INPUT_CORRUPT product-geometry-failed warm-preparation-incomplete WARM_UNSUPPORTED batch-execution-failed controller-interrupted batch-not-executed run-cancelled automatic-completion-not-observed correctness-unverified pending-evidence-missing measurement-incomplete measurement-lifecycle-incomplete cache-state-unverified missing-condition missing-metric measurement run lifecycle collector active-tasks worker-interrupted-tasks unexplained-task-abort interruptedTasks workloadDigest automaticLoadMs firstResponseMs firstGeometryMs allGeometryReadyMs settledMs previous-sample-pending worker-target-not-observed target-ended previous-sample-failed not-applicable target-not-observed unavailable sample-timeout').split(' '));
for(const code of ['native-run-error','worker-target-ended','previous-sample-pending','private-tree-sampler-unavailable','heap-samples-missing','heap-samples-unavailable','worker-memory-unavailable','active-tasks','not-requested','unverified-reason-omitted'])reasonWords.add(code);
for(const code of ['missing-dependency','source-reference-unresolved','capacity-exceeded','parse-failed','ifc-manifest-incomplete','geometry-failed','source-invalid'])reasonWords.add(code);
for(const code of ['authenticated-system-helper-required','profile-clock-domain-unverified','slow-span-index-overflow','worker-probe-retention-expired',
  'cold-warm','correctness','partial-coverage','semanticDigest','workload'])reasonWords.add(code);
enums.add('overlapping-span-duration-sum');
enums.add('top-duration-dependency-targets');
for(const key of ['taskPathSelection','limit','eligible','omitted','unclassified'])publicKeys.add(key);
function controlledReason(value){return String(value).split(';').map(token=>token.split(':').every(word=>reasonWords.has(word)||/^\d+$/.test(word))?token:'unverified-reason-omitted').join(';');}
function controlledStage(value){const segments=value.split(':');
  if(segments.length>2||segments.length===2&&!['host','dev','engineering','line','spatial','ifc-conversion','ifc-regional','ifc-fine'].includes(segments[0]))return false;
  const name=segments.at(-1),parts=name.split('.');
  if(/^host\.cacheWrite\.(catalog|templates\.L[012])$/.test(name))return true;
  return ['host','dev','worker','engineering','ifc','spatial','line','render'].includes(parts[0])&&phaseNames.has(parts.at(-1))&&parts.slice(1,-1).every(p=>['worker','catalog','templates','L0','L1','L2'].includes(p));}
/** This is a new view, never a redacted copy of authority. Aliases live only in this export. */
export function createPublicProjector({anonymize=true}={}){
  const aliases=new Map();let serial=0;
  const alias=value=>{if(!aliases.has(value))aliases.set(value,'alias-'+ ++serial);return aliases.get(value);};
  function project(value,key=''){
    if(value===null)return null;
    if(key==='exportId')return typeof value==='string'&&/^export-[a-f0-9]{24}$/.test(value)?value:undefined;
    if(identities.has(key)&&typeof value==='string')return alias(value);
    if(key==='sampleLabel'&&typeof value==='string')return !anonymize&&value.length<=180&&!/[\\/\x00-\x1f]/.test(value)&&/\.gim$/i.test(value)?value:undefined;
    if(key==='stage'&&typeof value==='string')return controlledStage(value)?value:alias('stage:'+value);
    if(reasonFields.has(key)&&typeof value==='string')return value?controlledReason(value):'';
    if(key==='name'&&typeof value==='string')return ['I/O & cache','Parse & semantic','Geometry','Submission','GPU'].includes(value)||controlledStage(value)?value:undefined;
    if(typeof value==='number')return Number.isFinite(value)?value:null;
    if(typeof value==='boolean')return value;
    if(typeof value==='string')return enums.has(value)?value:null;
    if(Array.isArray(value))return value.map(v=>project(v,key==='ids'?'spanId':reasonFields.has(key)?'reason':'')).filter(v=>v!==undefined);
    if(value&&typeof value==='object'){
      const result={};for(const [k,v]of Object.entries(value)){
        if(publicKeys.has(k)||identities.has(k)||arrays.has(k)||/^(firstResponseMs|firstGeometryMs|allGeometryReadyMs|settledMs|automaticLoadMs|processPrivatePeakBytes)(Median|P95|Count|Missing)$/.test(k)){
          const projected=project(v,k);if(projected!==undefined)result[k]=projected;
        }
      }return result;
    }
  }
  return input=>({...project(input),artifactRole:'public-derived',omissions:['source-identities','paths','raw-profiles','business-strings','unverified-symbols'],authority:false});
}
export function publicView(input,options){return createPublicProjector(options)(input);}
async function readRunTrace(root,input,{summarize=true}={}){
  const location=relative(join(root,'tmp'),input);
  if(location.startsWith('..')||isAbsolute(location))throw Error('private-run-must-be-in-workspace-tmp');
  const report=JSON.parse(readFileSync(input,'utf8'));
  if(report.artifactRole==='public-derived')throw Error('public-derived-is-not-authoritative');
  if(report.conditions?.measurementVersion&&report.conditions.measurementVersion!==MEASUREMENT_VERSION)throw Error('unsupported-measurement-version');
  const directory=dirname(input),file=join(directory,'events.jsonl'),events=[];
  let truncated=false;
  if(existsSync(file))for await(const line of createInterface({input:createReadStream(file),crlfDelay:Infinity})){
    if(events.length>=100000){truncated=true;break;}
    const records=expandFrames([JSON.parse(line)]),remaining=100000-events.length;
    if(records.length>remaining){events.push(...records.slice(0,remaining));truncated=true;break;}
    events.push(...records);
  }
  const trace=normalizeTrace(events,{health:report.measurement?.traceHealth});
  if(truncated)trace.issues.push('analysis-event-limit');
  if(report.traceOutput?.truncated)trace.issues.push('trace-output-truncated');
  const operations=[...new Set(events.map(e=>e.context?.operationTraceId).filter(Boolean))];
  if(!operations.length)trace.issues.push('operation-context-unavailable');
  for(const operationTraceId of operations){
    const moments=trace.milestones.filter(e=>e.context.operationTraceId===operationTraceId);
    const first=name=>moments.find(e=>e.trace.name===name);
    const base=[first('allIfcReady'),first('devBaseRepresentationsSettled')].filter(Boolean).sort((a,b)=>b.atMs-a.atMs)[0];
    for(const [name,event]of [['firstResponseMs',first('navigationUiReady')??first('coreSemanticReady')],['firstGeometryMs',first('firstGeometryReady')??first('firstUsableGeometryReady')],['allGeometryReadyMs',base]])
      if(event)trace.milestones.push({...event,trace:{...event.trace,name,action:'derived-from-product-event',eventRefs:[{runId:event.context.runId,producerId:event.producerId,sequence:event.sequence}]}});
  }
  if(!summarize)return {trace};
  const coverage=operations.map(id=>traceCoverage(trace,id)),paths=operations.flatMap(operationTraceId=>
    ['firstResponseMs','firstGeometryMs','allGeometryReadyMs','settledMs'].map(milestone=>blockingPath(trace,{operationTraceId,milestone})));
  const taskPaths=[],targets=new Set(trace.dependencies.map(e=>e.trace.toSpanId)),taskTargets=[];
  let eligibleTaskPaths=0;
  // Bounded top-N selection: never rebuild the graph for every task in a run.
  for(const span of trace.spans)if(targets.has(span.id)&&span.state==='closed'){
    eligibleTaskPaths++;
    taskTargets.push(span);taskTargets.sort((a,b)=>b.durationMs-a.durationMs||a.key.localeCompare(b.key));
    if(taskTargets.length>16)taskTargets.pop();
  }
  for(const span of taskTargets){
    const id=span.id;
    const name='task-end:'+id;
    trace.milestones.push({context:span.context,clockId:span.clockId,atMs:span.endMs,
      trace:{type:'milestone',name,action:'derived-from-span-end',fromSpanId:id,eventRefs:span.eventRefs}});
    taskPaths.push(blockingPath(trace,{operationTraceId:span.context.operationTraceId,milestone:name}));
  }
  const pipeline=['I/O & cache','Parse & semantic','Geometry','Submission','GPU'].map(name=>({name,totalMs:0,count:0,unit:'ms',method:'overlapping-span-duration-sum'}));
  const unclassified={totalMs:0,count:0};
  for(const span of trace.spans){if(span.durationMs===null)continue;
    const name=(span.name??'').toLowerCase(),index=/gpu/.test(name)?4:/render|commit|submit/.test(name)?3:/geometry|discovery|mesh|glb|csg|compile|merge|primitive|boolean/.test(name)?2:
      /parse|semantic|decode|engineering/.test(name)?1:/read|cache|extract|io[.:]/.test(name)?0:-1;
    if(index<0){unclassified.totalMs+=span.durationMs;unclassified.count++;continue;}
    pipeline[index].totalMs+=span.durationMs;pipeline[index].count++;
  }
  for(const event of trace.events.filter(e=>e.trace?.name==='gpu.elapsed'&&e.trace.action==='available')){
    pipeline[4].totalMs+=event.trace.value;pipeline[4].count++;
  }
  const profiles=(report.diagnostics?.captures??[]).map(capture=>{
    if(capture.status!=='available'||!capture.privateArtifact||capture.requested?.kind!=='cpu')return {status:capture.status};
    const file=artifactFile(root,capture.privateArtifact);return {executorId:capture.executorId,...cpuHotspots(JSON.parse(readFileSync(file,'utf8')))};});
  const memoryFile=join(directory,'process-memory.json');
  const memory=existsSync(memoryFile)?JSON.parse(readFileSync(memoryFile,'utf8')).map(row=>({
    atMs:row.atMs,bytes:row.bytes,availability:row.availability,sampleDelayMs:row.sampleDelayMs})): [];
  const analysis={memory,unclassified,measurementVersion:trace.measurementVersion,coverage,paths,taskPaths,
    taskPathSelection:{method:'top-duration-dependency-targets',limit:16,eligible:eligibleTaskPaths,omitted:Math.max(0,eligibleTaskPaths-taskPaths.length)},pipeline,issues:trace.issues,
    metrics:report.metrics,diagnostics:{captures:profiles,system:report.diagnostics?.system??null,gpu:report.diagnostics?.gpu??null},trace};
  return analysis;
}
export async function analyzeRun(root,input){
  const analysis=await readRunTrace(root,input),summary={...analysis.trace};delete summary.events;
  // Raw records remain in events.jsonl; summaries retain eventRefs for lookup.
  analysis.trace={...summary,eventSource:'events.jsonl'};
  for(const key of ['operations','milestones','dependencies','waits','resources'])
    analysis.trace[key]=summary[key].map(event=>({context:event.context,clockId:event.clockId,atMs:event.atMs,trace:event.trace,
      eventRef:{runId:event.context.runId,producerId:event.producerId,sequence:event.sequence}}));
  const directory=dirname(input);
  writeFileSync(artifactFile(root,join(directory,'analysis.private.json')),JSON.stringify(analysis,null,2));
  return analysis;
}
export async function exportRunTrace(root,input){
  const analysis=await readRunTrace(root,input,{summarize:false}),file=artifactFile(root,join(dirname(input),'trace.private.json'));
  writeFileSync(file,JSON.stringify(exportChromeTrace(analysis.trace)));return file;
}
const htmlEscape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function writeObservabilityReport(out,analysis,{internal=false}={}){
  mkdirSync(out,{recursive:true});
  const view=internal?analysis:publicView(analysis);
  const pipeline=analysis.pipeline??[];
  const cards=pipeline.map(p=>'<div class="stage"><b>'+htmlEscape(p.name)+'</b><p>'+
    (p.count?p.totalMs.toFixed(1)+' ms · '+p.count+' spans':'未采集/无区间')+'</p></div>').join('');
  // The HTML needs a bounded overview, never the complete span/edge inventory.
  const compactPath=path=>({...path,coverage:undefined,waits:undefined,resourceConstraints:undefined,
    omittedCandidates:Math.max(0,(path.paths?.length??0)-8),
    paths:(path.paths??[]).slice(0,8).map(p=>({...p,ids:p.ids.slice(0,128),omittedSpanIds:Math.max(0,p.ids.length-128),
      unattributed:p.unattributed?.slice(0,32),omittedIntervals:Math.max(0,(p.unattributed?.length??0)-32)}))});
  const overview={artifactRole:view.artifactRole,authority:view.authority,metrics:view.metrics,pipeline:view.pipeline,
    unclassified:view.unclassified,issues:view.issues,taskPathSelection:view.taskPathSelection,
    coverage:(view.coverage??[]).map(row=>({...row,domains:row.domains?.map(domain=>({...domain,windows:undefined}))})),
    paths:(view.paths??[]).slice(0,16).map(compactPath),taskPaths:(view.taskPaths??[]).slice(0,16).map(compactPath),
    memory:(view.memory??[]).slice(0,2048),memoryPreview:{total:view.memory?.length??0,omitted:Math.max(0,(view.memory?.length??0)-2048)}};
  const payload=JSON.stringify(overview).replaceAll('<','\\u003c');
  const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GIM 测量</title>'+
    '<style>body{font:15px system-ui;margin:32px;background:#101923;color:#e3edf7}section{display:flex;gap:12px;flex-wrap:wrap}.stage{background:#203347;padding:16px;flex:1;min-width:150px}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#80bdff}</style>'+
    '<h1>GIM Benchmark / Trace / Profile</h1><p>阶段累计 elapsed 可重叠，不能相加为打开时长。CPU 采样权重、GPU elapsed 与进程观测峰值各有独立口径。</p>'+
    '<p>页面展示有界概览，省略数保留；内存图最多显示前 2048 个样本。完整摘要见 <a href="'+(internal?'report.private.json':'report.json')+'">JSON 报告</a>。</p>'+
    '<section>'+cards+'</section><p>未分类阶段：'+(analysis.unclassified?.count??0)+' 个；不推断为 I/O、CPU 或 GPU。</p><h2>四个产品里程碑</h2><pre>'+htmlEscape(JSON.stringify(view.metrics??{},null,2))+'</pre>'+
    ((view.memory?.length??0)>0?'<h2>进程树 Private Bytes 采样</h2><p>横轴为独立原生采样器毫秒；观测峰值是窗口下界，单点仅为快照。缺失不填零，不与 JS Heap / Buffer 相加。</p><canvas id="memory" width="1200" height="220" style="max-width:100%"></canvas>':'')+
    (internal?'<p><a href="trace.private.json">Perfetto 时间线</a></p>':'<p>匿名派生视图；不能用于基线批准。完整事件和原始诊断保存在本机私有目录。</p>')+
    '<h2>覆盖、阻塞链与诊断</h2><pre id="evidence"></pre><script>const data='+payload+';document.querySelector("#evidence").textContent=JSON.stringify(data,null,2);'+
    'const canvas=document.querySelector("#memory");if(canvas){const ctx=canvas.getContext("2d"),rows=data.memory.filter(r=>r.availability==="available"&&Number.isFinite(r.bytes));'+
    'if(ctx&&rows.length){const max=Math.max(1,...rows.map(r=>r.bytes)),end=Math.max(1,...rows.map(r=>r.atMs));ctx.strokeStyle="#80bdff";ctx.beginPath();let pen=false;for(const r of data.memory){if(r.availability!=="available"||!Number.isFinite(r.bytes)){pen=false;continue}const x=r.atMs/end*1180+10,y=210-r.bytes/max*200;pen?ctx.lineTo(x,y):ctx.moveTo(x,y);pen=true}ctx.stroke();canvas.title="观测样本 "+rows.length+"；峰值 "+(max/2**30).toFixed(3)+" GiB";}}</script></html>';
  writeFileSync(join(out,'report.html'),html);writeFileSync(join(out,internal?'report.private.json':'report.json'),JSON.stringify(view,null,2));
  return out;
}
