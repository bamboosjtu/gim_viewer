import {afterEach,expect,it,vi} from 'vitest';
import {createMeasuredWorker} from '../hostWorker.js';
import {resetMeasurementRun,measurementSnapshot} from '../runtime.js';
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
  worker.terminate();worker.terminate();expect(port.stops).toBe(1);expect(measurementSnapshot()).toMatchObject({activeTasks:[],taskOutcomes:{failed:1,aborted:1}});
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
  const event=(sequence:number,name:string)=>({version:'gim-measurement-v1',context:task,producerId:task.workerId,
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
it('an explicit suite run ID never overwrites a prior session collector',()=>{
  (globalThis as any).__GIM_MEASUREMENT_CONFIG__={mode:'benchmark',runId:'fixed-suite'};
  resetMeasurementRun({generation:1});const first=measurementSnapshot()!.identity.runId;
  resetMeasurementRun({generation:2});expect(measurementSnapshot()!.identity.runId).not.toBe(first);expect(measurementSnapshot(first)?.identity.generation).toBe(1);
  const ids=new Set([first,measurementSnapshot()!.identity.runId]);for(let i=3;i<15;i++){resetMeasurementRun({generation:i});ids.add(measurementSnapshot()!.identity.runId);}expect(ids.size).toBe(14);
});
