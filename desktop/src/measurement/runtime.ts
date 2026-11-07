import { Collector, Probe, BufferLedger, type MeasurementMode, type RunIdentity, type TraceContext, type MemoryMetric } from './core.js';

interface MeasurementConfig { mode?: MeasurementMode; runId?: string; sampleId?: string; sourceSha256?: string; buildId?: string; }
const globals = globalThis as typeof globalThis & { __GIM_MEASUREMENT_CONFIG__?: MeasurementConfig };
let serial = 0;
let onCollector:((collector:Collector)=>void)|undefined;
export function observeMeasurementCollectors(observer:(collector:Collector)=>void):void {onCollector=observer;observer(current.collector);}
const archives = new Map<string, Collector>();
const privateSourceIds = new WeakMap<Collector, Map<string, string>>();
const hostBuffers=new WeakMap<Collector,BufferLedger>();
let readSession:(()=>{generation:number;geometryToken:number;sourceSha256:string|null})|undefined;
export function bindMeasurementSession(reader:typeof readSession):void { readSession=reader; }
function configuration(): MeasurementConfig {
  if (import.meta.env?.DEV || import.meta.env?.VITE_GIM_DIAGNOSTICS === '1' || import.meta.env?.MODE === 'test') {
    const config=globals.__GIM_MEASUREMENT_CONFIG__??{};
    return config.mode&&['off','summary','benchmark','diagnostic'].includes(config.mode)?config:{};
  }
  return {};
}
function createRun(identity: Partial<RunIdentity> = {}) {
  // Until native overhead acceptance is complete, ordinary builds retain the
  // existing profiler only. Diagnostics/benchmark callers opt in explicitly.
  const config = configuration(), mode = config.mode ?? 'off';
  const sequence=++serial;
  const run: RunIdentity = { runId: config.runId?`${config.runId}:session-${sequence}`:`run-${Date.now().toString(36)}-${sequence}`, sampleId: config.sampleId ?? null,
    sourceSha256: config.sourceSha256 ?? null, buildId: config.buildId ?? import.meta.env?.VITE_GIM_COMMIT ?? null,
    generation: null, geometryToken: null, requestId: null, ...identity };
  const collector = new Collector(run, mode);
  const buffers=new BufferLedger();hostBuffers.set(collector,buffers);let ownerSequence=0;
  onCollector?.(collector);
  const probe = new Probe(`${run.runId}:host`, `${run.runId}:host-clock`, mode, () => performance.now(), collector);
  archives.set(run.runId, collector);
  while (archives.size > 4) archives.delete(archives.keys().next().value!);
  return { collector, probe,buffers,newOwner:(role:string)=>`${role}-${++ownerSequence}` };
}
let current = createRun();
export function measurementRun() { return current; }
export function resetMeasurementRun(identity: Partial<RunIdentity>): void { current = createRun(identity); }
export function updateMeasurementIdentity(identity: Partial<RunIdentity>): void {
  const target = current.collector.identity;
  if (identity.sourceSha256 && target.sourceSha256 && identity.sourceSha256 !== target.sourceSha256) throw Error('measurement-source-identity-changed');
  Object.assign(target, identity);
}
export function measurementContext(collector = current.collector): TraceContext {
  const session=readSession?.();
  const scope=session&&session.generation===collector.identity.generation?session:{};
  return { ...collector.identity, ...scope, workerId: 'host', family: 'host', backend: 'host', taskId: null,
    attemptId: 0, parentTaskId: null, sourceId: null, geometryLod: null };
}
export function measurementSourceId(path: string | undefined, collector = current.collector): string | null {
  if (!path) return null;
  let sources = privateSourceIds.get(collector); if (!sources) { sources = new Map(); privateSourceIds.set(collector, sources); }
  const key = path.replace(/\\/g, '/'); let id = sources.get(key);
  if (!id) { id = `source-${sources.size + 1}`; sources.set(key, id); }
  return id;
}
/** Private mapping is separate from shareable measurement snapshots. */
export function measurementPrivateSources(runId: string) { const run = archives.get(runId); return run ? Object.fromEntries(privateSourceIds.get(run) ?? []) : {}; }
export function measurementSnapshot(runId = current.collector.identity.runId) { const collector=archives.get(runId);return collector?{...collector.snapshot(),hostResources:hostBuffers.get(collector)?.ledger.snapshot()}:null; }
export function drainMeasurementEvents(runId = current.collector.identity.runId) { return archives.get(runId)?.drain() ?? []; }
export function recordHostMemory(metric: MemoryMetric): void { if(current.collector.mode!=='off')current.probe.memory(measurementContext(), metric); }
export function sampleHostBuffers(run=measurementRun()):void {run.probe.memory(measurementContext(run.collector),{name:'tracked-host-buffer-capacity',scope:'host',method:'unique-backing-buffer-ledger',quality:'measured-capacity',availability:'available',bytes:run.buffers.bytes,sampleDelayMs:0});}
const releaseNothing=()=>{};
export function trackHostBuffers(role:string,values:Iterable<ArrayBufferLike|ArrayBufferView>,run=measurementRun(),providedContext?:TraceContext):(to?:string)=>void {
  if(run.collector.mode==='off')return releaseNothing;
  const context=providedContext??measurementContext(run.collector);
  const owner=run.newOwner(role),unique=new Set<ArrayBufferLike>();for(const value of values)unique.add(ArrayBuffer.isView(value)?value.buffer:value);
  const rows=[...unique].map(buffer=>({id:run.buffers.retain(buffer,owner),bytes:buffer.byteLength}));
  for(const row of rows)run.probe.event(context,{kind:'counter',name:'resource.acquire',resource:{id:`${context.runId}:host:${row.id}`,action:role.endsWith('copy')?'copy':'acquire',owner,bytes:row.bytes},workload:{buffers:1,referencedBytes:row.bytes}});
  sampleHostBuffers(run);let released=false;
  return (to?:string)=>{if(released)return;released=true;for(const row of rows){run.buffers.releaseId(row.id,owner);run.probe.event(context,{kind:'counter',name:to?'resource.transfer':'resource.release',resource:{id:`${context.runId}:host:${row.id}`,action:to?'transfer':'release',owner,bytes:row.bytes,...(to?{to}:{})},workload:{buffers:1,referencedBytes:row.bytes}});}sampleHostBuffers(run);};
}
export function recordLegacyPhase(identity: { taskId: string; sourcePath: string; domain: 'dev' | 'ifc'; lod?: number }, phase: string, ms: number, status: 'completed' | 'failed' | 'cancelled', bytes?: number): void {
  if(current.collector.mode==='off')return;
  const context = { ...measurementContext(), taskId: identity.taskId, sourceId: measurementSourceId(identity.sourcePath), geometryLod: identity.lod ?? null };
  current.probe.event(context, { kind: 'phase', name: `host.${phase}`, timing: 'aggregate', durationMs: ms, status,
    workload: bytes === undefined ? undefined : { bytes } });
}
