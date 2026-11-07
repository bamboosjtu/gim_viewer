import { describe, it, expect } from 'vitest';
import { Collector, Probe, MemoryLedger, BufferLedger, uniqueBufferCapacity, calibrateClock, DurationStats, type TraceContext } from '../core.js';
const context:TraceContext={runId:'run-1',sampleId:'sample-1',sourceSha256:null,buildId:'build-1',generation:1,geometryToken:2,requestId:'request-1',workerId:'worker-1',family:'dev',backend:'web-worker',taskId:'task-1',attemptId:1,parentTaskId:null,sourceId:null,geometryLod:0};
function setup(limit=100){let now=0;const collector=new Collector({...context},'benchmark',limit),probe=new Probe('worker-1','clock-1','benchmark',()=>now,collector);return {collector,probe,tick:(value:number)=>{now=value;}};}
describe('measurement contracts (no engineering samples)',()=>{
  it('streams bounded batches, waits for credit and retains aggregate truth when the consumer stalls',()=>{
    const {collector,probe}=setup(256);let credit=1;const batches:unknown[][]=[];
    collector.setDetailSink({available:()=>credit>0,send:events=>{credit--;batches.push(events);}});
    for(let i=0;i<500;i++)probe.record(context,'parse',1);
    expect(batches[0]).toHaveLength(128);expect(collector.snapshot().phases['dev:parse'].count).toBe(500);
    expect(collector.snapshot().loss.detailEvents).toBe(116);
    credit=2;collector.flushDetails();expect(batches).toHaveLength(3);expect(collector.snapshot().bufferedEvents).toBe(0);
  });
  it('ends a phase once on its own clock and preserves failed/cancelled outcomes',async()=>{
    const {collector,probe,tick}=setup();const phase=probe.phase(context,'compile');tick(25);phase.end('failed');phase.end();
    await expect(probe.measure(context,'read',async()=>{tick(30);throw Object.assign(Error('cancel'),{name:'AbortError'});})).rejects.toThrow('cancel');
    const report=collector.snapshot();expect(report.phases['dev:compile']).toMatchObject({count:1,totalMs:25,failed:1});expect(report.phases['dev:read']).toMatchObject({cancelled:1,totalMs:5});
  });
  it('settles queued and running attempts on termination; late completion cannot settle twice',()=>{
    const {collector,probe}=setup();probe.event(context,{kind:'worker',name:'created'});probe.event(context,{kind:'task',name:'queued'});probe.event(context,{kind:'task',name:'started'});
    probe.event({...context,taskId:'queued-only'},{kind:'task',name:'queued'});
    probe.event(context,{kind:'worker',name:'terminated',status:'timeout'});probe.event(context,{kind:'task',name:'ended',status:'completed'});
    expect(collector.snapshot()).toMatchObject({activeTasks:[],taskOutcomes:{timeout:2},loss:{interruptedTasks:2,lateEvents:1}});
    probe.event({...context,workerId:'worker-2',attemptId:2},{kind:'task',name:'started'});probe.event({...context,workerId:'worker-2',attemptId:2},{kind:'task',name:'ended',status:'completed'});
    expect(collector.snapshot().taskOutcomes).toEqual({timeout:2,completed:1});
  });
  it('records bounded detail loss without dropping aggregate counts and rejects foreign runs',()=>{
    const {collector,probe}=setup(2);for(let i=0;i<10;i++)probe.record(context,'parse',i);
    probe.record({...context,runId:'other'},'parse',99);
    expect(collector.snapshot()).toMatchObject({detailComplete:false,loss:{detailEvents:8,foreignRun:1},phases:{'dev:parse':{count:10,totalMs:45}}});expect(collector.drain()).toHaveLength(2);
  });
  it('detects transport sequence gaps and never invents missing heap samples',()=>{
    const collector=new Collector({...context},'diagnostic'),probe=new Probe('worker-1','clock-1','diagnostic',()=>0,collector);
    probe.memory(context,{name:'heap',scope:'isolate',method:'cdp',quality:'runtime-sampled',availability:'unavailable',bytes:null,reason:'target-busy',sampleDelayMs:1000});
    const event=collector.drain()[0];collector.accept({...event,sequence:3});
    expect(collector.snapshot().loss.sequenceGaps).toBe(1);expect(Object.values(collector.snapshot().memory)[0]).toMatchObject({observedPeakBytes:null,latest:{bytes:null,reason:'target-busy'}});
  });
  it('keeps exact memory and counter aggregates without flooding benchmark detail',()=>{
    const {collector,probe}=setup(128);
    for(let i=0;i<20000;i++){
      probe.event(context,{kind:'counter',name:'resource.acquire',workload:{buffers:1}});
      probe.memory(context,{name:'tracked-host-buffer-capacity',scope:'host',method:'ledger',quality:'measured-capacity',availability:'available',bytes:i,sampleDelayMs:0});
    }
    probe.record(context,'host.commit',2);
    const snapshot=collector.snapshot();
    expect(snapshot.loss.detailEvents).toBe(0);
    expect(snapshot.detailComplete).toBe(true);
    expect(snapshot.aggregatedDetail).toEqual({memory:20000,counter:20000});
    expect(snapshot.counters['dev:resource.acquire'].buffers).toBe(20000);
    expect(Object.values(snapshot.memory)[0].observedPeakBytes).toBe(19999);
    expect(collector.drain()).toHaveLength(1);
  });
  it('deduplicates shared views and conserves unique ownership across transfer/copy/eviction',()=>{
    const buffer=new ArrayBuffer(64);expect(uniqueBufferCapacity([new Uint8Array(buffer),new Float32Array(buffer),buffer])).toBe(64);
    const tracked=new BufferLedger();tracked.retain(buffer,'cache');tracked.retain(new Uint8Array(buffer),'cache');tracked.release(buffer,'cache');expect(tracked.bytes).toBe(64);tracked.transfer(buffer,'cache','host');tracked.release(buffer,'host');expect(tracked.bytes).toBe(0);
    const ledger=new MemoryLedger();ledger.acquire('a','worker',64,'buffer-capacity');ledger.acquire('a','cache',64,'buffer-capacity');ledger.transfer('a','worker','worker');ledger.transfer('a','worker','in-flight');ledger.copy('a','b','host');
    expect(ledger.snapshot().uniqueBytesByKind['buffer-capacity']).toBe(128);ledger.releaseOwner('in-flight');ledger.releaseOwner('cache');expect(ledger.snapshot().uniqueBytesByKind['buffer-capacity']).toBe(64);ledger.releaseOwner('host');ledger.releaseOwner('host');expect(ledger.snapshot().uniqueAllocations).toBe(0);
  });
  it('calibrates offset with uncertainty; does not subtract unaligned clocks for phases',()=>{
    expect(calibrateClock(10,112,114,16)).toEqual({offsetMs:-100,uncertaintyMs:2});expect(()=>calibrateClock(10,112,110,16)).toThrow();
    const stats=new DurationStats();for(let i=1;i<=100;i++)stats.add(i);const result=stats.snapshot();expect(result.count).toBe(100);expect(result.p95!.lowerMs).toBeLessThanOrEqual(95);expect(result.p95!.upperMs).toBeGreaterThanOrEqual(95);
  });
  it('off mode never reads the clock or sends an event',()=>{
    const fail=()=>{throw Error('off probe performed work');};const probe=new Probe('off','off','off',fail,{emit:fail});probe.phase(context,'parse').end();probe.record(context,'parse',1);expect(probe.measureSync(context,'parse',()=>42)).toBe(42);
  });
});
