import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTrace,blockingPath,exportChromeTrace,mapTime,waitIntervals,resourceConstraints,resolveScopes} from './trace-analysis.mjs';
import {publicView,createPublicProjector,writeObservabilityReport} from './observability.mjs';
import {parseCsv,summarizeSystemRows,SystemCapture} from './system-diagnostics.mjs';
import {diagnosticPlan,CaptureController} from './diagnostics.mjs';
import {analyzeRun,exportRunTrace} from './observability.mjs';
import {renderReport} from './reporter.mjs';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {JSDOM} from 'jsdom';
import {cpuHotspots} from './profile-summary.mjs';
import {MEASUREMENT_VERSION} from '../../../packages/measurement-core/src/version.mjs';
import {writeArtifactInventory} from './artifacts.mjs';
test('private artifact inventory distinguishes existing events, missing captures and GPU support',()=>{
  const parent=resolve('..','tmp','artifact-inventory-contract');mkdirSync(parent,{recursive:true});const out=mkdtempSync(join(parent,'run-'));
  writeFileSync(join(out,'events.jsonl'),'{}\n');
  let inventory=writeArtifactInventory(out,{runId:'r',conditions:{mode:'benchmark'}});
  assert.equal(inventory.events.status,'available');assert.equal(inventory.analysis.status,'not-requested');
  assert.equal(inventory.captures.find(c=>c.kind==='heap').status,'not-requested');
  writeFileSync(join(out,'gpu.private.json'),'{}');
  inventory=writeArtifactInventory(out,{runId:'r',conditions:{mode:'diagnostic'},projectType:'transmission_line',
    diagnostics:{gpu:{requested:true,availability:'unavailable',available:0},captures:[{status:'unavailable',reason:'capture-failed',requested:{kind:'cpu'}}]}});
  assert.equal(inventory.trace.status,'unavailable');assert.equal(inventory.captures[0].status,'unavailable');
  assert.equal(inventory.gpu.availableSamples,0);assert.equal(inventory.gpu.reason,'line-gpu-timer-not-instrumented');
});

