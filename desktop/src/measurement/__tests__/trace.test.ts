import {it,expect,vi} from 'vitest';
import {Collector,Probe,BufferLedger,type TraceContext} from '../core.js';
import {GpuTimer} from '../../viewer/gpuTimer.js';
import {normalizeTrace} from '../../../scripts/benchmarks/trace-analysis.mjs';
const context:TraceContext={runId:'r',sampleId:null,sourceSha256:null,buildId:null,generation:1,geometryToken:1,requestId:null,
  workerId:'host',family:'host',backend:'host',taskId:null,attemptId:1,parentTaskId:null,sourceId:null,geometryLod:null};
it('captures the start context and propagates immutable child contexts without duplicate aggregation',async()=>{
  let time=10;const collector=new Collector(context,'diagnostic'),probe=new Probe('host','c','diagnostic',()=>time,collector);
  const live={...context},phase=probe.phase(live,'compile');live.generation=2;time=20;phase.end();phase.end();
  const events=collector.drain();expect(events.filter(e=>e.kind==='trace')).toHaveLength(2);
  expect(events.every(e=>e.context.generation===1)).toBe(true);
  expect(phase.context.activeSpanId).toBe(phase.id);expect(Object.isFrozen(phase.context)).toBe(true);
  expect(collector.snapshot().phases['host:compile'].count).toBe(1);
});
it('trace overload is visible and cannot change legacy aggregation completeness',()=>{
  const collector=new Collector(context,'diagnostic'),probe=new Probe('host','c','diagnostic',()=>0,collector);
  for(let i=0;i<8300;i++)probe.trace(context,{type:'message',action:'received',id:String(i)});
  expect(collector.snapshot().traceHealth.dropped).toBeGreaterThan(0);
  expect(collector.snapshot().aggregateComplete).toBe(true);
});
it('uses exactly the same boundary readings for lifecycle and interval on a real advancing clock',()=>{
  let now=100.25;const collector=new Collector(context,'diagnostic'),probe=new Probe('host','c','diagnostic',()=>now+=0.125,collector);
  const phase=probe.phase(context,'compile');phase.end();
  const trace=normalizeTrace(collector.drain());
  expect(trace.spans[0]).toMatchObject({state:'closed',durationMs:0.125,issues:[]});
});
it('validates trace producer ownership and independent high-water cursors before buffering',()=>{
  const collector=new Collector(context,'diagnostic'),records:Parameters<Collector['accept']>[0][]=[];
  const probe=new Probe('host','c','diagnostic',()=>1,{emit:event=>records.push(event)});
  probe.trace(context,{type:'message',action:'sent',id:'one'});
  probe.trace(context,{type:'message',action:'sent',id:'two'});
  probe.trace(context,{type:'message',action:'sent',id:'three'});
  collector.accept(records[0]);collector.accept(records[0]);collector.accept(records[2]);
  collector.accept({...records[1],producerId:'another:trace'});
  collector.accept({...records[1],sequence:0});
  collector.accept({...records[1],context:{...context,runId:'foreign'}});
  expect(collector.drain()).toHaveLength(2);
  expect(collector.snapshot()).toMatchObject({detailComplete:false,aggregateComplete:false,traceComplete:false,
    traceHealth:{duplicate:1,sequenceGaps:1,invalid:2,foreignRun:1}});
});
it('snapshots only a bounded sample of active span IDs, never full events',()=>{
  const collector=new Collector(context,'diagnostic'),probe=new Probe('host','c','diagnostic',()=>1,collector);
  for(let i=0;i<100;i++)probe.phase(context,'stage');
  const health=collector.snapshot().traceHealth;
  expect(health.activeSpanCount).toBe(100);expect(health.activeSpans).toHaveLength(64);
  expect(health.activeSpans.every(id=>typeof id==='string')).toBe(true);
});
it('overlapping GPU passes discard the old query and reject a stale pass end',()=>{
  const end=vi.fn(),deleted=vi.fn(),rows:unknown[]=[];
  const gl={getExtension:()=>({TIME_ELAPSED_EXT:1,GPU_DISJOINT_EXT:2}),createQuery:()=>({}),beginQuery:vi.fn(),endQuery:end,
    getParameter:()=>false,isContextLost:()=>false,QUERY_RESULT_AVAILABLE:3,QUERY_RESULT:4,
    getQueryParameter:(_:unknown,p:number)=>p===3?true:2000000,deleteQuery:deleted};
  const timer=new GpuTimer(gl as unknown as WebGL2RenderingContext,row=>rows.push(row));
  timer.begin('old');timer.begin('new');timer.end('old');
  expect(end).toHaveBeenCalledTimes(1);expect(deleted).toHaveBeenCalledTimes(1);
  timer.end('new');timer.poll();timer.dispose();
  expect(rows).toEqual([{passId:'old',availability:'unavailable',durationMs:null,reason:'pass-overlapped'},
    {passId:'new',availability:'available',durationMs:2}]);
  expect(deleted).toHaveBeenCalledTimes(2);
});
it('GPU timers handle deferred results, disjoint and cleanup without a synchronous finish',()=>{
  let available=false,disjoint=false,deleted=0;
  const gl={getExtension:()=>({TIME_ELAPSED_EXT:1,GPU_DISJOINT_EXT:2}),createQuery:()=>({}),beginQuery(){},endQuery(){},
    getParameter:()=>disjoint,isContextLost:()=>false,QUERY_RESULT_AVAILABLE:3,QUERY_RESULT:4,
    getQueryParameter:(_:unknown,p:number)=>p===3?available:5000000,deleteQuery(){deleted++;}};
  const rows:unknown[]=[];const timer=new GpuTimer(gl as unknown as WebGL2RenderingContext,row=>rows.push(row));
  timer.begin('p1');timer.end();timer.poll();expect(rows).toHaveLength(0);
  available=true;timer.poll();expect(rows[0]).toMatchObject({durationMs:5,availability:'available'});
  timer.begin('p2');timer.end();disjoint=true;timer.poll();expect(rows[1]).toMatchObject({durationMs:null,reason:'disjoint'});
  timer.dispose();expect(deleted).toBe(2);
});

