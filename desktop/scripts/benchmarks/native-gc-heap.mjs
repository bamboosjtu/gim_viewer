import {randomBytes} from 'node:crypto';
import {heapObservationCoverage} from './heap-observation-coverage.mjs';

/** Natural V8 GC boundary counters; never triggers GC, pauses the debugger or
 * guesses a Worker from its name/position. A nonce mark in the exact CDP
 * target binds its isolate to the native (process,thread) trace track. */
export class NativeGcHeapTrace {
  constructor(browser,page,workers,{now=()=>performance.now(),maxEvents=200000}={}){
    this.browser=browser;this.page=page;this.workers=workers;this.now=now;this.maxEvents=maxEvents;
    this.prefix='gim-heap-'+randomBytes(12).toString('hex')+'-';this.events=[];this.targets=new Map();this.clocks=[];
  }
  async start(){
    this.done=new Promise(resolve=>{this.finished=resolve;});
    this.off=this.browser.onEvent(event=>{
      if(event.method==='Tracing.dataCollected')for(const row of event.params.value){
        if(!(row.name?.startsWith(this.prefix)||['MajorGC','MinorGC'].includes(row.name)))continue;
        if(this.events.length>=this.maxEvents){this.limitHit=true;continue;}this.events.push(row);
      }
      if(event.method==='Tracing.bufferUsage'&&event.params.percentFull>=1)this.bufferFull=true;
      if(event.method==='Tracing.tracingComplete'){this.loss=event.params.dataLossOccurred!==false;this.closedTrace=true;this.finished();}
    });
    // Explicit exclusions are required: includedCategories alone also keeps
    // Chromium's default enabled categories (GPU/compositor/task traffic).
    await this.browser.send('Tracing.start',{traceConfig:{recordMode:'recordAsMuchAsPossible',includedCategories:['v8','blink.user_timing'],excludedCategories:['*'],traceBufferSizeInKb:65536},bufferUsageReportingInterval:1000});
    await this.clock();this.clockTimer=setInterval(()=>{if(!this.clockPending)this.clockPending=this.clock().catch(()=>{}).finally(()=>{this.clockPending=null;});},30000);
  }
  async clock(){
    const name=this.prefix+'clock-'+this.clocks.length,row={name,before:this.now()};this.clocks.push(row);
    try{await this.page.evaluate(`performance.mark(${JSON.stringify(name)});performance.clearMarks(${JSON.stringify(name)});undefined`);row.after=this.now();}
    catch(error){row.error=error.code??'clock-marker-failed';}
  }
  associate(identity,sessionId,target){
    let row=this.targets.get(target.targetId);
    if(row){if(row.isolateId!==target.isolateId)row.conflict=true;row.identity=identity;return;}
    if(this.stopping||target.ended||identity.family==='external')return;
    row={identity,sessionId,targetId:target.targetId,isolateId:target.isolateId,createdMs:target.created,name:this.prefix+'target-'+target.targetId};this.targets.set(row.targetId,row);
    void this.workers.evaluate(`performance.mark(${JSON.stringify(row.name)});performance.clearMarks(${JSON.stringify(row.name)});undefined`,sessionId,5000)
      .catch(error=>{row.markerRequestError=error.code??'target-marker-failed';});
  }
  ended(workerId,atMs){for(const row of this.targets.values())if(row.identity.workerId===workerId)row.endedMs=atMs;}
  async stop(){
    this.stopping=true;clearInterval(this.clockTimer);await this.clockPending;
    try{await this.clock();await this.browser.send('Tracing.end');
      let timer;try{await Promise.race([this.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('native-gc-trace-stop-timeout')),30000);})]);}finally{clearTimeout(timer);}
    }catch(error){this.error=error.code??String(error?.message??error);}
    finally{this.off?.();}
    return this.proof();
  }
  proof(){return {version:'native-v8-gc-heap-v1',complete:this.closedTrace===true&&!this.loss&&!this.limitHit&&!this.bufferFull&&!this.error,
    error:this.error??null,dataLossOccurred:this.loss??null,limitHit:this.limitHit??false,bufferFull:this.bufferFull??false,
    clocks:this.clocks,targets:[...this.targets.values()],events:this.events};}
  coverage(series,endedMs){
    const proof=this.proof(),byName=new Map(this.events.filter(e=>e.name?.startsWith(this.prefix)).map(e=>[e.name,e]));
    const anchors=this.clocks.flatMap(row=>{const event=byName.get(row.name);return event&&Number.isFinite(row.after)&&row.after>=row.before&&row.after-row.before<=20
      ?[{native:event.ts/1000,controller:(row.before+row.after)/2,uncertainty:(row.after-row.before)/2}]:[];}).sort((a,b)=>a.native-b.native);
    const first=anchors[0],last=anchors[anchors.length-1],validClock=anchors.length>=2&&last.native>first.native&&
      anchors.slice(1).every((a,i)=>{const b=anchors[i],slope=(a.controller-b.controller)/(a.native-b.native);return slope>0.999&&slope<1.001;});
    const uncertaintyMs=validClock?Math.max(...anchors.map(a=>a.uncertainty))+0.01:null;
    const convert=ts=>{const time=ts/1000;if(!validClock||time<first.native||time>last.native)return null;
      let i=1;while(i<anchors.length-1&&anchors[i].native<time)i++;const a=anchors[i-1],b=anchors[i];return a.controller+(time-a.native)*(b.controller-a.controller)/(b.native-a.native);};
    const mappings=[...this.targets.values()].map(row=>({...row,mark:byName.get(row.name),end:row.endedMs??endedMs}));
    const coverage=new Map(),observations=new Map();
    for(const row of mappings){
      const id=row.identity.workerId,runtime=series.get(id)??[],gc=[],pauses=[];
      const ambiguous=row.mark&&mappings.some(other=>other!==row&&other.mark&&other.mark.pid===row.mark.pid&&other.mark.tid===row.mark.tid&&other.createdMs<row.end&&other.end>row.createdMs);
      if(proof.complete&&validClock&&row.mark&&!row.conflict&&!ambiguous&&row.isolateId){
        for(let index=0;index<this.events.length;index++){
          const event=this.events[index];if(event.pid!==row.mark.pid||event.tid!==row.mark.tid||event.ph!=='X'||!['MajorGC','MinorGC'].includes(event.name))continue;
          const before=event.args?.usedHeapSizeBefore,after=event.args?.usedHeapSizeAfter,start=convert(event.ts),end=convert(event.ts+event.dur);
          if(!Number.isFinite(before)||before<0||!Number.isFinite(after)||after<0||start===null||end===null||start<row.createdMs||end>row.end||end<=start)continue;
          gc.push({atMs:start,bytes:before,method:'V8.'+event.name+'.before',eventIndex:index},{atMs:end,bytes:after,method:'V8.'+event.name+'.after',eventIndex:index});
          pauses.push({verified:true,startMs:start,endMs:end,beforeBytes:before,afterBytes:after,eventIndex:index});
        }
      }
      const result=heapObservationCoverage({samples:[...runtime,...gc],pauses,createdMs:row.createdMs,endedMs:row.end,uncertaintyMs:uncertaintyMs??0});
      const complete=proof.complete&&validClock&&result.complete;
      coverage.set(id,{...result,complete,reason:complete?null:!proof.complete?'native-gc-trace-incomplete':!validClock?'native-gc-clock-unverified':result.reason,
        method:'CDP.Runtime.getHeapUsage+native-V8-GC',gcSamples:gc.length,clockVerified:validClock,mappingVerified:!!row.mark&&!row.conflict&&!ambiguous});
      observations.set(id,gc.map(sample=>({...sample,workerId:id,family:row.identity.family,isolateId:row.isolateId,targetId:row.targetId,scope:'isolate',quality:'runtime-gc-observed',availability:'available'})));
    }
    return {coverage,observations,summary:{version:'native-v8-gc-heap-v1',complete:proof.complete&&validClock,traceComplete:proof.complete,clockVerified:validClock,uncertaintyMs,anchors}};
  }
}
