import{it,expect,vi}from'vitest';
import{createWorkerProbe}from'../workerProbe.js';
import{Collector,type TraceContext,type MeasurementEvent}from'../core.js';
const base:TraceContext={runId:'run-a',workerId:'worker-a',executorId:'worker-a',family:'dev',backend:'web-worker',sampleId:null,sourceSha256:null,buildId:null,generation:1,geometryToken:1,requestId:null,taskId:null,attemptId:1,parentTaskId:null,sourceId:null,geometryLod:null};
it('acknowledges a drain only after flushing the task scope tail',async()=>{
  const messages:any[]=[];vi.stubGlobal('self',{addEventListener(){},postMessage:(message:unknown)=>messages.push(message)});
  try{
    const worker=createWorkerProbe();worker.control({data:{__gimMeasurement:'init',context:base,mode:'diagnostic'}}as MessageEvent);
    await worker.run({data:{_gimMeasurement:{context:{...base,taskId:'checkpoint'},command:'checkpoint-evidence'}}}as MessageEvent,task=>{task.produced();task.sentResult();});
    worker.control({data:{__gimMeasurement:'barrier',workerId:base.workerId,token:7}}as MessageEvent);
    const barrier=messages[messages.length-1],flush=messages[messages.length-2];
    expect(barrier).toMatchObject({__gimMeasurement:'barrier',token:7,batchId:flush.batchId,lastSequence:flush.lastSequence});
    expect(flush.__gimMeasurement).toBe('flushed');
    expect(messages.flatMap(m=>m.events??[]).some(e=>e.trace?.type==='scope'&&e.trace.action==='closed')).toBe(true);
  }finally{vi.unstubAllGlobals();}
});
it('keeps diagnostic traces when a worker is reused for a new run without another init',async()=>{
  const records:MeasurementEvent[]=[];vi.stubGlobal('self',{addEventListener(){},postMessage:(message:{events?:MeasurementEvent[]})=>records.push(...message.events??[])});
  try{
    const worker=createWorkerProbe();worker.control({data:{__gimMeasurement:'init',context:base,mode:'benchmark'}}as MessageEvent);
    const context={...base,runId:'run-b',taskId:'b'};
    await worker.run({data:{_gimMeasurement:{context,command:'compile',mode:'diagnostic'}}}as MessageEvent,async()=>{});
    expect(records.some(e=>e.kind==='loss')).toBe(false);
    expect(records.filter(e=>e.kind==='trace').length).toBeGreaterThan(0);
    const collector=new Collector(context,'diagnostic');records.forEach(e=>collector.accept(e));
    expect(collector.snapshot()).toMatchObject({aggregateComplete:true,traceComplete:true,taskOutcomes:{completed:1}});
  }finally{vi.unstubAllGlobals();}
});
it('reinitializing the same run creates independent producer cursors without collector duplicates',async()=>{
  const records:MeasurementEvent[]=[];vi.stubGlobal('self',{addEventListener(){},postMessage:(message:{events?:MeasurementEvent[]})=>records.push(...message.events??[])});
  try{
    const worker=createWorkerProbe(),init=()=>worker.control({data:{__gimMeasurement:'init',context:base,mode:'benchmark'}}as MessageEvent);
    init();await worker.run({data:{_gimMeasurement:{context:{...base,taskId:'a'},command:'compile'}}}as MessageEvent,async()=>{});
    const first=records[0].producerId;init();await worker.run({data:{_gimMeasurement:{context:{...base,taskId:'b'},command:'compile'}}}as MessageEvent,async()=>{});
    const collector=new Collector({runId:base.runId,sampleId:null,sourceSha256:null,buildId:null,generation:1,geometryToken:1,requestId:null},'benchmark');records.forEach(e=>collector.emit(e));
    expect(new Set(records.map(e=>e.producerId)).size).toBe(2);expect(records.some(e=>e.producerId!==first)).toBe(true);
    expect(collector.snapshot().loss.duplicate).toBe(0);expect(collector.snapshot().phases['dev:worker.execution'].count).toBe(2);
  }finally{vi.unstubAllGlobals();}
});
it('expired run initialization keeps late tasks in their old run with explicit retention loss',async()=>{
  const records:MeasurementEvent[]=[];vi.stubGlobal('self',{addEventListener(){},postMessage:(message:{events?:MeasurementEvent[]})=>records.push(...message.events??[])});
  try{
    const worker=createWorkerProbe();
    for(let i=0;i<17;i++)worker.control({data:{__gimMeasurement:'init',context:{...base,runId:'run-'+i},mode:'benchmark'}}as MessageEvent);
    await worker.run({data:{_gimMeasurement:{context:{...base,runId:'run-0',taskId:'late'},command:'compile'}}}as MessageEvent,async()=>{});
    expect(records.every(e=>e.context.runId==='run-0')).toBe(true);
    expect(records.some(e=>e.kind==='loss'&&e.name==='worker-probe-retention-expired')).toBe(true);
    expect(()=>worker.control({data:{__gimMeasurement:'init',context:{...base,workerId:'different-worker'},mode:'benchmark'}}as MessageEvent)).toThrow('worker-execution-identity-changed');
  }finally{vi.unstubAllGlobals();}
});
