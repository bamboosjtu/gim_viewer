import { Probe, DurationStats, NOOP_SINK, type TraceContext, type MeasurementEvent, type MeasurementMode, type Workload, type TaskStatus, type MemoryMetric } from './core.js';

const CHANNEL = '__gimMeasurement';
interface Envelope { context: TraceContext; command: string; receivedMs?: number; }
const offContext: TraceContext = { runId: 'off', sampleId: null, sourceSha256: null, buildId: null, generation: null,
  geometryToken: null, requestId: null, workerId: 'off', family: 'host', backend: 'web-worker', taskId: null,
  attemptId: 0, parentTaskId: null, sourceId: null, geometryLod: null };
const offProbe = new Probe('off', 'off', 'off', () => 0, NOOP_SINK);
export class WorkerTaskProbe {
  status: TaskStatus = 'completed';
  private stages=new Map<string,{stats:DurationStats;workload:Workload}>();
  constructor(readonly context: TraceContext, private probe: Probe, private finish: () => void = () => {}) {}
  get enabled():boolean { return this.probe.mode !== 'off'; }
  phase(name: string) { return this.probe.phase(this.context, name); }
  measure<T>(name: string, work: () => Promise<T>) { return this.probe.mode === 'off' ? work() : this.probe.measure(this.context, name, work); }
  sync<T>(name: string, work: () => T) { return this.probe.measureSync(this.context, name, work); }
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
  fail(error: unknown) { this.status = (error as { name?: string })?.name === 'AbortError' ? 'cancelled' : 'failed'; this.finish(); }
  produced(workload?: Workload) { this.probe.event(this.context, { kind: 'task', name: 'produced', workload }); this.finish(); }
}
export const NOOP_TASK = new WorkerTaskProbe(offContext, offProbe);

/** Private control messages are consumed before the existing application handler. */
export function createWorkerProbe() {
  let probe = offProbe, context = offContext, mode: MeasurementMode = 'off';
  let events: MeasurementEvent[] = [];
  const target = typeof self === 'undefined' ? undefined : self;
  const post = target?.postMessage?.bind(target) as ((data: unknown) => void) | undefined;
  const flush = () => {
    if (!events.length || !post) return;
    const batch = events; events = [];
    post({ [CHANNEL]: 'batch', workerId: context.workerId, events: batch });
  };
  const control = (event: MessageEvent): boolean => {
    const data = event.data;
    if(data?._gimMeasurementTransfer){
      const flightId=data._gimMeasurementTransfer;delete data._gimMeasurementTransfer;
      post?.({[CHANNEL]:'transfer-received',workerId:context.workerId,flightId});
    }
    if (data?.[CHANNEL] !== 'init') {
      const envelope = data?._gimMeasurement as Envelope | undefined;
      if (envelope && envelope.receivedMs === undefined) envelope.receivedMs = performance.now();
      return false;
    }
    const receivedMs = performance.now(); context = data.context; mode = data.mode;
    const clockId = `${context.workerId}:clock`;
    probe = new Probe(context.workerId, clockId, mode, () => performance.now(), { emit(record) { events.push(record); if (events.length >= 128) flush(); } });
    (globalThis as { __gimMeasurementIdentity?: unknown }).__gimMeasurementIdentity = { workerId: context.workerId, runId: context.runId, family: context.family, clockId };
    post?.({ [CHANNEL]: 'clock', workerId: context.workerId, clockId, receivedMs, sentMs: performance.now() });
    return true;
  };
  target?.addEventListener?.('message', event => { if (control(event as MessageEvent)) event.stopImmediatePropagation(); });
  async function run<T>(event: MessageEvent, work: (task: WorkerTaskProbe) => T | Promise<T>): Promise<T | undefined> {
    if (control(event)) return;
    const envelope = event.data?._gimMeasurement as Envelope | undefined;
    if (!envelope || mode === 'off') return work(NOOP_TASK);
    const captured = { ...envelope.context }, capturedProbe = probe;
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      task.flushStages();
      execution.end(task.status);
      capturedProbe.event(captured, { kind: 'task', name: 'ended', status: task.status });
      flush();
    };
    const task = new WorkerTaskProbe(captured, capturedProbe, finish);
    probe.event(captured, { kind: 'task', name: 'started' });
    task.record('worker.queue', Math.max(0, performance.now() - (envelope.receivedMs ?? performance.now())));
    const execution = task.phase('worker.execution');
    flush();
    try { return await work(task); }
    catch (error) { task.fail(error); throw error; }
    finally {
      finish();
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
