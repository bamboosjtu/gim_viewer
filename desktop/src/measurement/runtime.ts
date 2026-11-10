import { Collector, Probe, BufferLedger, type MeasurementMode, type RunIdentity, type TraceContext, type MemoryMetric } from './core.js';
import {operationTraceId,captureContext} from './core.js';

interface MeasurementConfig { mode?: MeasurementMode; runId?: string; sampleId?: string; sourceSha256?: string; buildId?: string; }
const globals = globalThis as typeof globalThis & { __GIM_MEASUREMENT_CONFIG__?: MeasurementConfig };
let serial = 0;
let onCollector:((collector:Collector)=>void)|undefined;
export function observeMeasurementCollectors(observer:(collector:Collector)=>void):void {onCollector=observer;observer(current.collector);}
const archives = new Map<string, Collector>();
const privateSourceIds = new WeakMap<Collector, Map<string, string>>();
const hostBuffers=new WeakMap<Collector,BufferLedger>();
const probes=new WeakMap<Collector,Probe>();
const runtimes=new WeakMap<Collector,{collector:Collector;probe:Probe;buffers:BufferLedger;newOwner:(role:string)=>string}>();
const hostClockId='host-clock-'+performance.timeOrigin;
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
  const probe = new Probe(`${run.runId}:host`, hostClockId, mode, () => performance.now(), collector,'host');
  probes.set(collector,probe);
  archives.set(run.runId, collector);
  while (archives.size > 16) archives.delete(archives.keys().next().value!);
  const runtime={ collector, probe,buffers,newOwner:(role:string)=>`${role}-${++ownerSequence}` };runtimes.set(collector,runtime);return runtime;
}
let current = createRun();
export function measurementRun() { return current; }
export function measurementRuntime(runId:string){const collector=archives.get(runId);return collector?runtimes.get(collector):undefined;}
export function measurementCollector(runId:string){return archives.get(runId);}
export function measurementProbe(runId:string){const collector=archives.get(runId);return collector?probes.get(collector):undefined;}
let operationSequence=0;
interface OperationState {root:TraceContext;ended:boolean;children:Set<TraceContext>}
const operations=new WeakMap<Collector,OperationState>();
const operationEnded=new Set<()=>void>();
export function observeMeasurementOperationEnd(listener:()=>void){operationEnded.add(listener);return ()=>operationEnded.delete(listener);}
export function beginMeasurementOperation(name:string,run=current){
  const existing=operations.get(run.collector);
  const parent=existing&&!existing.ended?existing.root:undefined;
  const sequence=++operationSequence;
  const context=captureContext({...measurementContext(run.collector),
    operationTraceId:parent?.operationTraceId??operationTraceId(run.collector.identity.runId+':operation-'+sequence),
    executorId:'host',scopeId:run.collector.identity.runId+':scope-'+sequence});
  // Default host work stays owned by the root. Concurrent actions have explicit
  // captured child scopes; an implicit "last active" child cannot steal it.
  const child=parent?run.probe.phase(context,'operation.'+name):undefined;
  const captured=child?.context??context;
  const state=parent?existing!:{root:captured,ended:false,children:new Set<TraceContext>()};
  if(parent)state.children.add(captured);else operations.set(run.collector,state);
  const started=performance.now();
  if(!parent)run.probe.trace(captured,{type:'operation',action:'started',id:captured.operationTraceId!,name});
  const capabilities=['operation-context','span-lifecycle','dependency-edges','wait-intervals','clock-segments'] as const;
  for(const declaration of ['requested','effective'] as const)run.probe.trace(captured,{type:'scope',action:'declared',scope:{
    scopeId:captured.scopeId!,...(parent?{parentScopeId:parent.scopeId}:{}),scopeType:declaration==='requested'?'operation':'executor',declaration,
    operationTraceId:captured.operationTraceId,executorId:'host',capabilities,
    window:{clockId:run.probe.clockId,startMs:started,endMs:null}}});
  let ended=false;
  return {context:captured,end(){if(ended)return;ended=true;
    if(child){child.end();state.children.delete(captured);}
    else{state.ended=true;run.probe.trace(captured,{type:'operation',action:'ended',id:captured.operationTraceId!,name});
      if(state.children.size)run.probe.trace(captured,{type:'health',action:'operation-ended-with-open-children',value:state.children.size});
      for(const listener of operationEnded)try{listener();}catch{/* Diagnostics never decide business completion. */}}
    run.probe.trace(captured,{type:'scope',action:'closed',id:captured.scopeId,endMs:performance.now()});
    if(state.ended&&!state.children.size&&operations.get(run.collector)===state)operations.delete(run.collector);}};
}
export function markMeasurementCancellation(reasonCode:'project-closed'|'project-replaced'):void {
  const run=measurementRun();run.probe.event(measurementContext(run.collector),{
    kind:'counter',name:'lifecycle.cancel-requested',reasonCode,workload:{requests:1},
  });
}
let openOperation:ReturnType<typeof beginMeasurementOperation>|undefined;
export function openMeasurementContext(){return openOperation?.context;}
export function finishMeasurementOperation(){openOperation?.end();openOperation=undefined;}
export function resetMeasurementRun(identity: Partial<RunIdentity>): void {
  finishMeasurementOperation();current = createRun(identity);
  if(current.collector.mode==='diagnostic')openOperation=beginMeasurementOperation('project.open');
}
export function updateMeasurementIdentity(identity: Partial<RunIdentity>): void {
  const target = current.collector.identity;
  if('runId'in identity&&identity.runId!==target.runId)throw Error('measurement-run-identity-changed');
  if (identity.sourceSha256 && target.sourceSha256 && identity.sourceSha256 !== target.sourceSha256) throw Error('measurement-source-identity-changed');
  Object.assign(target, identity);
}
export function measurementContext(collector = current.collector): TraceContext {
  const session=readSession?.();
  const scope=session&&session.generation===collector.identity.generation?session:{};
  const state=operations.get(collector),operation=state&&!state.ended?state.root:undefined;
  return { ...collector.identity, ...scope,...(operation?{operationTraceId:operation.operationTraceId,scopeId:operation.scopeId}:{}), workerId: 'host', family: 'host', backend: 'host',executorId:'host', taskId: null,
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
  const batched=rows.length>8&&run.collector.mode!=='diagnostic';
  const referencedBytes=rows.reduce((sum,row)=>sum+row.bytes,0);
  const batchId=`${context.runId}:host:batch:${owner}`;
  if(batched)run.probe.event(context,{kind:'counter',name:'resource.acquire',resource:{id:batchId,action:role.endsWith('copy')?'copy':'acquire',owner,bytes:referencedBytes},workload:{buffers:rows.length,referencedBytes}});
  else for(const row of rows)run.probe.event(context,{kind:'counter',name:'resource.acquire',resource:{id:`${context.runId}:host:${row.id}`,action:role.endsWith('copy')?'copy':'acquire',owner,bytes:row.bytes},workload:{buffers:1,referencedBytes:row.bytes}});
  sampleHostBuffers(run);let released=false;
  return (to?:string)=>{if(released)return;released=true;for(const row of rows){
    if(to){run.buffers.transferId(row.id,owner,to);run.buffers.releaseId(row.id,to);}
    else run.buffers.releaseId(row.id,owner);
  }
    if(batched)run.probe.event(context,{kind:'counter',name:to?'resource.transfer':'resource.release',resource:{id:batchId,action:to?'transfer':'release',owner,bytes:referencedBytes,...(to?{to}:{})},workload:{buffers:rows.length,referencedBytes}});
    else for(const row of rows)run.probe.event(context,{kind:'counter',name:to?'resource.transfer':'resource.release',resource:{id:`${context.runId}:host:${row.id}`,action:to?'transfer':'release',owner,bytes:row.bytes,...(to?{to}:{})},workload:{buffers:1,referencedBytes:row.bytes}});
    sampleHostBuffers(run);};
}
export function recordLegacyPhase(identity: { taskId: string; sourcePath: string; domain: 'dev' | 'ifc'; lod?: number }, phase: string, ms: number, status: 'completed' | 'failed' | 'cancelled', bytes?: number): void {
  if(current.collector.mode==='off')return;
  const context = { ...measurementContext(), taskId: identity.taskId, sourceId: measurementSourceId(identity.sourcePath), geometryLod: identity.lod ?? null };
  current.probe.event(context, { kind: 'phase', name: `host.${phase}`, timing: 'aggregate', durationMs: ms, status,
    workload: bytes === undefined ? undefined : { bytes } });
}
