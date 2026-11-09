import { describe, it, expect } from 'vitest';
import { Collector, Probe, MemoryLedger, BufferLedger, uniqueBufferCapacity, calibrateClock, DurationStats, MEASUREMENT_VERSION, type MeasurementEvent, type TraceContext } from '../core.js';
import {benchmarkRun} from '../../../scripts/benchmarks/test-fixtures.mjs';
const context:TraceContext={runId:'run-1',sampleId:'sample-1',sourceSha256:null,buildId:'build-1',generation:1,geometryToken:2,requestId:'request-1',workerId:'worker-1',family:'dev',backend:'web-worker',taskId:'task-1',attemptId:1,parentTaskId:null,sourceId:null,geometryLod:0};
function setup(limit=100){let now=0;const collector=new Collector({...context},'benchmark',limit),probe=new Probe('worker-1','clock-1','benchmark',()=>now,collector);return {collector,probe,tick:(value:number)=>{now=value;}};}
describe('measurement contracts (no engineering samples)',()=>{
  it('uses the same V1 protocol in the Collector and Benchmark fixture, and rejects unknown events',()=>{
    const {collector,probe}=setup();probe.record(context,'parse',1);
    expect(MEASUREMENT_VERSION).toBe('gim-measurement-v1');
    expect(benchmarkRun('fixture').conditions.measurementVersion).toBe(collector.snapshot().version);
    expect(benchmarkRun('fixture').measurement.version).toBe(collector.snapshot().version);
    collector.accept({version:'unknown-measurement-version',context,producerId:'unknown',sequence:1,clockId:'clock',
      atMs:1,kind:'phase',name:'unknown',durationMs:1} as unknown as MeasurementEvent);
    expect(collector.snapshot()).toMatchObject({loss:{invalid:1},aggregateComplete:false});
  });
  it('streams bounded batches, waits for credit and retains aggregate truth when the consumer stalls',()=>{
    const {collector,probe}=setup(256);let credit=1;const batches:unknown[][]=[];
    collector.setDetailSink({available:()=>credit>0,send:events=>{credit--;batches.push(events);}});
    for(let i=0;i<500;i++)probe.record(context,'parse',1);
    expect(batches[0]).toHaveLength(128);expect(collector.snapshot().phases['dev:parse'].count).toBe(500);
    expect(collector.snapshot().loss.detailEvents).toBe(116);
    expect(collector.snapshot()).toMatchObject({detailComplete:false,aggregateComplete:true});
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
    expect(collector.snapshot()).toMatchObject({activeTasks:[],taskOutcomes:{timeout:2},
      lifecycleComplete:false,loss:{interruptedTasks:2,lateEvents:1,lateEventsUnexpected:1}});
    probe.event({...context,workerId:'worker-2',attemptId:2},{kind:'task',name:'started'});probe.event({...context,workerId:'worker-2',attemptId:2},{kind:'task',name:'ended',status:'completed'});
    expect(collector.snapshot().taskOutcomes).toEqual({timeout:2,completed:1});
  });
  it('records queued work that never started without inventing an interrupted execution',()=>{
    const {collector,probe}=setup();probe.event(context,{kind:'worker',name:'created'});
    probe.event(context,{kind:'task',name:'queued'});
    probe.event(context,{kind:'worker',name:'terminated',status:'aborted'});
    expect(collector.snapshot()).toMatchObject({activeTasks:[],lifecycleComplete:true,
      taskOutcomes:{cancelled:1},loss:{cancelledBeforeStart:1,interruptedTasks:0}});
  });
  it('accepts an explicit business cancellation but rejects unexplained or late task endings',()=>{
    const {collector,probe}=setup();probe.event(context,{kind:'task',name:'started'});
    probe.event(context,{kind:'task',name:'ended',status:'cancelled',reasonCode:'request-superseded'});
    probe.event(context,{kind:'task',name:'ended',status:'cancelled',reasonCode:'request-superseded'});
    expect(collector.snapshot()).toMatchObject({lifecycleComplete:true,taskOutcomes:{cancelled:1},
      loss:{lateCancelledAcks:1,lateEventsUnexpected:0}});
    const next={...context,taskId:'unexplained'};probe.event(next,{kind:'task',name:'started'});
    probe.event(next,{kind:'task',name:'ended',status:'cancelled'});
    expect(collector.snapshot()).toMatchObject({lifecycleComplete:false,loss:{cancelledWithoutReason:1}});
  });
  it('settles a requested project replacement as intentional cancellation while retaining the reason',()=>{
    const {collector,probe}=setup();probe.event(context,{kind:'task',name:'started'});
    const host=new Probe(`${context.runId}:host`,'host-clock','benchmark',()=>0,collector);
    host.event({...context,workerId:'host',family:'host',backend:'host'},{kind:'counter',name:'lifecycle.cancel-requested',
      reasonCode:'project-replaced',workload:{requests:1}});
    probe.event(context,{kind:'worker',name:'terminated',status:'aborted'});
    expect(collector.snapshot()).toMatchObject({activeTasks:[],lifecycleComplete:true,
      lifecycleCancellationReasons:{'project-replaced':1},taskOutcomes:{cancelled:1},
      loss:{interruptedTasks:0,intentionalInterruptedTasks:1}});
    const unrelated={...context,workerId:'new-worker',taskId:'new-task'};
    probe.event(unrelated,{kind:'task',name:'started'});
    probe.event(unrelated,{kind:'worker',name:'terminated',status:'aborted'});
    expect(collector.snapshot()).toMatchObject({lifecycleComplete:false,loss:{interruptedTasks:1}});
  });
  it('allows only the explicitly cancelled task when a worker stops',()=>{
    const {collector,probe}=setup();
    probe.event(context,{kind:'task',name:'started'});
    const host=new Probe(`${context.runId}:host`,'host-clock','benchmark',()=>0,collector);
    host.event(context,{kind:'counter',name:'lifecycle.cancel-requested',reasonCode:'request-superseded',workload:{requests:1}});
    probe.event(context,{kind:'worker',name:'terminated',status:'aborted'});
    expect(collector.snapshot()).toMatchObject({lifecycleComplete:true,taskOutcomes:{cancelled:1},
      lifecycleCancellationReasons:{'request-superseded':1}});
    const unrelated={...context,workerId:'worker-2',taskId:'other'};
    probe.event(unrelated,{kind:'task',name:'started'});
    probe.event(unrelated,{kind:'worker',name:'terminated',status:'aborted'});
    expect(collector.snapshot().lifecycleComplete).toBe(false);
  });
  it('rejects foreign-run and duplicate events as transport-incomplete',()=>{
    const {collector,probe}=setup();probe.record(context,'parse',1);
    const first=collector.drain()[0];collector.accept(first);
    probe.record({...context,runId:'foreign'},'parse',1);
    expect(collector.snapshot()).toMatchObject({detailComplete:false,loss:{duplicate:1,foreignRun:1}});
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
  it('keeps a bounded slow phase list even after detail capacity is reached',()=>{
    const {collector,probe,tick}=setup(2);
    for(let ms=1;ms<=20;ms++){
      tick(0);const phase=probe.phase(context,'dev.compile');tick(ms);phase.end();
    }
    probe.record(context,'aggregate-only',999);
    tick(0);probe.event(context,{kind:'task',name:'started'});tick(33);
    probe.event(context,{kind:'task',name:'ended',status:'completed'});
    expect(collector.snapshot().slowestPhases).toHaveLength(10);
    expect(collector.snapshot().slowestPhases[0].durationMs).toBe(20);
    expect(collector.snapshot().slowestPhases.some(row=>row.stage==='aggregate-only')).toBe(false);
    expect(collector.snapshot().slowestTasks[0].durationMs).toBe(33);
    expect(collector.snapshot()).toMatchObject({detailComplete:false,aggregateComplete:true});
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