function fixture(equal=false){
  const events=[],context={runId:'run',operationTraceId:'op',executorId:'host',workerId:'host',taskId:null,attemptId:1};
  function emit(atMs,trace){const event={version:MEASUREMENT_VERSION,context:{...context},producerId:'host:trace',sequence:events.length+1,
    clockId:'main',atMs,kind:'trace',name:'trace.'+trace.type,trace};events.push(event);return {runId:'run',producerId:event.producerId,sequence:event.sequence};}
  emit(0,{type:'operation',action:'started',id:'op',name:'open'});
  emit(0,{type:'scope',action:'declared',scope:{scopeId:'scope',declaration:'requested',scopeType:'operation',operationTraceId:'op',
    executorId:'host',capabilities:['operation-context','span-lifecycle'],window:{clockId:'main',startMs:0,endMs:null}}});
  emit(0,{type:'scope',action:'declared',scope:{...events[1].trace.scope,declaration:'effective',scopeType:'executor'}});
  const refs={};
  for(const [id,end]of [['A',equal?500:100],['B',500],['C',200],['D',300]]){
    emit(0,{type:'span',action:'started',id,name:'compile'});
    refs[id]=emit(end,{type:'span',action:'ended',id,endMs:end});
  }
  const mergeStart=emit(500,{type:'span',action:'started',id:'merge',name:'merge'});
  for(const id of ['A','B','C','D'])emit(500,{type:'dependency',action:'required',fromSpanId:id,toSpanId:'merge',eventRefs:[refs[id],mergeStart]});
  emit(600,{type:'span',action:'ended',id:'merge',endMs:600});
  emit(600,{type:'scope',action:'closed',id:'scope',endMs:600});
  emit(600,{type:'milestone',action:'observed',name:'first',fromSpanId:'merge'});
  return {events,emit};
}
const query={operationTraceId:'op',milestone:'first'};
test('four-part fan-in is B + Merge = 600, with no invented merge wait',()=>{
  const trace=normalizeTrace(fixture().events),path=blockingPath(trace,query);
  assert.equal(path.kind,'Critical Path');assert.deepEqual(path.paths[0].ids,['B','merge']);assert.equal(path.paths[0].weight,600);
  assert.equal(trace.waits.length,0);
});
test('unknown milestone predecessors do not turn unrelated work into a blocking path',()=>{
  const {events}=fixture();delete events.find(e=>e.trace.type==='milestone').trace.fromSpanId;
  const path=blockingPath(normalizeTrace(events),query);
  assert.equal(path.kind,'Partial Blocking Path');assert.deepEqual(path.paths,[]);
  assert.deepEqual(path.unattributed,[{startMs:0,endMs:600}]);
});
test('equal predecessors preserve both candidates',()=>{
  const path=blockingPath(normalizeTrace(fixture(true).events),query);
  assert.equal(path.kind,'Critical Path Candidates');assert.deepEqual(path.paths.map(p=>p.ids),[['A','merge'],['B','merge']]);
});
test('an earlier-ending heavier predecessor is not pruned by a later lighter chain',()=>{
  const {events}=fixture();
  for(const event of events)if(event.trace.type==='span'&&event.trace.id==='B'&&event.trace.action==='started')event.atMs=490;
  const path=blockingPath(normalizeTrace(events),query);
  assert.deepEqual(path.paths[0].ids,['D','merge']);assert.equal(path.paths[0].weight,400);
  assert.equal(path.kind,'Partial Blocking Path');
});
test('a referenced task roundtrip counts once while its nested worker interval remains visible',()=>{
  const {events}=fixture();
  events.find(e=>e.trace.id==='B'&&e.trace.action==='started').trace.name='host.scheduled-task';
  const base=events[0];
  events.push({...base,producerId:'child:trace',sequence:1,atMs:50,trace:{type:'span',action:'started',id:'child',name:'primitive',parentSpanId:'B'}},
    {...base,producerId:'child:trace',sequence:2,atMs:400,trace:{type:'span',action:'ended',id:'child',endMs:400}});
  const trace=normalizeTrace(events),path=blockingPath(trace,query);
  assert.equal(trace.spans.find(s=>s.id==='child').durationMs,350);
  assert.deepEqual(path.paths[0].ids,['B','merge']);assert.equal(path.paths[0].weight,600);
});
test('interval and lifecycle share one identity; conflicting endpoints are excluded',()=>{
  const {events}=fixture(),start=events.find(e=>e.trace.id==='B'&&e.trace.action==='started');
  events.push({...start,producerId:'host',sequence:1,kind:'phase',trace:undefined,spanId:'B',timing:'interval',startMs:0,durationMs:490,name:'compile'});
  const trace=normalizeTrace(events);
  assert.equal(trace.spans.filter(s=>s.id==='B').length,1);
  assert.equal(trace.spans.find(s=>s.id==='B').state,'conflict');
  assert.equal(blockingPath(trace,query).kind,'Partial Blocking Path');
});
test('replay deduplicates; missing end and invalid references stay partial',()=>{
  const {events}=fixture();events.push(events[0]);assert.equal(normalizeTrace(events).eventCount,events.length-1);
  const missing=events.filter(e=>!(e.trace.id==='B'&&e.trace.action==='ended'));
  assert.equal(normalizeTrace(missing).spans.find(s=>s.id==='B').state,'open');
  assert.equal(blockingPath(normalizeTrace(missing),query).kind,'Partial Blocking Path');
});
test('clock segments apply to event time and ambiguous segments are rejected',()=>{
  const segments=[{clockId:'w',referenceClockId:'m',offsetMs:10,uncertaintyMs:2,validFromLocalMs:0,validToLocalMs:100},
    {clockId:'w',referenceClockId:'m',offsetMs:20,uncertaintyMs:3,validFromLocalMs:101,validToLocalMs:200}];
  assert.deepEqual(mapTime('w',50,segments,'m'),{ms:60,uncertaintyMs:2});
  assert.equal(mapTime('w',201,segments,'m'),null);assert.equal(mapTime('w',50,[...segments,segments[0]],'m'),null);
});
test('unclosed scope never proves complete and export does not fabricate an end',()=>{
  const {events}=fixture();const missing=events.filter(e=>!(e.trace.id==='B'&&e.trace.action==='ended')&&e.trace.action!=='closed');
  const trace=normalizeTrace(missing),exported=exportChromeTrace(trace);
  assert.equal(blockingPath(trace,query).coverage.traceComplete,false);
  assert.equal(exported.metadata.timestampUnit,'us');assert.equal(exported.traceEvents.filter(e=>e.ph==='e'&&e.args?.spanId==='B').length,0);
});
test('public output drops raw identity, URLs, paths, business strings and approval evidence',()=>{
  const raw={runId:'private-run',sampleId:'gim-private',sourceSha256:'a'.repeat(64),path:'C:\\secret',profile:{url:'file://secret'},
    rows:[{sampleId:'gim-private',status:'PASS',firstResponseMs:10,reason:'customer-name'}],metrics:{firstResponseMs:10},approval:{outcome:'PASS'}};
  const a=publicView(raw);assert.equal(a.rows[0].sampleId,a.sampleId);assert.equal(a.rows[0].firstResponseMs,10);
  const json=JSON.stringify(a);for(const token of ['gim-private','private-run','secret','customer-name','aaaaa','approval'])assert.ok(!json.includes(token));
  assert.equal(a.authority,false);
});

