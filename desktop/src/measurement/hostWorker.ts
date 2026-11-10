import { calibrateClock, type TraceContext, type WorkerFamily, type MeasurementEvent, type LifecycleReasonCode } from './core.js';
import { measurementRun, measurementContext, measurementSourceId,trackHostBuffers,measurementCollector,measurementProbe,measurementRuntime } from './runtime.js';

export const MEASUREMENT_CHANNEL = '__gimMeasurement';
let workerSequence = 0;
const bootstrapUrls=new Map<string,string>();
const bootstrapMetadata=new Map<string,{workerId:string;runId:string;family:WorkerFamily}>();
const workerIdentities=new WeakMap<Worker,string>();
export function measurementWorkerIdentity(worker:Worker){return workerIdentities.get(worker);}
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
  const metadata=bootstrapMetadata.get(identity);if(!metadata)throw Error('unregistered-worker-measurement-identity');
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
  bootstrapMetadata.set(workerId,{workerId,runId:run.collector.identity.runId,family});
  let worker:Worker;
  const releaseUrl=()=>{const url=bootstrapUrls.get(workerId);if(url){URL.revokeObjectURL(url);bootstrapUrls.delete(workerId);}};
  try{worker=construct(workerId);}catch(error){releaseUrl();throw error;}finally{bootstrapMetadata.delete(workerId);}
  workerIdentities.set(worker,workerId);
  if (typeof worker.addEventListener !== 'function') return worker; // Injected test ports have no runtime target.
  const context: TraceContext = { ...measurementContext(run.collector), workerId, family, backend: 'web-worker', sourceId:measurementSourceId(sourcePath,run.collector) };
  const send = worker.postMessage.bind(worker), terminate = worker.terminate.bind(worker);
  let sequence = 0, stopped = false, clockReady = false;
  const sentAt=new Map<string,number>();
  const taskKey=(task:TraceContext)=>[task.runId,task.workerId,task.taskId,task.attemptId].join('\0');
  const seenRuns=new Set([context.runId]);
  const createdAt=performance.now();
  let receivedBatchId=0,lastBatchSequence=0,flushedBatchId=0,flushedSequence=0,taskSeen=false;
  const unconfirmedRuns=new Set<string>();
  const taskContexts=new Map<string,TraceContext>();
  cancelTaskMeasurement.set(worker,(taskId,reason)=>{
    const matches=[...taskContexts.values()].filter(row=>row.taskId===taskId);const task=matches.length===1?matches[0]:undefined;
    if(task)measurementProbe(task.runId)?.event(task,{kind:'counter',name:'lifecycle.cancel-requested',reasonCode:reason,workload:{requests:1}});
  });
  let flightSequence=0;
  const flights=new Map<string,{release:(to?:string)=>void;at:number;context:TraceContext}>();
  const transferMessage=(data:Record<string,unknown>,transfer:Transferable[]|StructuredSerializeOptions|undefined,task:TraceContext)=>{
    const buffers=(Array.isArray(transfer)?transfer:transfer?.transfer??[]).filter((value):value is ArrayBuffer=>value instanceof ArrayBuffer);
    if(!buffers.length)return {data,flightId:undefined};
    if(flights.size>=1024){run.probe.event(task,{kind:'loss',name:'transfer-ledger-overflow',workload:{events:1}});return {data,flightId:undefined};}
    const flightId=`flight-${++flightSequence}`;
    flights.set(flightId,{release:trackHostBuffers('in-flight',buffers,measurementRuntime(task.runId)??run,task),at:performance.now(),context:task});
    return {data:{...data,_gimMeasurementTransfer:flightId},flightId};
  };
  let clockSent = performance.now();
  let calibrationSequence=0;
  const clockTimer=run.collector.mode==='diagnostic'?setInterval(()=>{if(!stopped){clockSent=performance.now();send({[MEASUREMENT_CHANNEL]:'calibrate',workerId});}},30000):undefined;
  run.probe.event(context, { kind: 'worker', name: 'created',startMs:createdAt,workerUrl:bootstrapUrls.get(workerId) });
  run.collector.flushDetails();
  worker.addEventListener('message', event => {
    const message = event.data;
    if(message?.[MEASUREMENT_CHANNEL]==='transfer-received'){
      event.stopImmediatePropagation();
      if(message.workerId!==workerId)return;
      const flight=flights.get(message.flightId);if(flight){flights.delete(message.flightId);flight.release(workerId);measurementProbe(flight.context.runId)?.record(flight.context,'host.delivery-and-worker-queue',performance.now()-flight.at);}
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
        const collector=measurementCollector(record.context.runId);
        if(collector){collector.accept(record);if(unconfirmedRuns.size<16)unconfirmedRuns.add(record.context.runId);}
        else run.probe.trace(context,{type:'health',action:'unassociated-worker-record'});
        if(record.kind==='task'&&record.name==='started'){taskSeen=true;}
        if(record.kind==='task'&&record.name==='ended'){
          // Retain bounded tombstones for late results after a subsequent task starts.
          while(taskContexts.size>4096)taskContexts.delete(taskContexts.keys().next().value!);
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
      unconfirmedRuns.clear();
    } else if (message?.[MEASUREMENT_CHANNEL] === 'clock') {
      event.stopImmediatePropagation();
      if (message.workerId !== workerId) return;
      clockReady = true;
      releaseUrl();
      const calibration = calibrateClock(clockSent, message.receivedMs, message.sentMs, performance.now());
      run.probe.event(context, { kind: 'clock', name: 'worker-clock', clock: { ...calibration, remoteClockId: message.clockId } });
      run.probe.trace(context,{type:'health',action:'clock-calibrated',calibration:{calibrationId:workerId+':cal-'+ ++calibrationSequence,
        clockId:message.clockId,referenceClockId:run.probe.clockId,...calibration,validFromLocalMs:message.receivedMs,validToLocalMs:message.sentMs+30000}});
      run.probe.event(context, { kind: 'worker', name: 'ready' });
    } else {
      // Arrival is not scene consumption or cache publication.
      const declared=message?._gimMeasurementResult as TraceContext|undefined;
      const candidates=[...taskContexts.values()].filter(row=>declared
        ?row.runId===declared.runId&&row.taskId===declared.taskId&&row.attemptId===declared.attemptId
        :message?.id!==undefined&&row.requestId===String(message.id));
      const task=candidates.length===1?candidates[0]:null;
      if(task){const collector=measurementCollector(task.runId);
        if(collector){const owner={probe:measurementProbe(task.runId)!};
          owner.probe.event(task,{kind:'counter',name:'host.received',workload:{messages:1}});
          owner.probe.trace(task,{type:'message',action:'received',id:task.taskId!+':result'});
          const start=sentAt.get(taskKey(task));
          if(start!==undefined)owner.probe.record(task,'host.result-roundtrip',performance.now()-start);
          sentAt.delete(taskKey(task));
        }
      }else {
        const unassociated={...context,operationTraceId:null,activeSpanId:null,taskId:null,sourceId:null,sourceSha256:null,requestId:null};
        run.probe.event(unassociated,{kind:'counter',name:'host.received',workload:{messages:1}});
        run.probe.trace(unassociated,{type:'health',action:'unassociated-result'});
      }
    }
  });
  worker.addEventListener('error', () => run.probe.event(context, { kind: 'worker', name: 'failed', status: 'failed' }));
  worker.addEventListener('messageerror', () => run.probe.event(context, { kind: 'worker', name: 'failed', status: 'failed' }));
  worker.postMessage = ((message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
    const data = message as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || controls.has(String(data.kind ?? data.type))) {
      const prepared=data&&typeof data==='object'?transferMessage(data,transfer,{...context,operationTraceId:null,activeSpanId:null,taskId:null,requestId:null}):{data:message,flightId:undefined};
      try{if (Array.isArray(transfer)) send(prepared.data, transfer); else send(prepared.data, transfer);}
      catch(error){if(prepared.flightId){flights.get(prepared.flightId)?.release();flights.delete(prepared.flightId);}throw error;}return;
    }
    const provided=data._gimMeasurementContext as TraceContext|undefined;
    if(provided&&!measurementCollector(provided.runId)){
      run.probe.trace({...context,operationTraceId:null,taskId:null},{type:'health',action:'expired-dispatch-context'});
      const unmeasured={...data};delete unmeasured._gimMeasurementContext;
      if(Array.isArray(transfer))send(unmeasured,transfer);else send(unmeasured,transfer);return;
    }
    const scope = provided&&measurementCollector(provided.runId)?provided:measurementContext();
    const task: TraceContext = { ...context,...scope,workerId, family,backend:'web-worker',executorId:workerId, generation:scope.generation, geometryToken:scope.geometryToken, sourceSha256:scope.sourceSha256,
      taskId: typeof data.traceId === 'string' ? data.traceId : `${workerId}:task-${++sequence}`,
      attemptId: typeof data.attemptId === 'number' ? data.attemptId : 1,
      parentTaskId: typeof data.parentTaskId === 'string' ? data.parentTaskId : null,
      sourceId: measurementSourceId(typeof data.path === 'string' ? data.path : sourcePath, measurementCollector(scope.runId)??run.collector),
      requestId: String(data.requestId ?? data.id ?? sequence), geometryLod: typeof data.lod === 'number' ? data.lod : null };
    const dispatch={probe:measurementProbe(scope.runId)!};
    if(!seenRuns.has(scope.runId)){seenRuns.add(scope.runId);while(seenRuns.size>16)seenRuns.delete(seenRuns.values().next().value!);
      dispatch.probe.event(task,{kind:'worker',name:'reused',startMs:createdAt});}
    const phase = dispatch.probe.phase(task, 'host.send');
    lastTaskContext.set(worker,task);
    taskContexts.set(task.runId+'\0'+task.taskId+'\0'+task.attemptId,task);
    while(taskContexts.size>4096){taskContexts.delete(taskContexts.keys().next().value!);
      dispatch.probe.trace(task,{type:'health',action:'task-context-capacity'});}
    if(sentAt.size<4096)sentAt.set(taskKey(task),performance.now());
    dispatch.probe.event(task, { kind: 'task', name: 'queued' });
    dispatch.probe.trace(task,{type:'message',action:'sent',id:task.taskId!});
    const prepared=transferMessage({ ...data, _gimMeasurement: { context: task, command: String(data.kind ?? data.type ?? 'convert') } },transfer,task);
    try {
      const payload = prepared.data;
      if (Array.isArray(transfer)) send(payload, transfer); else send(payload, transfer);
      phase.end('completed', { transferBuffers: Array.isArray(transfer) ? transfer.length : transfer?.transfer?.length ?? 0 });
    } catch (error) { if(prepared.flightId){flights.get(prepared.flightId)?.release();flights.delete(prepared.flightId);}sentAt.delete(taskKey(task));taskContexts.delete(task.runId+'\0'+task.taskId+'\0'+task.attemptId); phase.end('failed'); dispatch.probe.event(task, { kind: 'task', name: 'ended', status: 'failed' }); throw error; }
  }) as Worker['postMessage'];
  worker.terminate = () => {
    if (stopped) return; stopped = true;clearInterval(clockTimer);
    if(taskSeen&&(receivedBatchId!==flushedBatchId||lastBatchSequence!==flushedSequence)){
      for(const id of unconfirmedRuns.size?unconfirmedRuns:[context.runId]){
        const owner=measurementRuntime(id);if(!owner)continue;
        const active=owner.collector.snapshot().activeTasks.some(task=>task.workerId===workerId);
        const scope={...context,runId:id,operationTraceId:null,sourceSha256:null,sourceId:null};
        if(active)owner.probe.event(scope,{kind:'counter',
          name:owner.collector.intentionalTermination(workerId)?'worker.cancelled-unconfirmed-tail':'worker.active-tail-unconfirmed',
          workload:{workers:1}});
        else owner.probe.event(scope,{kind:'loss',name:'worker-terminal-tail-unconfirmed',workload:{events:1}});
      }
    }
    run.probe.event(context, { kind: 'worker', name: 'terminated', status: 'aborted', workload: { clockReady: Number(clockReady) } });
    const terminatedRuns=new Set([context.runId]);
    for(const task of taskContexts.values())if(!terminatedRuns.has(task.runId)){
      terminatedRuns.add(task.runId);
      measurementProbe(task.runId)?.event(task,{kind:'worker',name:'terminated',status:'aborted'});
    }
    sentAt.clear();taskContexts.clear();cancelTaskMeasurement.delete(worker);
    for(const flight of flights.values())flight.release();flights.clear();
    releaseUrl();
    terminate();
  };
  send({ [MEASUREMENT_CHANNEL]: 'init', context, mode: run.collector.mode, clockSent });
  return worker;
}
