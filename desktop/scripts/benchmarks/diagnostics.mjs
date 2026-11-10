import {writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
export function diagnosticPlan(input,legacy){
  if(!input&&!legacy)return null;
  const plan=input??{captures:[{kind:legacy.kind,target:'worker',family:legacy.family??'dev'}]};
  if(!Array.isArray(plan.captures)||plan.captures.length>8)throw Error('invalid-diagnostic-captures');
  const maxTraceBytes=plan.maxTraceBytes??256*1024*1024;
  if(!Number.isSafeInteger(maxTraceBytes)||maxTraceBytes<1024||maxTraceBytes>256*1024*1024)throw Error('invalid-trace-output-budget');
  const ids=new Set();
  return {...plan,maxTraceBytes,captures:plan.captures.map((capture,index)=>{
    const c={id:'capture-'+index,target:'main',trigger:'operation-start',durationMs:5000,maxBytes:256*1024*1024,...capture};
    if(!/^[a-zA-Z0-9-]{1,64}$/.test(c.id)||!['cpu','allocations','heap'].includes(c.kind)||!['main','worker'].includes(c.target)||
      !['operation-start','external','slow-span'].includes(c.trigger)||!Number.isFinite(c.durationMs)||c.durationMs<1||c.durationMs>30000||
      c.trigger==='external'&&c.delayMs!==undefined&&(!Number.isFinite(c.delayMs)||c.delayMs<0)||
      !Number.isSafeInteger(c.maxBytes)||c.maxBytes<1024||c.maxBytes>256*1024*1024||
      c.trigger==='slow-span'&&(!Number.isFinite(c.thresholdMs)||c.thresholdMs<1))throw Error('invalid-diagnostic-capture');
    if(ids.has(c.id))throw Error('duplicate-capture-id');ids.add(c.id);return c;
  })};
}
/** Independent from the page's event loop. Every stop/exit is bounded. */
export class CaptureController {
  constructor(cdp,out,plan){this.cdp=cdp;this.out=out;this.plan=plan;this.targets=new Map([['main',{executorId:'host',sessionId:undefined}]]);
    this.rows=plan.captures.map(spec=>({spec,status:'not-triggered'}));this.tasks=[];this.closed=false;this.events=[];
    this.activeSpans=new Map();this.endedSpans=new Map();this.producerSequences=new Map();}
  target(identity,sessionId){this.targets.set(identity.workerId,{...identity,executorId:identity.workerId,sessionId});if(this.started)this.startEligible('operation-start');}
  event(event){
    if(this.events.length<32768)this.events.push(event);else this.eventTruncated=true;
    if(event.trace?.type!=='span'||!event.context?.runId||typeof event.trace.id!=='string'||!event.trace.id)return;
    if(event.producerId&&Number.isSafeInteger(event.sequence)){
      const producer=event.context.runId+'\0'+event.producerId,previous=this.producerSequences.get(producer)??0;
      if(event.sequence<=previous)return;
      if(!this.producerSequences.has(producer)&&this.producerSequences.size>=4096){this.activeIndexTruncated=true;return;}
      this.producerSequences.set(producer,event.sequence);
    }
    const key=event.context.runId+'\0'+event.trace.id;
    if(event.trace.action==='ended'){
      this.activeSpans.delete(key);this.endedSpans.set(key,event);
      while(this.endedSpans.size>8192)this.endedSpans.delete(this.endedSpans.keys().next().value);
    }else if(event.trace.action==='started'&&!this.endedSpans.has(key)){
      if(this.activeSpans.size<4096||this.activeSpans.has(key))this.activeSpans.set(key,event);
      else this.activeIndexTruncated=true;
    }
  }
  async start(){this.started=true;this.startEligible('operation-start');this.origin=performance.now();
    this.timer=setInterval(()=>{this.startEligible('slow-span');this.startEligible('external');},100);
    await Promise.all(this.rows.filter(row=>row.status==='collecting').map(row=>row.armed));}
  trigger(id){this.startEligible('external',id);}
  startEligible(trigger,id){
    if(this.closed)return;
    for(const row of this.rows){
      const spec=row.spec;if(row.status!=='not-triggered'||spec.trigger!==trigger||id&&spec.id!==id)continue;
      if(trigger==='external'&&performance.now()-this.origin<(spec.delayMs??0))continue;
      if(trigger==='slow-span'){
        const starts=[...this.activeSpans.values()].filter(e=>(!spec.spanId||e.trace.id===spec.spanId)&&(!spec.stage||e.trace.name===spec.stage)&&
          (spec.target==='main'?(e.context.executorId??e.context.workerId)==='host':
            (e.context.executorId??e.context.workerId)!=='host'&&(!spec.family||e.context.family===spec.family)&&
            (!spec.executorId||(e.context.executorId??e.context.workerId)===spec.executorId)));
        const active=starts.find(e=>performance.now()-e.controllerReceivedMs>=spec.thresholdMs);
        if(!active)continue;
        row.triggerContext=active.context;row.targetSpanId=active.trace.id;
        row.triggerEventRef={runId:active.context.runId,producerId:active.producerId,sequence:active.sequence};
      }
      const target=[...this.targets.values()].find(t=>spec.target==='main'?t.executorId==='host':
        t.executorId!=='host'&&(!spec.executorId||t.executorId===spec.executorId)&&(!spec.family||t.family===spec.family)&&
        (!row.triggerContext||t.executorId===(row.triggerContext.executorId??row.triggerContext.workerId)));
      if(!target)continue;
      if(row.triggerContext&&(row.triggerContext.executorId??row.triggerContext.workerId)!==target.executorId)continue;
      if(spec.operationTraceId||spec.taskId||spec.spanId){
        const matching=[...this.activeSpans.values()].filter(e=>(e.context.executorId??e.context.workerId)===target.executorId&&
          (!spec.operationTraceId||e.context.operationTraceId===spec.operationTraceId)&&
          (!spec.taskId||e.context.taskId===spec.taskId)&&(!spec.spanId||e.trace?.id===spec.spanId));
        if(!matching.length){
          if(spec.spanId&&[...this.endedSpans.values()].some(e=>e.trace.id===spec.spanId&&
            (e.context.executorId??e.context.workerId)===target.executorId))row.status='target-ended';
          continue;
        }
      }
      if(this.rows.some(r=>r.status==='collecting'&&r.executorId===target.executorId))continue;
      row.status='collecting';row.executorId=target.executorId;row.requestedAtMs=performance.now();row.triggerSource=trigger;
      row.armed=new Promise(resolve=>{row.arm=resolve;});
      const task=this.capture(row,target).catch(()=>{row.status='unavailable';row.reason='target-ended-or-capture-failed';}).finally(()=>{row.arm?.();row.endedAtMs??=performance.now();row.closedAtMs=performance.now();});
      this.tasks.push(task);
    }
  }
  async capture(row,target){
    const {spec}=row,session=target.sessionId,domain=spec.kind==='cpu'?'Profiler':'HeapProfiler';
    const file=join(this.out,spec.id+'.private.'+(spec.kind==='cpu'?'cpuprofile':spec.kind==='heap'?'heapsnapshot':'heapprofile'));
    row.samplingParameters=spec.kind==='cpu'?{intervalUs:1000}:spec.kind==='allocations'?{averageSampleIntervalBytes:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true}:{kind:'snapshot'};
    row.clockId='controller';row.targetSpanId=spec.spanId??row.targetSpanId??null;row.privateArtifact=file;
    let unsubscribe=()=>{},bytes=0;
    try{
      await this.cdp.send(domain+'.enable',{},session);
      if(spec.kind==='heap'){
        unsubscribe=this.cdp.onEvent(e=>{if(e.sessionId===session&&e.method==='HeapProfiler.addHeapSnapshotChunk'){
          const chunk=e.params.chunk,amount=Buffer.byteLength(chunk);bytes+=amount;if(bytes<=spec.maxBytes)appendFileSync(file,chunk);else row.truncated=true;
        }});
        row.startedAtMs=performance.now();
        row.arm?.();
        await this.cdp.send('HeapProfiler.takeHeapSnapshot',{reportProgress:false},session,spec.durationMs);
      }else{
        if(spec.kind==='cpu')await this.cdp.send('Profiler.setSamplingInterval',{interval:1000},session);
        row.startRequestMs=performance.now();
        await this.cdp.send(domain+'.'+(spec.kind==='cpu'?'start':'startSampling'),spec.kind==='cpu'?{}:{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true},session);
        row.startedAtMs=performance.now();
        row.arm?.();
        await new Promise(resolve=>{row.release=resolve;row.timeout=setTimeout(resolve,spec.durationMs);});
        row.stopRequestMs=performance.now();
        const result=await this.cdp.send(domain+'.'+(spec.kind==='cpu'?'stop':'stopSampling'),{},session,5000);
        row.endedAtMs=performance.now();
        const raw=JSON.stringify(result.profile);bytes=Buffer.byteLength(raw);
        if(bytes<=spec.maxBytes)writeFileSync(file,raw);else row.truncated=true;
        if(spec.kind==='cpu'){
          row.profileWindow={clockId:'cdp-profile',unit:'us',start:result.profile.startTime,end:result.profile.endTime};
          const lower=Math.max(row.startRequestMs-result.profile.startTime/1000,row.stopRequestMs-result.profile.endTime/1000);
          const upper=Math.min(row.startedAtMs-result.profile.startTime/1000,row.endedAtMs-result.profile.endTime/1000);
          row.commandBracketCandidate=Number.isFinite(lower)&&upper>=lower
            ?{availability:'available',clockId:'cdp-profile',referenceClockId:'controller',offsetMs:(lower+upper)/2,uncertaintyMs:(upper-lower)/2,
              method:'unverified-start-stop-command-brackets',validFrom:result.profile.startTime,validTo:result.profile.endTime,sourceUnit:'us'}
            :{availability:'unavailable',reason:'profile-command-clock-brackets-inconsistent'};
          // A bracket intersection is a candidate offset, not proof of the
          // browser's profiler clock contract. Hotspot analysis needs only the
          // native profile window; do not publish an unverified cross-domain map.
          row.clockMapping={availability:'unavailable',reason:'profile-clock-domain-unverified',clockId:'cdp-profile',sourceUnit:'us'};
        }
      }
      row.bytes=bytes;row.status=row.truncated?'truncated':'available';
    }finally{clearTimeout(row.timeout);unsubscribe();await this.cdp.send(domain+'.disable',{},session,2000).catch(()=>{});}
  }
  async stop(){
    this.closed=true;clearInterval(this.timer);for(const row of this.rows)row.release?.();
    await Promise.allSettled(this.tasks);
    return this.rows.map(({release,timeout,arm,armed,spec,...row})=>({...row,
      ...(row.status==='not-triggered'&&spec.trigger==='slow-span'&&this.activeIndexTruncated?{status:'unavailable',reason:'slow-span-index-overflow'}:{}),
      requested:spec,triggerEvidenceComplete:!this.activeIndexTruncated,
      observedContexts:[...new Map(this.events.filter(e=>(e.context.executorId??e.context.workerId)===row.executorId&&
        e.controllerReceivedMs>=row.startedAtMs&&e.controllerReceivedMs<=row.endedAtMs)
        .map(e=>[JSON.stringify(e.context),e.context])).values()],
      association:'observed-event-window; shared isolate may include other operations',associationTruncated:!!this.eventTruncated}));
  }
}