test('public projections omit process instances and root memory while retaining approved memory aggregates',()=>{
  const instance={pid:929292,tid:939393,created:'2026-11-12T01:02:03.456Z',processStartedAt:'2026-11-12T01:02:03.456Z'};
  const sample={processInstances:[instance],rootPrivateBytes:987654321,processPrivatePeakBytes:2345678901,
    processSampling:{samples:4,maxSampleGapMs:20},system:{processInstances:[instance],rows:[{...instance,value:12,unit:'ms'}]}};
  const raw={...sample,runs:[sample],startup:{...sample},system:{...sample}},before=JSON.stringify(raw);
  for(const anonymize of [true,false]){
    const view=publicView(raw,{anonymize}),json=JSON.stringify(view);
    for(const token of ['processInstances','rootPrivateBytes','pid','tid','created','processStartedAt','929292','939393','987654321','2026-11-12'])
      assert.ok(!json.includes(token),token);
    assert.equal(view.processPrivatePeakBytes,2345678901);assert.equal(view.runs[0].processSampling.samples,4);
    assert.equal(view.system.system.rows[0].value,12);
  }
  assert.equal(JSON.stringify(raw),before);
  assert.equal(publicView({updatedAt:'private arbitrary timestamp text'}).updatedAt,undefined);
});
test('WPA column mapping rejects schema changes and PID reuse, keeps explicit units',()=>{
  const contract={columns:{pid:'PID',created:'Born',start:'Start',end:'End',value:'Weight'},timeUnit:'ms',unit:'ms',method:'CSwitch'};
  const rows=parseCsv('PID,Born,Start,End,Weight\r\n5,old,0,2,1\r\n5,new,0,2,2\r\n');
  const summary=summarizeSystemRows(rows,contract,[{pid:5,created:'new'}]);
  assert.equal(summary.rows.length,1);assert.equal(summary.rows[0].value,2);assert.equal(summary.rows[0].unit,'ms');
  assert.equal(summarizeSystemRows([{PID:'5'}],contract,[]).availability,'unavailable');
  assert.deepEqual(parseCsv('A,B\n"a,b","x""y"\n'),[{A:'a,b',B:'x"y'}]);
  assert.deepEqual(parseCsv(Buffer.concat([Buffer.from([255,254]),Buffer.from('A,B\r\n1,2\r\n','utf16le')])),[{A:'1',B:'2'}]);
  assert.equal(summarizeSystemRows([{PID:'5',Born:'new',Start:'',End:'2',Weight:'1'}],contract,[{pid:5,created:'new'}]).availability,'unavailable');
  const reused=summarizeSystemRows([{PID:'5',Born:'old',Start:'0',End:'2',Weight:'1'}],contract,[{pid:5,created:'new'}]);
  assert.equal(reused.availability,'unavailable');assert.deepEqual(reused.issues,['owned-process-instance-not-matched']);
  assert.equal(summarizeSystemRows([],contract,[{pid:5,created:'new'}]).availability,'unavailable');
});