it('GPU results complete while rendering is idle and disposal cancels pending polling',()=>{
  vi.useFakeTimers();
  try{
    let available=false;
    const deleted=vi.fn(),rows:unknown[]=[];
    const gl={getExtension:()=>({TIME_ELAPSED_EXT:1,GPU_DISJOINT_EXT:2}),createQuery:()=>({}),beginQuery(){},endQuery(){},
      getParameter:()=>false,isContextLost:()=>false,QUERY_RESULT_AVAILABLE:3,QUERY_RESULT:4,
      getQueryParameter:(_:unknown,p:number)=>p===3?available:7000000,deleteQuery:deleted};
    const timer=new GpuTimer(gl as unknown as WebGL2RenderingContext,row=>rows.push(row));
    timer.begin('last-frame');timer.end();vi.advanceTimersByTime(100);expect(rows).toHaveLength(0);
    available=true;vi.advanceTimersByTime(100);
    expect(rows).toEqual([{passId:'last-frame',availability:'available',durationMs:7}]);
    expect(vi.getTimerCount()).toBe(0);
    available=false;timer.begin('closing-frame');timer.end();timer.dispose();vi.advanceTimersByTime(1000);
    expect(rows).toHaveLength(2);expect(rows[1]).toMatchObject({reason:'capture-stopped'});
    expect(deleted).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
});

it('re-registering a known backing buffer records reuse without inventing another allocation',()=>{
  const ledger=new BufferLedger(),buffer=new ArrayBuffer(16);
  const id=ledger.retain(buffer,'first');ledger.releaseId(id,'first');ledger.retain(buffer,'again');
  expect(ledger.ledger.snapshot().movements).toMatchObject({allocatedBytes:16,reusedBuffers:1,bufferRequests:2});
  expect(ledger.bytes).toBe(16);
});
