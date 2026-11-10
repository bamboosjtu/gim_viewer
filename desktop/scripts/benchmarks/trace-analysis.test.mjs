import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTrace,blockingPath,exportChromeTrace,mapTime,waitIntervals,resourceConstraints,resolveScopes} from './trace-analysis.mjs';
import {publicView} from './observability.mjs';
import {parseCsv,summarizeSystemRows} from './system-diagnostics.mjs';
import {diagnosticPlan,CaptureController} from './diagnostics.mjs';
import {analyzeRun,exportRunTrace} from './observability.mjs';
import {renderReport} from './reporter.mjs';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {JSDOM} from 'jsdom';
import {cpuHotspots} from './profile-summary.mjs';
import {MEASUREMENT_VERSION} from '../../../packages/measurement-core/src/version.mjs';

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
test('WPA column mapping rejects schema changes and PID reuse, keeps explicit units',()=>{
  const contract={columns:{pid:'PID',created:'Born',start:'Start',end:'End',value:'Weight'},timeUnit:'ms',unit:'ms',method:'CSwitch'};
  const rows=parseCsv('PID,Born,Start,End,Weight\r\n5,old,0,2,1\r\n5,new,0,2,2\r\n');
  const summary=summarizeSystemRows(rows,contract,[{pid:5,created:'new'}]);
  assert.equal(summary.rows.length,1);assert.equal(summary.rows[0].value,2);assert.equal(summary.rows[0].unit,'ms');
  assert.equal(summarizeSystemRows([{PID:'5'}],contract,[]).availability,'unavailable');
  assert.deepEqual(parseCsv('A,B\n"a,b","x""y"\n'),[{A:'a,b',B:'x"y'}]);
  assert.deepEqual(parseCsv(Buffer.concat([Buffer.from([255,254]),Buffer.from('A,B\r\n1,2\r\n','utf16le')])),[{A:'1',B:'2'}]);
  assert.equal(summarizeSystemRows([{PID:'5',Born:'new',Start:'',End:'2',Weight:'1'}],contract,[{pid:5,created:'new'}]).availability,'unavailable');
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
  const folder=mkdtempSync(join(parent,'run-')),input=join(folder,'report.json');
  writeFileSync(input,JSON.stringify({conditions:{measurementVersion:MEASUREMENT_VERSION},
    metrics:{firstResponseMs:600,firstGeometryMs:null,allGeometryReadyMs:null,settledMs:600},
    sourceSha256:'f'.repeat(64),diagnostics:{captures:[]}}));
  writeFileSync(join(folder,'events.jsonl'),fixture().events.map(e=>JSON.stringify(e)).join('\n'));
  const analysis=await analyzeRun(root,input);assert.equal(analysis.coverage[0].traceComplete,true);
  const trace=JSON.parse(readFileSync(await exportRunTrace(root,input),'utf8'));
  assert.ok(trace.traceEvents.some(e=>e.ph==='b'));assert.equal(trace.metadata.timestampUnit,'us');
  const publicParent=join(root,'output','observability-contract');mkdirSync(publicParent,{recursive:true});
  const out=mkdtempSync(join(publicParent,'report-'));await renderReport(input,out);
  const html=readFileSync(join(out,'report.html'),'utf8'),dom=new JSDOM(html,{runScripts:'dangerously'});
  assert.ok(dom.window.document.querySelector('#evidence').textContent.includes('public-derived'));
  assert.ok(!html.includes('f'.repeat(64)));
  assert.equal(JSON.parse(readFileSync(join(out,'report.json'),'utf8')).authority,false);
  dom.window.close();
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