test('public projections preserve controlled diagnostic fields and share export-scoped aliases',()=>{
  const project=createPublicProjector({anonymize:false});
  const profile=project({cases:[{sampleId:'gim-private',inputId:'input-1',sampleLabel:'standard-A1.gim'}]});
  const state=project({rows:[{sampleId:'gim-private',inputId:'input-1',sampleLabel:'standard-A1.gim',sourcePath:'C:/private',error:'input-corrupt;customer-private'}],
    stages:[{stage:'host:host.cacheRead',count:2,totalMs:10,p95UpperMs:8},{stage:'customer-private:host.cacheRead',count:1}],
    workers:[{workerId:'private-worker',heapAvailability:'available',heapSamples:3,failedHeapSamples:1}],
    templateDiagnostics:[{taskId:'private-task',kind:'queue',queueWaitMs:12,outputBytes:16}]});
  assert.equal(state.rows[0].sampleId,profile.cases[0].sampleId);assert.equal(state.rows[0].inputId,profile.cases[0].inputId);
  assert.equal(state.rows[0].sampleLabel,'standard-A1.gim');assert.equal(state.rows[0].sourcePath,undefined);
  assert.equal(state.rows[0].error,'input-corrupt;unverified-reason-omitted');
  assert.equal(state.stages[0].stage,'host:host.cacheRead');assert.equal(state.stages[0].p95UpperMs,8);
  assert.equal(state.workers[0].heapAvailability,'available');assert.equal(state.workers[0].heapSamples,3);
  assert.equal(state.templateDiagnostics[0].queueWaitMs,12);assert.ok(!JSON.stringify(state).includes('customer-private'));
  assert.equal(publicView({rows:[{sampleLabel:'standard-A1.gim'}]}).rows[0].sampleLabel,undefined);
});

