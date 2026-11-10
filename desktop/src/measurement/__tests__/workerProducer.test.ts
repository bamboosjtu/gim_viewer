import{it,expect,vi}from'vitest';
import{createWorkerProbe}from'../workerProbe.js';
import{Collector,type TraceContext,type MeasurementEvent}from'../core.js';
const base:TraceContext={runId:'run-a',workerId:'worker-a',executorId:'worker-a',family:'dev',backend:'web-worker',sampleId:null,sourceSha256:null,buildId:null,generation:1,geometryToken:1,requestId:null,taskId:null,attemptId:1,parentTaskId:null,sourceId:null,geometryLod:null};
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
