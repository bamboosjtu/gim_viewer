import {afterEach,expect,it,vi} from 'vitest';
import {createMeasuredWorker,markMeasuredWorkerTaskCancellation} from '../hostWorker.js';
import {resetMeasurementRun,measurementSnapshot} from '../runtime.js';
import {MEASUREMENT_VERSION} from '../core.js';
class Port extends EventTarget {
  messages:unknown[]=[];transfers:unknown[]=[];stops=0;fail=false;
  postMessage(data:unknown,transfer?:unknown){if(this.fail)throw Error('clone-failed');this.messages.push(data);this.transfers.push(transfer);}
  terminate(){this.stops++;}
}
function start(){(globalThis as any).__GIM_MEASUREMENT_CONFIG__={mode:'benchmark'};resetMeasurementRun({});const port=new Port();const worker=createMeasuredWorker('dev',()=>port as unknown as Worker);return {port,worker};}
afterEach(()=>{delete (globalThis as any).__GIM_MEASUREMENT_CONFIG__;resetMeasurementRun({});vi.restoreAllMocks();});
it('preserves transfer identity, seals queued failures and terminates once',()=>{
  const {port,worker}=start(),buffer=new ArrayBuffer(8),transfer=[buffer];worker.postMessage({kind:'compile',id:1,bytes:buffer},transfer);
  expect(port.transfers[1]).toBe(transfer);expect((port.messages[1] as any).bytes).toBe(buffer);
  port.fail=true;expect(()=>worker.postMessage({kind:'compile',id:2})).toThrow('clone-failed');
  worker.terminate();worker.terminate();expect(port.stops).toBe(1);expect(measurementSnapshot()).toMatchObject({
    activeTasks:[],taskOutcomes:{failed:1,cancelled:1},loss:{cancelledBeforeStart:1,interruptedTasks:0},
  });
});
it('late messages stay with the captured run; replacement instances never reuse IDs',()=>{
  const {port,worker}=start();const before=(port.messages[0] as any).context;
  resetMeasurementRun({});worker.terminate();expect(measurementSnapshot()?.taskOutcomes).toEqual({});
  expect(measurementSnapshot(before.runId)?.workers[before.workerId].state).toBe('terminated');
  const next=new Port();createMeasuredWorker('dev',()=>next as unknown as Worker);expect((next.messages[0] as any).context.workerId).not.toBe(before.workerId);
});
it('control telemetry is consumed before application message listeners',()=>{
  const {port}=start(),callback=vi.fn();port.addEventListener('message',callback);
  const context=(port.messages[0] as any).context;
  port.dispatchEvent(new MessageEvent('message',{data:{__gimMeasurement:'batch',workerId:context.workerId,events:[]}}));expect(callback).not.toHaveBeenCalled();
  port.dispatchEvent(new MessageEvent('message',{data:{kind:'result',id:1}}));expect(callback).toHaveBeenCalledOnce();
});
it('requires the final Worker batch marker before accepting an idle Worker termination',()=>{
  const {port,worker}=start();worker.postMessage({kind:'compile',traceId:'task-one'});
  const task=(port.messages[1] as any)._gimMeasurement.context;
  const event=(sequence:number,name:string)=>({version:MEASUREMENT_VERSION,context:task,producerId:task.workerId,
    sequence,clockId:'worker-clock',atMs:sequence,kind:'task',name,
    ...(name==='ended'?{status:'completed'}:{})});
  port.dispatchEvent(new MessageEvent('message',{data:{__gimMeasurement:'batch',workerId:task.workerId,
    batchId:1,lastSequence:2,events:[event(1,'started'),event(2,'ended')]}}));
  worker.terminate();
  expect(measurementSnapshot()).toMatchObject({detailComplete:false,loss:{detailEvents:1}});
  const second=start();second.worker.postMessage({kind:'compile',traceId:'task-two'});
  const next=(second.port.messages[1] as any)._gimMeasurement.context;
  const nextEvent=(sequence:number,name:string)=>({...event(sequence,name),context:next,producerId:next.workerId});
  second.port.dispatchEvent(new MessageEvent('message',{data:{__gimMeasurement:'batch',workerId:next.workerId,
    batchId:1,lastSequence:2,events:[nextEvent(1,'started'),nextEvent(2,'ended')]}}));
  second.port.dispatchEvent(new MessageEvent('message',{data:{__gimMeasurement:'flushed',workerId:next.workerId,batchId:1,lastSequence:2}}));
  second.worker.terminate();
  expect(measurementSnapshot()?.detailComplete).toBe(true);
});
it('records an unconfirmed tail separately for an intentionally cancelled active task',()=>{
  const {port,worker}=start();worker.postMessage({kind:'compile',traceId:'task-cancelled'});
  const task=(port.messages[1] as any)._gimMeasurement.context;
  port.dispatchEvent(new MessageEvent('message',{data:{__gimMeasurement:'batch',workerId:task.workerId,
    batchId:1,lastSequence:1,events:[{version:MEASUREMENT_VERSION,context:task,producerId:task.workerId,
      sequence:1,clockId:'worker-clock',atMs:1,kind:'task',name:'started'}]}}));
  markMeasuredWorkerTaskCancellation(worker,task.taskId,'request-superseded');worker.terminate();
  expect(measurementSnapshot()).toMatchObject({lifecycleComplete:true,taskOutcomes:{cancelled:1},
    counters:{'dev:worker.cancelled-unconfirmed-tail':{workers:1}}});
});
it('keeps an unexpected active termination incomplete and records its unconfirmed tail',()=>{
  const {port,worker}=start();worker.postMessage({kind:'compile',traceId:'task-interrupted'});
  const task=(port.messages[1] as any)._gimMeasurement.context;
  port.dispatchEvent(new MessageEvent('message',{data:{__gimMeasurement:'batch',workerId:task.workerId,
    batchId:1,lastSequence:1,events:[{version:MEASUREMENT_VERSION,context:task,producerId:task.workerId,
      sequence:1,clockId:'worker-clock',atMs:1,kind:'task',name:'started'}]}}));
  worker.terminate();
  expect(measurementSnapshot()).toMatchObject({lifecycleComplete:false,loss:{interruptedTasks:1},
    counters:{'dev:worker.active-tail-unconfirmed':{workers:1}}});
});
it('an explicit suite run ID never overwrites a prior session collector',()=>{
  (globalThis as any).__GIM_MEASUREMENT_CONFIG__={mode:'benchmark',runId:'fixed-suite'};
  resetMeasurementRun({generation:1});const first=measurementSnapshot()!.identity.runId;
  resetMeasurementRun({generation:2});expect(measurementSnapshot()!.identity.runId).not.toBe(first);expect(measurementSnapshot(first)?.identity.generation).toBe(1);
  const ids=new Set([first,measurementSnapshot()!.identity.runId]);for(let i=3;i<15;i++){resetMeasurementRun({generation:i});ids.add(measurementSnapshot()!.identity.runId);}expect(ids.size).toBe(14);
});
it('routes a reused Worker late A result and tail to A after B starts',()=>{
  const {port,worker}=start();worker.postMessage({kind:'compile',id:1,traceId:'shared'});
  const a=(port.messages[1] as any)._gimMeasurement.context;
  const event=(context:any,sequence:number,name:string,status?:string)=>({version:MEASUREMENT_VERSION,context,
    producerId:context.workerId,sequence,clockId:'worker-clock',atMs:sequence,kind:'task',name,...(status?{status,reasonCode:'request-superseded'}:{})});
  port.dispatchEvent(new MessageEvent('message',{data:{__gimMeasurement:'batch',workerId:a.workerId,batchId:1,lastSequence:1,events:[event(a,1,'started')]}}));
  markMeasuredWorkerTaskCancellation(worker,'shared','request-superseded');
  resetMeasurementRun({});worker.postMessage({kind:'compile',id:2,traceId:'shared'});
  const b=(port.messages[port.messages.length-1] as any)._gimMeasurement.context;
  port.dispatchEvent(new MessageEvent('message',{data:{__gimMeasurement:'batch',workerId:a.workerId,batchId:2,lastSequence:1,events:[event(b,1,'started')]}}));
  port.dispatchEvent(new MessageEvent('message',{data:{__gimMeasurement:'batch',workerId:a.workerId,batchId:3,lastSequence:2,events:[event(a,2,'ended','cancelled')]}}));
  port.dispatchEvent(new MessageEvent('message',{data:{id:1,_gimMeasurementResult:a}}));
  expect(measurementSnapshot(a.runId)?.taskOutcomes).toEqual({cancelled:1});
  expect(measurementSnapshot(b.runId)?.taskOutcomes).toEqual({});
  expect(measurementSnapshot(b.runId)?.activeTasks[0].taskId).toBe('shared');
  expect(measurementSnapshot(b.runId)?.loss.foreignRun).toBe(0);
  expect(measurementSnapshot(a.runId)?.counters['dev:host.received'].messages).toBe(1);
  port.dispatchEvent(new MessageEvent('message',{data:{id:2,_gimMeasurementResult:b}}));
  expect(measurementSnapshot(b.runId)?.phases['dev:host.result-roundtrip'].count).toBe(1);
  expect(measurementSnapshot(b.runId)?.workers[b.workerId].tasks).toBe(1);
});
