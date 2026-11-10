import { Probe, DurationStats, NOOP_SINK, type TraceContext, type MeasurementEvent, type MeasurementMode, type Workload, type TaskStatus, type MemoryMetric, type LifecycleReasonCode } from './core.js';

const CHANNEL = '__gimMeasurement';
let producerEpoch=0;
interface Envelope { context: TraceContext; command: string; mode?:MeasurementMode; receivedMs?: number; }
const offContext: TraceContext = { runId: 'off', sampleId: null, sourceSha256: null, buildId: null, generation: null,
  geometryToken: null, requestId: null, workerId: 'off', family: 'host', backend: 'web-worker', taskId: null,
  attemptId: 0, parentTaskId: null, sourceId: null, geometryLod: null };
const offProbe = new Probe('off', 'off', 'off', () => 0, NOOP_SINK);
export class WorkerTaskProbe {
  status: TaskStatus = 'completed';
  reasonCode:LifecycleReasonCode|undefined;
  private stages=new Map<string,{stats:DurationStats;workload:Workload}>();
  constructor(readonly context: TraceContext, private probe: Probe, private finish: () => void = () => {}) {}
  get enabled():boolean { return this.probe.mode !== 'off'; }
  result<T extends object>(message:T):T {
    return this.enabled?{...message,_gimMeasurementResult:{...this.context}}:message;
  }
  sentResult(){this.probe.trace(this.context,{type:'message',action:'sent',id:this.context.taskId+':result'});}
  reply(message:object,transfer?:Transferable[]|StructuredSerializeOptions){
    self.postMessage(this.result(message),transfer as StructuredSerializeOptions);
    this.sentResult();
  }
  phase(name: string) { return this.probe.phase(this.context, name); }
  measure<T>(name: string, work: (context:Readonly<TraceContext>) => Promise<T>) { return this.probe.mode === 'off' ? work(this.context) : this.probe.measure(this.context, name, work); }
  sync<T>(name: string, work: (context:Readonly<TraceContext>) => T) { return this.probe.measureSync(this.context, name, work); }
  record(name: string, ms: number, workload?: Workload) { this.probe.record(this.context, name, ms, workload); }
  observe(name:string,ms:number,workload:Workload={}){
    if(!this.enabled)return;
    let row=this.stages.get(name);if(!row){if(this.stages.size>=32){this.probe.event(this.context,{kind:'loss',name:'stage-group-limit',workload:{events:1}});return;}row={stats:new DurationStats(),workload:{}};this.stages.set(name,row);}
    row.stats.add(ms);for(const [key,value]of Object.entries(workload))row.workload[key]=(row.workload[key]??0)+value;
  }
  measureObserved<T>(name:string,work:()=>Promise<T>):Promise<T>{
    if(!this.enabled)return work();const start=performance.now();return work().then(value=>{this.observe(name,performance.now()-start,{calls:1});return value;},error=>{this.observe(name,performance.now()-start,{calls:1,failed:1});throw error;});
  }
  syncObserved<T>(name:string,work:()=>T):T{
    if(!this.enabled)return work();const start=performance.now();try{return work();}finally{this.observe(name,performance.now()-start,{calls:1});}
  }
  flushStages(){for(const [name,row]of this.stages)this.probe.event(this.context,{kind:'phase',name,durationMs:row.stats.totalMs,timing:'aggregate',histogram:row.stats.histogram(),workload:row.workload});this.stages.clear();}
  memory(metric: MemoryMetric) { this.probe.memory(this.context, metric); }
  fail(error: unknown) { const cancelled=(error as { name?: string })?.name === 'AbortError';
    this.status = cancelled ? 'cancelled' : 'failed';this.reasonCode=cancelled?'abort-error':'worker-exception';this.finish(); }
  produced(workload?: Workload) { this.probe.event(this.context, { kind: 'task', name: 'produced', workload }); this.finish(); }
}
export const NOOP_TASK = new WorkerTaskProbe(offContext, offProbe);