test('public diagnostics keep controlled failure codes, write sub-stages and profile conditions',()=>{
  const view=publicView({timeoutMs:60000,detailPolicy:'task-phase-timeline-v2',lifecyclePolicy:'worker-terminal-v2',contentPolicy:'dev-l0-glb-sha256-v1',
    rows:[{partialSignature:'source-geometry:private-digest-a',partialKind:'source-geometry',partialCounts:{failedOccurrences:3,failedSourceCount:1},error:'missing-dependency:3;source-reference-unresolved;capacity-exceeded:1;parse-failed:1;ifc-manifest-incomplete'},
      {partialSignature:'source-geometry:private-digest-b',partialKind:'source-geometry',partialCounts:{failedOccurrences:3}}],
    stages:['host:host.cacheWrite.catalog','host:host.cacheWrite.templates.L0','host:host.cacheWrite.templates.L1','host:host.cacheWrite.templates.L2'].map(stage=>({stage,count:1}))});
  assert.equal(view.timeoutMs,60000);assert.equal(view.detailPolicy,'task-phase-timeline-v2');
  assert.equal(view.rows[0].error,'missing-dependency:3;source-reference-unresolved;capacity-exceeded:1;parse-failed:1;ifc-manifest-incomplete');
  assert.equal(view.rows[0].partialCounts.failedOccurrences,3);assert.notEqual(view.rows[0].partialSignature,view.rows[1].partialSignature);
  assert.ok(view.stages.every(row=>row.stage.startsWith('host:host.cacheWrite.')));
  assert.ok(!JSON.stringify(view).includes('private-digest'));
});
test('public cold/warm failure dimensions remain readable while arbitrary reasons stay hidden',()=>{
  const reason='correctness-unverified;cold-warm:correctness;cold-warm:partial-coverage;cold-warm:semanticDigest;cold-warm:workload';
  assert.equal(publicView({reason}).reason,reason);
  assert.equal(publicView({reason:reason+';cold-warm:private-project-name'}).reason,reason+';unverified-reason-omitted');
});
test('diagnostics validate mode-independent windows and do not trigger on an ended span',async()=>{
  assert.throws(()=>diagnosticPlan({captures:[{kind:'cpu',durationMs:30001}]}));
  assert.throws(()=>diagnosticPlan({captures:[{id:'../escape',kind:'cpu'}]}));
  const plan=diagnosticPlan({captures:[{kind:'cpu',trigger:'slow-span',thresholdMs:1}]});
  const controller=new CaptureController({send(){throw Error('should-not-start');}},'.',plan);
  controller.event({controllerReceivedMs:0,context:{runId:'r'},trace:{type:'span',action:'started',id:'done'}});
  controller.event({controllerReceivedMs:1,context:{runId:'r'},trace:{type:'span',action:'ended',id:'done'}});
  controller.startEligible('slow-span');
  assert.equal((await controller.stop())[0].status,'not-triggered');
});
test('CPU hotspots use sample delta estimates and never manufacture exact CPU time',()=>{
  const summary=cpuHotspots({startTime:0,endTime:4000,nodes:[{id:1,callFrame:{functionName:'compile'}},{id:2,callFrame:{functionName:'gc'}}],
    samples:[1,1,2],timeDeltas:[1000,2000,1000]});
  assert.equal(summary.cpuTimeAvailable,false);assert.equal(summary.hotspots[0].estimatedMs,3);
  assert.equal(summary.hotspots[1].estimatedMs,1);assert.equal(summary.unit,'ms');
});
test('wait boundaries and real multi-slot ownership do not imply false data dependencies',()=>{
  const {events,emit}=fixture();
  const add=(at,taskId,trace)=>{emit(at,trace);events.at(-1).context.taskId=taskId;};
  add(10,'A',{type:'resource',action:'granted',resourceId:'pool',slotId:'w1',capacity:2});
  add(11,'B',{type:'resource',action:'granted',resourceId:'pool',slotId:'w2',capacity:2});
  add(20,'C',{type:'wait',action:'started',id:'wait-C',resourceId:'pool'});
  add(30,'A',{type:'resource',action:'released',resourceId:'pool',slotId:'w1'});
  add(35,'C',{type:'resource',action:'granted',resourceId:'pool',slotId:'w1',capacity:2});
  add(35,'C',{type:'wait',action:'ended',id:'wait-C',resourceId:'pool'});
  const trace=normalizeTrace(events),resources=resourceConstraints(trace,'op');
  assert.equal(resources.constraints.length,1);assert.equal(resources.constraints[0].fromTaskId,'A');
  assert.equal(resources.constraints[0].toTaskId,'C');assert.equal(waitIntervals(trace)[0].durationMs,15);
  assert.equal(trace.dependencies.length,4);
});
test('scope inheritance preserves explicit off and detects expansion instead of assuming support',()=>{
  const window={clockId:'c',startMs:0,endMs:10};
  const scopes=[{scopeId:'run',declaration:'requested',capabilities:['span-lifecycle'],window},
    {scopeId:'B',parentScopeId:'run',declaration:'requested',capabilities:[],window},
    {scopeId:'worker-B',parentScopeId:'B',declaration:'effective',capabilities:['span-lifecycle'],window}];
  assert.deepEqual(resolveScopes(scopes).requests.find(s=>s.scopeId==='B').capabilities,[]);
  assert.ok(resolveScopes(scopes).issues.includes('effective-capability-expansion'));
});
test('private run -> analysis -> Perfetto -> executable public report preserves evidence isolation',async()=>{
  const root=resolve('..'),parent=join(root,'tmp','observability-contract');mkdirSync(parent,{recursive:true});
  const fixtureRoot=mkdtempSync(join(parent,'run-')),folder=join(fixtureRoot,'tmp','run'),input=join(folder,'report.json');
  mkdirSync(folder,{recursive:true});
  writeFileSync(input,JSON.stringify({conditions:{measurementVersion:MEASUREMENT_VERSION},
    metrics:{firstResponseMs:600,firstGeometryMs:null,allGeometryReadyMs:null,settledMs:600},
    sourceSha256:'f'.repeat(64),diagnostics:{captures:[]}}));
  writeFileSync(join(folder,'events.jsonl'),fixture().events.map(e=>JSON.stringify(e)).join('\n'));
  const analysis=await analyzeRun(root,input);assert.equal(analysis.coverage[0].traceComplete,true);
  assert.equal(analysis.trace.events,undefined);assert.equal(analysis.trace.eventSource,'events.jsonl');
  assert.equal(JSON.parse(readFileSync(join(folder,'analysis.private.json'),'utf8')).trace.events,undefined);
  const trace=JSON.parse(readFileSync(await exportRunTrace(root,input),'utf8'));
  assert.ok(trace.traceEvents.some(e=>e.ph==='b'));assert.equal(trace.metadata.timestampUnit,'us');
  const publicParent=join(fixtureRoot,'output');mkdirSync(publicParent,{recursive:true});
  const out=mkdtempSync(join(publicParent,'report-'));await renderReport(input,out,{root:fixtureRoot});
  const html=readFileSync(join(out,'report.html'),'utf8'),dom=new JSDOM(html,{runScripts:'dangerously'});
  assert.ok(dom.window.document.querySelector('#evidence').textContent.includes('public-derived'));
  assert.ok(!html.includes('f'.repeat(64)));
  assert.equal(JSON.parse(readFileSync(join(out,'report.json'),'utf8')).authority,false);
  dom.window.close();
  const internal=join(folder,'internal');writeObservabilityReport(internal,analysis,{internal:true});
  const internalHtml=readFileSync(join(internal,'report.html'),'utf8'),internalDom=new JSDOM(internalHtml,{runScripts:'dangerously'});
  const overview=JSON.parse(internalDom.window.document.querySelector('#evidence').textContent);
  assert.equal(overview.trace,undefined);assert.match(internalHtml,/trace\.private\.json/);internalDom.window.close();
});
test('large traces cap task-path queries and persist summary evidence instead of raw events',async()=>{
  const parent=resolve('..','tmp','trace-summary-contract');mkdirSync(parent,{recursive:true});
  const folder=mkdtempSync(join(parent,'run-')),input=join(folder,'report.json'),{events,emit}=fixture();
  for(let i=0;i<200;i++){
    const id='task-'+i,start=emit(100,{type:'span',action:'started',id,name:'geometry.compile'});
    emit(500,{type:'span',action:'ended',id,endMs:500});
    emit(500,{type:'dependency',action:'required',fromSpanId:'A',toSpanId:id,eventRefs:[start]});
  }
  writeFileSync(input,JSON.stringify({conditions:{measurementVersion:MEASUREMENT_VERSION}}));
  writeFileSync(join(folder,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'));
  const analysis=await analyzeRun(resolve('..'),input);
  assert.equal(analysis.taskPaths.length,16);assert.equal(analysis.taskPathSelection.eligible,201);
  assert.equal(analysis.taskPathSelection.omitted,185);assert.equal(analysis.trace.events,undefined);
  assert.ok(analysis.trace.spans.every(span=>Array.isArray(span.eventRefs)));
  const geometry=analysis.pipeline.find(stage=>stage.name==='Geometry');
  assert.equal(geometry.method,'overlapping-span-duration-sum');assert.equal(geometry.unit,'ms');
  assert.ok(geometry.totalMs>600);
});
test('preset CPU capture acknowledges start before releasing the operation barrier',async()=>{
  const root=resolve('..'),parent=join(root,'tmp','capture-arm-contract');mkdirSync(parent,{recursive:true});
  const folder=mkdtempSync(join(parent,'run-'));let releaseStart,armed=false;
  const cdp={onEvent(){return ()=>{};},async send(method){
    if(method==='Profiler.start')await new Promise(resolve=>{releaseStart=resolve;});
    return method==='Profiler.stop'?{profile:{startTime:0,endTime:1000,nodes:[],samples:[],timeDeltas:[]}}:{};
  }};
  const controller=new CaptureController(cdp,folder,diagnosticPlan({captures:[{kind:'cpu'}]}));
  const starting=controller.start().then(()=>{armed=true;});
  while(!releaseStart)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(armed,false);releaseStart();await starting;assert.equal(armed,true);
  const rows=await controller.stop();assert.equal(rows[0].status,'available');
  assert.equal(rows[0].samplingParameters.intervalUs,1000);
});

test('CPU profile brackets retain a candidate while an unverified clock domain stays unavailable',async()=>{
  const parent=resolve('..','tmp','profile-clock-contract');mkdirSync(parent,{recursive:true});
  const out=mkdtempSync(join(parent,'capture-')),offset=1000000;let start,end;
  const cdp={onEvent(){return()=>{};},async send(method){
    if(method==='Profiler.start')start=(performance.now()+offset)*1000;
    if(method==='Profiler.stop'){end=(performance.now()+offset)*1000;return{profile:{startTime:start,endTime:end,nodes:[],samples:[],timeDeltas:[]}};}
    return{};
  }};
  const controller=new CaptureController(cdp,out,diagnosticPlan({captures:[{kind:'cpu',durationMs:1}]}));
  await controller.start();const [capture]=await controller.stop();
  assert.equal(capture.status,'available');assert.equal(capture.clockMapping.availability,'unavailable');
  assert.equal(capture.clockMapping.reason,'profile-clock-domain-unverified');
  assert.equal(capture.clockMapping.sourceUnit,'us');assert.ok(Math.abs(capture.commandBracketCandidate.offsetMs+offset)<5);
  const {offsetMs,uncertaintyMs}=capture.commandBracketCandidate;
  assert.ok(start/1000+offsetMs>=capture.startRequestMs-uncertaintyMs);
  assert.ok(end/1000+offsetMs<=capture.endedAtMs+uncertaintyMs);
});

test('system capture rejects the unauthenticated plan launcher without creating files or elevation',async()=>{
  const parent=resolve('..','tmp','system-auth-contract');mkdirSync(parent,{recursive:true});
  const folder=mkdtempSync(join(parent,'run-')),capture=new SystemCapture(folder,folder,{durationMs:1000,bufferMiB:8},{});
  await capture.start();const status=await capture.stop();
  assert.equal(status.status,'unavailable');assert.equal(status.reason,'authenticated-system-helper-required');
  assert.equal(status.actualCaptureVerified,false);
});

test('slow span trigger sees new activity after the context history exceeds 32k events',async()=>{
  const parent=resolve('..','tmp','slow-span-index-contract');mkdirSync(parent,{recursive:true});const out=mkdtempSync(join(parent,'run-'));
  const cdp={onEvent:()=>()=>{},send:async method=>method==='Profiler.stop'?{profile:{startTime:0,endTime:1000,nodes:[],samples:[],timeDeltas:[]}}:{}};
  const controller=new CaptureController(cdp,out,diagnosticPlan({captures:[{kind:'cpu',target:'main',trigger:'slow-span',stage:'late',thresholdMs:1,durationMs:1}]}));
  const context={runId:'r',executorId:'host',workerId:'host'};
  for(let i=0;i<33000;i++)controller.event({context,trace:{type:'health'},controllerReceivedMs:0});
  controller.event({context,producerId:'host:trace',sequence:1,controllerReceivedMs:performance.now()-100,trace:{type:'span',action:'started',id:'late-span',name:'late'}});
  controller.startEligible('slow-span');const [capture]=await controller.stop();
  assert.equal(capture.status,'available');assert.equal(capture.targetSpanId,'late-span');
  assert.equal(capture.associationTruncated,true);assert.equal(capture.triggerEvidenceComplete,true);
});
