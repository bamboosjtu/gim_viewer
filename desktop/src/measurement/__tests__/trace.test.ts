import {it,expect} from 'vitest';
import {Collector,Probe,BufferLedger,type TraceContext} from '../core.js';
import {GpuTimer} from '../../viewer/gpuTimer.js';
import {normalizeTrace} from '../../../scripts/benchmarks/trace-analysis.mjs';
const context:TraceContext={runId:'r',sampleId:null,sourceSha256:null,buildId:null,generation:1,geometryToken:1,requestId:null,
  workerId:'host',family:'host',backend:'host',taskId:null,attemptId:1,parentTaskId:null,sourceId:null,geometryLod:null};
it('captures the start context and propagates immutable child contexts without duplicate aggregation',async()=>{
  let time=10;const collector=new Collector(context,'diagnostic'),probe=new Probe('host','c','diagnostic',()=>time,collector);
  const phase=probe.phase(context,'compile');context.generation=2;time=20;phase.end();phase.end();
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
  let now=100.25;const collector=new Collector(context,'diagnostic'),probe=new Probe('clock-reader','c','diagnostic',()=>now+=0.125,collector);
  const phase=probe.phase(context,'compile');phase.end();
  const trace=normalizeTrace(collector.drain());
  expect(trace.spans[0]).toMatchObject({state:'closed',durationMs:0.125,issues:[]});
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

it('re-registering a known backing buffer records reuse without inventing another allocation',()=>{
  const ledger=new BufferLedger(),buffer=new ArrayBuffer(16);
  const id=ledger.retain(buffer,'first');ledger.releaseId(id,'first');ledger.retain(buffer,'again');
  expect(ledger.ledger.snapshot().movements).toMatchObject({allocatedBytes:16,reusedBuffers:1,bufferRequests:2});
  expect(ledger.bytes).toBe(16);
});