/** Private control messages are consumed before the existing application handler. */
export function createWorkerProbe() {
  let probe = offProbe, context = offContext, mode: MeasurementMode = 'off';
  let events: MeasurementEvent[] = [];
  const runProbes=new Map<string,Probe>();
  const seenRuns=new Set<string>();
  const key=(value:TraceContext)=>value.runId+'\0'+value.workerId;
  const makeProbe=(value:TraceContext,selectedMode:MeasurementMode)=>new Probe(value.workerId+':producer-'+ ++producerEpoch,
    value.workerId+':clock',selectedMode,()=>performance.now(),{emit},value.workerId);
  const emit=(record:MeasurementEvent)=>{events.push(record);
    if(events.length>=128||record.trace?.type==='span'&&record.trace.action==='started')flush();};
  let batchId=0,lastSequence=0;
  const pendingAcks=new Set<number>();
  const target = typeof self === 'undefined' ? undefined : self;
  const post = target?.postMessage?.bind(target) as ((data: unknown) => void) | undefined;
  const flush = () => {
    if (!events.length || !post) return;
    const batch = events; events = [];
    const id=++batchId;lastSequence=batch[batch.length-1].sequence;pendingAcks.add(id);
    post({ [CHANNEL]: 'batch', workerId: context.workerId, batchId:id,lastSequence,events: batch });
    if(pendingAcks.size>128){pendingAcks.clear();probe.event(context,{kind:'loss',name:'worker-batch-ack-overflow',workload:{events:1}});flush();}
  };
  const control = (event: MessageEvent): boolean => {
    const data = event.data;
    if(data?.[CHANNEL]==='calibrate'){const receivedMs=performance.now();post?.({[CHANNEL]:'clock',workerId:context.workerId,clockId:probe.clockId,receivedMs,sentMs:performance.now()});return true;}
    if(data?.[CHANNEL]==='ack'){
      if(data.workerId===context.workerId&&Number.isSafeInteger(data.batchId))pendingAcks.delete(data.batchId);
      return true;
    }
    if(data?._gimMeasurementTransfer){
      const flightId=data._gimMeasurementTransfer;delete data._gimMeasurementTransfer;
      post?.({[CHANNEL]:'transfer-received',workerId:context.workerId,flightId});
    }
    if (data?.[CHANNEL] !== 'init') {
      const envelope = data?._gimMeasurement as Envelope | undefined;
      if (envelope && envelope.receivedMs === undefined) envelope.receivedMs = performance.now();
      return false;
    }
    const receivedMs = performance.now();
    if(context!==offContext&&data.context.workerId!==context.workerId)throw Error('worker-execution-identity-changed');
    context = data.context; mode = data.mode;
    const clockId = `${context.workerId}:clock`;
    probe = makeProbe(context,mode);
    runProbes.set(key(context),probe);
    seenRuns.add(key(context));
    while(runProbes.size>16)runProbes.delete(runProbes.keys().next().value!);
    (globalThis as { __gimMeasurementIdentity?: unknown }).__gimMeasurementIdentity = { workerId: context.workerId, runId: context.runId, family: context.family, clockId };
    post?.({ [CHANNEL]: 'clock', workerId: context.workerId, clockId, receivedMs, sentMs: performance.now() });
    return true;
  };
  target?.addEventListener?.('message', event => { if (control(event as MessageEvent)) event.stopImmediatePropagation(); });
  async function run<T>(event: MessageEvent, work: (task: WorkerTaskProbe) => T | Promise<T>): Promise<T | undefined> {
    if (control(event)) return;
    const envelope = event.data?._gimMeasurement as Envelope | undefined;
    if (!envelope) return work(NOOP_TASK);
    const scopeId=envelope.context.operationTraceId+':'+envelope.context.workerId+':'+envelope.context.taskId+':'+envelope.context.attemptId;
    const parentScopeId=envelope.context.scopeId;
    const captured = Object.freeze({ ...envelope.context,executorId:envelope.context.workerId,scopeId });
    let capturedProbe=runProbes.get(key(captured));
    if(!capturedProbe){
      // New runs use the dispatch mode without requiring another Worker init.
      // Truly evicted runs keep their identity and a fresh producer cursor,
      // with bounded lifecycle evidence and an explicit retention gap.
      const expired=seenRuns.has(key(captured));
      const selectedMode=envelope.mode??mode;
      capturedProbe=makeProbe(captured,expired?'benchmark':selectedMode);runProbes.set(key(captured),capturedProbe);
      seenRuns.add(key(captured));
      if(expired)capturedProbe.event(captured,{kind:'loss',name:'worker-probe-retention-expired',workload:{events:1}});
      while(runProbes.size>16)runProbes.delete(runProbes.keys().next().value!);}
    if(capturedProbe.mode==='off')return work(NOOP_TASK);
    const scopedProbe=capturedProbe;
    const scopeStart=performance.now();
    const scope={scopeId,parentScopeId,scopeType:'executor' as const,declaration:'effective' as const,
      operationTraceId:captured.operationTraceId,executorId:captured.workerId,
      capabilities:['operation-context','span-lifecycle','dependency-edges','wait-intervals','clock-segments'] as const,
      window:{clockId:scopedProbe.clockId,startMs:scopeStart,endMs:null}};
    scopedProbe.trace(captured,{type:'scope',action:'declared',scope});
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      task.flushStages();
      execution.end(task.status);
      scopedProbe.event(captured, { kind: 'task', name: 'ended', status: task.status,
        ...(task.reasonCode?{reasonCode:task.reasonCode}:{}) });
      flush();
      post?.({[CHANNEL]:'flushed',workerId:captured.workerId,batchId,lastSequence});
    };
    const task = new WorkerTaskProbe(captured, scopedProbe, finish);
    scopedProbe.trace(captured,{type:'message',action:'received',id:captured.taskId!});
    scopedProbe.event(captured, { kind: 'task', name: 'started' });
    task.record('worker.queue', Math.max(0, performance.now() - (envelope.receivedMs ?? performance.now())));
    const execution = task.phase('worker.execution');
    flush();
    try { return await work(task); }
    catch (error) { task.fail(error); throw error; }
    finally {
      finish();
      scopedProbe.trace(captured,{type:'scope',action:'closed',id:scopeId,endMs:performance.now()});
      flush();post?.({[CHANNEL]:'flushed',workerId:captured.workerId,batchId,lastSequence});
    }
  }
  return { control, run, flush,
    wrap<T>(handler: (event: MessageEvent<T>, task: WorkerTaskProbe) => unknown | Promise<unknown>) {
      return (event: MessageEvent<T>) => run(event, task => handler(event, task));
    },
  };
}

/** Bound to the installed web-ifc adapter, not a generic JS heap measurement. */
export function sampleWasmCapacity(task: WorkerTaskProbe, api: { wasmModule?: unknown }): void {
  const module = api.wasmModule as { HEAPU8?: Uint8Array } | undefined;
  const bytes = module?.HEAPU8?.buffer.byteLength;
  task.memory({ name: 'wasm-linear-capacity', scope: 'worker', method: 'web-ifc-HEAPU8-buffer', quality: 'measured-capacity',
    availability: bytes === undefined ? 'unavailable' : 'available', bytes: bytes ?? null,
    ...(bytes === undefined ? { reason: 'wasm-capacity-not-exposed' } : {}), sampleDelayMs: 0 });
}
