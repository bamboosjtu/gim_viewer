import { calibrateClock, type TraceContext, type WorkerFamily, type MeasurementEvent, type LifecycleReasonCode } from './core.js';
import { measurementRun, measurementContext, measurementSourceId,trackHostBuffers } from './runtime.js';

export const MEASUREMENT_CHANNEL = '__gimMeasurement';
let workerSequence = 0;
const bootstrapUrls=new Map<string,string>();
const lastTaskContext=new WeakMap<Worker,TraceContext>();
export function measurementWorkerTask(worker:Worker):TraceContext|undefined {return lastTaskContext.get(worker);}
const cancelTaskMeasurement=new WeakMap<Worker,(taskId:string,reason:LifecycleReasonCode)=>void>();
/** Register an explicit, task-scoped cancellation before its Worker is stopped. */
export function markMeasuredWorkerTaskCancellation(worker:Worker,taskId:string,reason:LifecycleReasonCode):void {
  cancelTaskMeasurement.get(worker)?.(taskId,reason);
}
const controls = new Set(['read-result', 'connection-consumed', 'consumed', 'cancel']);
/** Instruments real Workers without changing their application protocol or transfer lists. */
export function measurementWorkerUrl(url:string,identity:string):string {
  if(!identity)return url;
  const parts=identity.split(':'),metadata={workerId:identity,runId:parts.slice(0,-2).join(':'),family:parts[parts.length-2]};
  const canonical=new URL(url,globalThis.location.href).href;
  // Never decorate the entry module URL: split chunks can import it again,
  // and URL fragments create distinct module instances and message handlers.
  const source=`globalThis.__gimMeasurementIdentity=${JSON.stringify(metadata)};
const queued=[];const buffer=e=>{e.stopImmediatePropagation();if(e.data?._gimMeasurement)e.data._gimMeasurement.receivedMs=performance.now();queued.push({data:e.data,ports:e.ports});};
self.addEventListener('message',buffer);
await import(${JSON.stringify(canonical)});
self.removeEventListener('message',buffer);
for(const event of queued)self.dispatchEvent(new MessageEvent('message',event));`;
  const target=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));bootstrapUrls.set(identity,target);return target;
}
export function createMeasuredWorker(family: WorkerFamily, construct: (identity:string) => Worker, sourcePath?:string): Worker {
  const run = measurementRun();
  if (run.collector.mode === 'off') return construct('');
  const workerId = `${run.collector.identity.runId}:${family}:${++workerSequence}`;
  let worker:Worker;
  const releaseUrl=()=>{const url=bootstrapUrls.get(workerId);if(url){URL.revokeObjectURL(url);bootstrapUrls.delete(workerId);}};
  try{worker=construct(workerId);}catch(error){releaseUrl();throw error;}
  if (typeof worker.addEventListener !== 'function') return worker; // Injected test ports have no runtime target.
  const context: TraceContext = { ...measurementContext(run.collector), workerId, family, backend: 'web-worker', sourceId:measurementSourceId(sourcePath,run.collector) };
  const send = worker.postMessage.bind(worker), terminate = worker.terminate.bind(worker);
  let sequence = 0, stopped = false, clockReady = false;
  let activeContext:TraceContext=context, producedContext:TraceContext|undefined;
  const sentAt=new Map<string,number>();
  let receivedBatchId=0,lastBatchSequence=0,flushedBatchId=0,flushedSequence=0,taskSeen=false;
  const taskContexts=new Map<string,TraceContext>();
  cancelTaskMeasurement.set(worker,(taskId,reason)=>{
    const task=taskContexts.get(taskId);
    if(task)run.probe.event(task,{kind:'counter',name:'lifecycle.cancel-requested',reasonCode:reason,workload:{requests:1}});
  });
  let flightSequence=0;
  const flights=new Map<string,{release:(to?:string)=>void;at:number;context:TraceContext}>();
  const transferMessage=(data:Record<string,unknown>,transfer:Transferable[]|StructuredSerializeOptions|undefined,task:TraceContext)=>{
    const buffers=(Array.isArray(transfer)?transfer:transfer?.transfer??[]).filter((value):value is ArrayBuffer=>value instanceof ArrayBuffer);
    if(!buffers.length)return {data,flightId:undefined};
    if(flights.size>=1024){run.probe.event(task,{kind:'loss',name:'transfer-ledger-overflow',workload:{events:1}});return {data,flightId:undefined};}
    const flightId=`flight-${++flightSequence}`;
    flights.set(flightId,{release:trackHostBuffers('in-flight',buffers,run,task),at:performance.now(),context:task});
    return {data:{...data,_gimMeasurementTransfer:flightId},flightId};
  };
  const clockSent = performance.now();
  run.probe.event(context, { kind: 'worker', name: 'created',workerUrl:bootstrapUrls.get(workerId) });
  run.collector.flushDetails();
  worker.addEventListener('message', event => {
    const message = event.data;
    if(message?.[MEASUREMENT_CHANNEL]==='transfer-received'){
      event.stopImmediatePropagation();
      if(message.workerId!==workerId)return;
      const flight=flights.get(message.flightId);if(flight){flights.delete(message.flightId);flight.release(workerId);run.probe.record(flight.context,'host.delivery-and-worker-queue',performance.now()-flight.at);}
    }else if (message?.[MEASUREMENT_CHANNEL] === 'batch') {
      event.stopImmediatePropagation();
      if(message.workerId!==workerId||!Array.isArray(message.events)||message.events.length<1||message.events.length>128||
        !Number.isSafeInteger(message.batchId)||message.batchId!==receivedBatchId+1||
        message.lastSequence!==message.events.at(-1)?.sequence){
        run.probe.event(context,{kind:'loss',name:'worker-batch-invalid',workload:{events:1}});return;
      }
      receivedBatchId=message.batchId;lastBatchSequence=message.lastSequence;
      for (const record of message.events as MeasurementEvent[]) {
        if (record.context?.workerId !== workerId) {run.probe.event(context,{kind:'loss',name:'worker-event-foreign',workload:{events:1}});continue;}
        run.collector.accept(record);
        if(record.kind==='task'&&record.name==='started'){activeContext=record.context;taskSeen=true;}
        if(record.kind==='task'&&record.name==='produced')producedContext=record.context;
        if(record.kind==='task'&&record.name==='ended'){
          taskContexts.delete(record.context.taskId!);
          if(record.context.taskId!==producedContext?.taskId)sentAt.delete(record.context.taskId!);
        }
      }
      try{send({[MEASUREMENT_CHANNEL]:'ack',workerId,batchId:message.batchId});}
      catch{run.probe.event(context,{kind:'loss',name:'worker-batch-ack-failed',workload:{events:1}});}
    } else if(message?.[MEASUREMENT_CHANNEL]==='flushed'){
      event.stopImmediatePropagation();
      if(message.workerId!==workerId||message.batchId!==receivedBatchId||message.lastSequence!==lastBatchSequence){
        run.probe.event(context,{kind:'loss',name:'worker-flush-unconfirmed',workload:{events:1}});return;
      }
      flushedBatchId=message.batchId;flushedSequence=message.lastSequence;
    } else if (message?.[MEASUREMENT_CHANNEL] === 'clock') {
      event.stopImmediatePropagation();
      if (message.workerId !== workerId) return;
      clockReady = true;
      releaseUrl();
      const calibration = calibrateClock(clockSent, message.receivedMs, message.sentMs, performance.now());
      run.probe.event(context, { kind: 'clock', name: 'worker-clock', clock: { ...calibration, remoteClockId: message.clockId } });
      run.probe.event(context, { kind: 'worker', name: 'ready' });
    } else {
      // Arrival is not scene consumption or cache publication.
      const task=producedContext??activeContext;
      run.probe.event(task, { kind: 'counter', name: 'host.received', workload: { messages: 1 } });
      if(producedContext){
        const start=sentAt.get(producedContext.taskId!);
        if(start!==undefined)run.probe.record(producedContext,'host.result-roundtrip',performance.now()-start);
        sentAt.delete(producedContext.taskId!);producedContext=undefined;
      }
    }
  });
  worker.addEventListener('error', () => run.probe.event(context, { kind: 'worker', name: 'failed', status: 'failed' }));
  worker.addEventListener('messageerror', () => run.probe.event(context, { kind: 'worker', name: 'failed', status: 'failed' }));
  worker.postMessage = ((message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
    const data = message as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || controls.has(String(data.kind ?? data.type))) {
      const prepared=data&&typeof data==='object'?transferMessage(data,transfer,activeContext):{data:message,flightId:undefined};
      try{if (Array.isArray(transfer)) send(prepared.data, transfer); else send(prepared.data, transfer);}
      catch(error){if(prepared.flightId){flights.get(prepared.flightId)?.release();flights.delete(prepared.flightId);}throw error;}return;
    }
    const scope = measurementContext(run.collector);
    const task: TraceContext = { ...context, generation:scope.generation, geometryToken:scope.geometryToken, sourceSha256:scope.sourceSha256,
      taskId: typeof data.traceId === 'string' ? data.traceId : `${workerId}:task-${++sequence}`,
      attemptId: typeof data.attemptId === 'number' ? data.attemptId : 1,
      parentTaskId: typeof data.parentTaskId === 'string' ? data.parentTaskId : null,
      sourceId: measurementSourceId(typeof data.path === 'string' ? data.path : sourcePath, run.collector),
      requestId: String(data.requestId ?? data.id ?? sequence), geometryLod: typeof data.lod === 'number' ? data.lod : null };
    const phase = run.probe.phase(task, 'host.send');
    lastTaskContext.set(worker,task);
    taskContexts.set(task.taskId!,task);
    if(sentAt.size<4096)sentAt.set(task.taskId!,performance.now());
    run.probe.event(task, { kind: 'task', name: 'queued' });
    const prepared=transferMessage({ ...data, _gimMeasurement: { context: task, command: String(data.kind ?? data.type ?? 'convert') } },transfer,task);
    try {
      const payload = prepared.data;
      if (Array.isArray(transfer)) send(payload, transfer); else send(payload, transfer);
      phase.end('completed', { transferBuffers: Array.isArray(transfer) ? transfer.length : transfer?.transfer?.length ?? 0 });
    } catch (error) { if(prepared.flightId){flights.get(prepared.flightId)?.release();flights.delete(prepared.flightId);}sentAt.delete(task.taskId!);taskContexts.delete(task.taskId!); phase.end('failed'); run.probe.event(task, { kind: 'task', name: 'ended', status: 'failed' }); throw error; }
  }) as Worker['postMessage'];
  worker.terminate = () => {
    if (stopped) return; stopped = true;
    const active=run.collector.snapshot().activeTasks.some(task=>task.workerId===workerId);
    if(taskSeen&&(receivedBatchId!==flushedBatchId||lastBatchSequence!==flushedSequence)){
      if(active)run.probe.event(context,{kind:'counter',
        name:run.collector.intentionalTermination(workerId)?'worker.cancelled-unconfirmed-tail':'worker.active-tail-unconfirmed',
        workload:{workers:1}});
      else run.probe.event(context,{kind:'loss',name:'worker-terminal-tail-unconfirmed',workload:{events:1}});
    }
    run.probe.event(context, { kind: 'worker', name: 'terminated', status: 'aborted', workload: { clockReady: Number(clockReady) } });
    sentAt.clear();taskContexts.clear();cancelTaskMeasurement.delete(worker);producedContext=undefined;
    for(const flight of flights.values())flight.release();flights.clear();
    releaseUrl();
    terminate();
  };
  send({ [MEASUREMENT_CHANNEL]: 'init', context, mode: run.collector.mode, clockSent });
  return worker;
}
