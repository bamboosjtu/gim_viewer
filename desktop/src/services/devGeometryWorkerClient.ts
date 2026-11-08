import measuredWorkerAsset from './devGeometryWorker.ts?worker&url';
import { createMeasuredWorker, measurementWorkerUrl,measurementWorkerTask,markMeasuredWorkerTaskCancellation } from '../measurement/hostWorker.js';
import {OutputResources} from '../measurement/outputResources.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import { DEV_GLB_MAX_BYTES, aggregateDevGlbDiagnostics, type DevGeometryCompilePlan, type DevGlbSerializationResult } from './glbCacheService.js';
import type { DiscoveredGeometries } from './modGeometryDiscovery.js';
import type { DeviceLod } from '../viewer/xmlModGeometry.js';
import type { DevSourceBounds } from './devSpatialCatalog.js';
import { InvalidDevGeometryError,MissingDevDependencyError } from '../gim/geometry/sourceGeometryError.js';
import { perfCurrentSession, perfMark, perfRecordTaskPhase, perfMeasureTaskPhase, type PerfTaskIdentity } from '../utils/perfTimings.js';
import { beginDevGeometryWork, hasCompletedIfcWork, ifcGeometryBusy, onGeometryWorkAvailable, geometryWorkSnapshot } from '../viewer/geometryWorkGate.js';
import { agedWorkPriority } from '../utils/workPriority.js';
import type { MemoryPressure } from '../utils/memoryPressure.js';
interface SplitState {
  measuredOwners?:string[];
  plan: DevGeometryCompilePlan;
  results: Array<DevGlbSerializationResult | undefined>;
  completed: number;
  fallbackTried: boolean;
  heldBytes: number;
  mergeReservation: number;
  admitted: boolean;
  inputBudget: number;
  reservation: number;
}
interface Slot { id: number; traceId: string; key: string; path: string; kind: 'compile' | 'bounds' | 'merge'; lod: DeviceLod; priority: number; queuedAt: number;
  measuredInputs?:string[];
  measuredContext?:import('../measurement/core.js').TraceContext;
  promise: Promise<any>; resolve: (value: any) => void; reject: (error: Error) => void;
  /** Assembly-subtree child of a split template. */
  parent?: string;
  partition?: { referencePaths: readonly string[]; canonicalDevPath: string; discovered: DiscoveredGeometries; maxBytes: number; allowSmallFallback?: boolean; rootSlice?:{index:number;total:number} };
  /** A merge fallback must use the monolithic compiler, never split again. */
  noSplit?: boolean;
  /** Parent-only state while real subtree parts are in flight. */
  split?: SplitState;
  /** Pending part buffers handed to the merge worker once. */
  mergeParts?: Uint8Array[];
  settled?: boolean;
}
const clients = new WeakMap<AppState, DevGeometryPreprocessor>();
let serial = 0;
const IDLE_POOL_TIMEOUT_MS = 30_000;
const SPLIT_MERGE_INPUT_BUDGET = 64 * 1024 * 1024;
const SPLIT_POOL_RESERVATION_BUDGET = 3 * SPLIT_MERGE_INPUT_BUDGET;
/** Computation slots and unacknowledged results have separate lifetimes.
 * Ordinary results use 64 MiB backpressure. One admitted split parent reserves
 * completion space from a 192 MiB pool envelope after deducting unconsumed
 * results; its inputs stay <=64 MiB and each final result <=128 MiB.
 * These are managed-byte/transfer policies, never a bound on Worker heap. */
export class DevGeometryPreprocessor {
  private workers: Worker[] = [];
  private slots = new Map<string, Slot>();
  private active = new Map<Worker, { task: Slot; release: (() => void) | null; finished: boolean; startedAt: number }>();
  private exported = new Map<string, { task: Slot; bytes: number }>();
  private exportedBytes = 0;
  private outputResources=new OutputResources();
  private exportedPeakBytes = 0;
  private splitHeldBytes = 0;
  private mergeReservedBytes = 0;
  /** One parent owns Part -> merge -> fallback admission. Waiting plans hold no GLBs. */
  private splitOwner: Slot | null = null;
  private stopped = false;
  private paused = false;
  private memoryPressure: MemoryPressure = 'unknown';
  private targetWorkerCount = 1;
  private memoryShrunk = false;
  private idleCompacted = false;
  private lastUsedWorker: Worker | null = null;
  private sequence = 0;
  private readonly session = ++serial;
  private readonly perf = perfCurrentSession();
  private replacements=0;
  /** Advisory source affinity: reuse one worker's bounded parse caches across
   * LODs without allowing affinity to block unrelated work. */
  private sourceAffinity = new Map<string, Worker>();
  private terminalError:Error|null=null;
  private watchdog: ReturnType<typeof setInterval>;
  private unsubscribeGate: () => void;
  private lastProgressAt = performance.now();
  private idleSince: number | null = performance.now();
  private trackIdle(now = performance.now()): void {
    if (this.active.size || this.slots.size || this.exported.size) this.idleSince = null;
    else this.idleSince ??= now;
  }
  constructor(_paths: string[], private files: Map<string, File>, private current: () => boolean) {
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const cores = navigator.hardwareConcurrency || 4;
    // DEV 编译是 CPU 密集任务：按逻辑核数的 60% 给 Worker（最多 8 个），
    // 给 UI/渲染留出余量；低内存机器仍保守。gim-dev-workers 可覆盖。
    let override = Number.NaN;
    try { override = Number(localStorage.getItem('gim-dev-workers')); } catch { /* storage unavailable */ }
    const memoryCap = memory != null && memory < 4 ? 2 : 8;
    const auto = Math.max(2, Math.min(memoryCap, Math.floor(cores * 0.6)));
    const count = Number.isFinite(override) && override >= 1 && override <= 8 ? Math.floor(override) : auto;
    this.targetWorkerCount = count;
    for (let i = 0; i < count; i++) {
      this.addWorker(count);
    }
    this.unsubscribeGate = onGeometryWorkAvailable(() => { if (!this.stopped) this.pump(); });
    this.watchdog = setInterval(() => this.checkProgress(), 10_000);
  }
  private checkProgress(): void {
    if (this.stopped) return;
    if (!this.current()) { this.cancel(); return; }
    const now = performance.now();
    this.trackIdle(now);
    // Rendered templates belong to the main-thread runtime. Once all pool
    // work and result consumption are done, retain only the most recent
    // source cache; new computation restores the configured capacity.
    if (this.idleSince !== null && now - this.idleSince >= IDLE_POOL_TIMEOUT_MS && this.workers.length > 1) {
      const keep = this.lastUsedWorker && this.workers.includes(this.lastUsedWorker)
        ? this.lastUsedWorker : this.workers[this.workers.length - 1];
      for (const worker of [...this.workers]) if (worker !== keep) {
        worker.terminate(); this.workers = this.workers.filter(value => value !== worker);
        for (const [path, owner] of this.sourceAffinity) if (owner === worker) this.sourceAffinity.delete(path);
        this.diagnostics.idleWorkerReclaims++;
      }
      this.diagnostics.idlePoolShrinks++;
      this.lastUsedWorker = keep;
      this.memoryShrunk = true;
      this.idleCompacted = true;
      this.onActivity();
    }
    if ((this.slots.size || this.exported.size) && now - this.lastProgressAt >= 10_000) {
      this.diagnostics.stallSnapshots++;
      perfMark('DEV waiting snapshot', this.schedulingSnapshot(), this.perf);
    }
    for (const [worker, owner] of [...this.active]) {
      if (now - owner.startedAt >= 120_000) {
        this.diagnostics.timedOutTasks++;
        this.workerFailed(worker, new Error(`DEV task timed out after 120000ms: ${owner.task.path} (${owner.task.kind}, LOD${owner.task.lod})`));
      }
    }
  }
  schedulingSnapshot() {
    const now = performance.now();
    const running = new Set([...this.active.values()].map(row => row.task.key));
    const queued = [...this.slots.values()].filter(row => !running.has(row.key));
    return { session: this.session, workers: this.workerCount, active: this.active.size,
      queued: queued.length, oldestQueuedMs: queued.reduce((max, row) => Math.max(max, now - row.queuedAt), 0),
      paused: this.paused, memoryPressure: this.memoryPressure, idleWorkerReclaims: this.diagnostics.idleWorkerReclaims, results: this.resultPressure, gate: geometryWorkSnapshot(),
      targetWorkers: this.targetWorkerCount, idlePoolShrinks: this.diagnostics.idlePoolShrinks,
      idleCompacted: this.idleCompacted,
      splitCompiles: this.diagnostics.splitCompiles, splitParts: this.diagnostics.splitParts,
      splitMerges: this.diagnostics.splitMerges, splitFallbacks: this.diagnostics.splitFallbacks,
      idleMs: this.idleSince === null ? 0 : Math.max(0, now - this.idleSince),
      tasks: [...this.active.values()].slice(0, 8).map(({ task, startedAt }) => ({ id: task.id,
        path: task.path, lod: task.lod, kind: task.kind, priority: task.priority, elapsedMs: now - startedAt })) };
  }
  private addWorker(count:number):void {
      const worker = createMeasuredWorker('dev', identity => new Worker(measurementWorkerUrl(measuredWorkerAsset,identity), {type:'module',...(identity?{name:identity}:{})}));
      worker.onmessage = ({ data }) => { void this.receive(worker, data).catch(error => this.workerFailed(worker,error instanceof Error ? error : new Error(String(error)))); };
      worker.onerror = event => {event.preventDefault?.();this.workerFailed(worker,new Error(event.message || 'DEV geometry worker failed'));};
      worker.onmessageerror = () => this.workerFailed(worker,new Error('DEV geometry worker message could not be decoded'));
      // File/Blob is immutable and structured-clonable: share its backing store,
      // rather than routing thousands of small in-memory reads through the UI.
      // Disk-backed File shims retain the authorized read RPC path.
      try {worker.postMessage({ kind: 'init', cacheDivisor: count, files: [...this.files].filter(([p]) => /\.(dev|phm|mod|stl|gl)$/i.test(p)).map(([p, f]) => [p, f.size, f instanceof File ? f : null]) });}
      catch(error){worker.terminate();throw error;}
      this.workers.push(worker);
  }
  private workerFailed(worker:Worker,error:Error):void {
    if(this.stopped||!this.workers.includes(worker))return;
    worker.terminate();this.workers=this.workers.filter(row=>row!==worker);
    if (this.lastUsedWorker === worker) this.lastUsedWorker = null;
    for (const [path, owner] of this.sourceAffinity) if (owner === worker) this.sourceAffinity.delete(path);
    const owner=this.active.get(worker);this.active.delete(worker);owner?.release?.();
    if(owner){
      perfRecordTaskPhase(this.taskIdentity(owner.task), 'workerWall', performance.now() - owner.startedAt, this.perf, 'failed');
      this.slots.delete(owner.task.key);this.diagnostics.failedTasks++;owner.task.reject(error);
    }
    // Bounded pool repair: a failed source is surfaced as a normal task error,
    // never an AbortError that the runtime would silently requeue forever.
    if(this.current()&&this.replacements<1){this.replacements++;try{this.addWorker(Math.max(1,this.workers.length+1));}catch{/* Healthy workers can drain the queue. */}}
    if(!this.workers.length){this.terminalError=error;this.cancel(error);}else this.pump();
    this.onActivity();
  }
  get workerCount(): number { return this.workers.length; }
  /** Idle computation threads do not limit warm reads. Pressure retains the
   * existing lower consumption limit instead of reopening a large batch. */
  get cacheConcurrency(): number {
    const unpressured = this.memoryPressure === 'normal' || this.memoryPressure === 'unknown';
    return Math.max(8, (this.idleCompacted && unpressured ? this.targetWorkerCount : this.workerCount) * 8);
  }
  private taskIdentity(task: Slot): PerfTaskIdentity {
    return {taskId: task.traceId, domain: 'dev', sourcePath: task.path, kind: task.kind,
      lod: task.lod, priority: task.priority, cacheSource: task.kind === 'bounds' ? 'source' : 'compiled', generation: this.perf.generation,
      workerSession: this.session, workerTaskId: task.id};
  }
  private createSlot(kind: Slot['kind'], path: string, lod: DeviceLod, key: string, priority: number,
    traceId?: string, extra: Partial<Slot> = {}): { task: Slot; promise: Promise<any> } {
    let resolve!: Slot['resolve'], reject!: Slot['reject'];
    const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
    const id = ++this.sequence;
    const task: Slot = { id, traceId: traceId ?? `${this.perf.id}:dev-worker:${this.session}:${id}`, key, path, kind, lod, priority,
      queuedAt: performance.now(), promise, resolve, reject };
    Object.assign(task, extra);
    this.slots.set(key, task);
    return { task, promise };
  }
  private childrenOf(key: string): Slot[] {
    return [...this.slots.values()].filter(task => task.parent === key);
  }
  /** Reject one task and its split children. Active subtree workers are
   * terminated only for an explicit cancellation, not for a source failure
   * that already has a definite result. */
  private cancelTaskTree(task: Slot, reason: Error, terminateActive: boolean): void {
    if (task.settled) return;
    task.settled = true;
    this.slots.delete(task.key);
    if(task.split)this.releaseSplitBuffers(task.split);
    this.releaseSplitAdmission(task);
    task.mergeParts = undefined;
    for(const owner of task.measuredInputs??[])this.outputResources.release(owner,'cancelled');task.measuredInputs=[];
    for (const child of this.childrenOf(task.key)) this.cancelTaskTree(child, reason, terminateActive);
    if (terminateActive) {
      for (const [worker, owner] of [...this.active]) {
        if (owner.task !== task) continue;
        this.active.delete(worker);
        owner.release?.(); owner.release = null;
        if(reason.name==='AbortError')markMeasuredWorkerTaskCancellation(worker,owner.task.traceId,'request-superseded');
        worker.terminate();
        this.workers = this.workers.filter(value => value !== worker);
        if (this.lastUsedWorker === worker) this.lastUsedWorker = null;
        for (const [path, value] of this.sourceAffinity) if (value === worker) this.sourceAffinity.delete(path);
        if (!this.stopped && this.current()) {
          try { this.addWorker(this.workers.length + 1); } catch { /* healthy workers drain */ }
        }
      }
    }
    task.reject(reason);
  }
  private releaseSplitBuffers(split:SplitState):void {
    for(const owner of split.measuredOwners??[])this.outputResources.release(owner,'discarded');split.measuredOwners=[];
    this.splitHeldBytes-=split.heldBytes;split.heldBytes=0;split.results=[];
    this.mergeReservedBytes-=split.mergeReservation;split.mergeReservation=0;
  }
  private updatePeak():void {this.exportedPeakBytes=Math.max(this.exportedPeakBytes,this.resultPressure.bytes);this.outputResources.budget(this.mergeReservedBytes);}
  private releaseSplitAdmission(parent: Slot): void {
    if (parent.split) parent.split.reservation = 0;
    if (this.splitOwner === parent) this.splitOwner = null;
  }
  private startSplit(task: Slot, plan: DevGeometryCompilePlan): void {
    if (task.settled) return;
    if (plan.parts.length < 2) { this.cancelTaskTree(task, new Error('DEV split plan has fewer than two parts'), false); return; }
    task.split = { plan, results: new Array(plan.parts.length), completed: 0, fallbackTried: false,
      heldBytes:0,mergeReservation:0,admitted:false,inputBudget:0,reservation:0 };
    this.diagnostics.splitCompiles++;
  }
  private admitNextSplit(): void {
    if (this.splitOwner || this.exportedBytes >= SPLIT_MERGE_INPUT_BUDGET
      || this.exported.size >= this.workerCount * 2) return;
    // Drain already-running ordinary compiles before reserving their unknown
    // output space. New ordinary compiles wait while a split plan is pending.
    if ([...this.active.values()].some(row => row.task.kind !== 'bounds')) return;
    const now = performance.now();
    const parent = [...this.slots.values()].filter(row => row.split && !row.split.admitted && !row.settled)
      .sort((a,b) => agedWorkPriority(a.priority,a.queuedAt,now)-agedWorkPriority(b.priority,b.queuedAt,now) || a.id-b.id)[0];
    if (!parent) return;
    const split = parent.split!;
    split.reservation = SPLIT_POOL_RESERVATION_BUDGET - this.exportedBytes;
    split.inputBudget = Math.min(SPLIT_MERGE_INPUT_BUDGET, Math.floor(split.reservation / 3));
    split.admitted = true;
    this.splitOwner = parent;
    if(this.memoryPressure==='high'||this.memoryPressure==='critical'){
      this.fallbackSplit(parent,new Error('DEV split disabled under memory pressure'),false);return;
    }
    split.plan.parts.forEach((part, index) => {
      const partKey = `${parent.key}::part${index}`;
      const child = this.createSlot('compile', parent.path, parent.lod, partKey, parent.priority, undefined, {
        parent: parent.key,
        partition: {
          referencePaths: part.referencePaths,
          canonicalDevPath: split.plan.canonicalDevPath,
          discovered: { mods: part.mods, stls: part.stls },
          maxBytes: Math.floor(split.inputBudget/split.plan.parts.length),
          ...(part.rootSlice?{rootSlice:part.rootSlice}:{}),
        },
      });
      this.diagnostics.splitParts++;
      child.promise.then(
        result => this.partFinished(parent, index, result),
        error => this.partFailed(parent, error),
      );
    });
  }
  private partFinished(parent: Slot, index: number, result: DevGlbSerializationResult): void {
    const split = parent.split;
    if (!split || parent.settled || split.results[index]) return;
    const bytes=result.bytes?.byteLength??0;
    if(result.bytes){const owner=`part:${parent.traceId}:${index}`;this.outputResources.hold(owner,result.bytes,{...this.taskIdentity(parent),context:parent.measuredContext},'part');(split.measuredOwners??=[]).push(owner);}
    split.heldBytes+=bytes;this.splitHeldBytes+=bytes;this.updatePeak();
    if(split.heldBytes>split.inputBudget){
      this.fallbackSplit(parent,new Error(`DEV split merge input exceeds reserved budget (${split.inputBudget} bytes)`));return;
    }
    split.results[index] = result;
    split.completed++;
    if (split.completed < split.plan.parts.length){this.pump();return;}
    const results = split.results.filter((row): row is DevGlbSerializationResult => !!row);
    const combinedParts=results.map(row=>!row.bytes&&row.smallFallback&&row.diagnostics.emptySourceCount===0
      &&row.diagnostics.unsupportedSourceCount===0&&row.diagnostics.partialSourceCount===0
      ? {...row,status:'complete' as const,diagnostics:{...row.diagnostics,status:'complete' as const}}:row);
    const diagnostics = aggregateDevGlbDiagnostics(combinedParts);
    diagnostics.discoveredModCount=split.plan.modCount;
    diagnostics.discoveredStlCount=split.plan.stlCount;
    if(split.plan.parts.some(part=>part.rootSlice)){
      const represented=results.some(row=>!!row.bytes);
      const partial=results.some(row=>row.status==='partial');
      const unsupported=results.some(row=>row.status==='unsupported');
      diagnostics.renderableModCount=represented?1:0;
      diagnostics.emptySourceCount=represented?0:results.every(row=>row.status==='empty')?1:0;
      diagnostics.unsupportedSourceCount=unsupported?1:0;
      diagnostics.partialSourceCount=partial?1:0;
      diagnostics.status=unsupported&&!represented?'unsupported':partial||unsupported?'partial':represented?'complete':'empty';
    }
    const parts = results.flatMap(row => row.bytes ? [row.bytes] : []);
    const totalBytes = parts.reduce((total, bytes) => total + bytes.byteLength, 0);
    if (!parts.length) {
      if(this.memoryPressure==='high'||this.memoryPressure==='critical'){
        this.fallbackSplit(parent,new Error('DEV split outline deferred under memory pressure'));return;
      }
      const candidates=results.flatMap(row=>row.smallFallback?[row.smallFallback]:[])
        .sort((a,b)=>b.extent-a.extent||(a.referencePath<b.referencePath?-1:a.referencePath>b.referencePath?1:0));
      if(candidates.length){
        const candidate=candidates[0],edge=split.plan.parts.flatMap(part=>part.mods)
          .find(mod=>(mod.referencePath||mod.instanceKey)===candidate.referencePath);
        if(!edge){this.cancelTaskTree(parent,new Error('DEV split outline candidate lost its source occurrence'),false);this.pump();return;}
        this.releaseSplitBuffers(split);
        const outline=this.createSlot('compile',parent.path,parent.lod,`${parent.key}::outline`,parent.priority,undefined,{
          parent:parent.key,partition:{referencePaths:[candidate.referencePath],canonicalDevPath:split.plan.canonicalDevPath,
            discovered:{mods:[edge],stls:[]},maxBytes:split.inputBudget,allowSmallFallback:true},
        });
        outline.promise.then(result=>{
          const recovered={status:result.status,discoveredModCount:0,discoveredStlCount:0,
            renderableModCount:result.diagnostics.renderableModCount,renderableStlCount:result.diagnostics.renderableStlCount,
            emptySourceCount:0,unsupportedSourceCount:0,partialSourceCount:0,unsupportedPrimitiveTypeCounts:{}};
          const summary=aggregateDevGlbDiagnostics([...combinedParts,{...result,diagnostics:recovered}]);
          this.finishSplit(parent,{...result,status:summary.status,diagnostics:summary});
        },error=>this.partFailed(parent,error));
        this.pump();return;
      }
      this.finishSplit(parent, { status: diagnostics.status, bytes: null, diagnostics });
      return;
    }
    if (this.memoryPressure==='high'||this.memoryPressure==='critical'){
      this.fallbackSplit(parent,new Error('DEV split merge deferred under memory pressure'));return;
    }
    split.results = []; // buffers move to the merge worker; results are no longer needed
    this.splitHeldBytes-=split.heldBytes;split.heldBytes=0;
    split.mergeReservation=totalBytes*3;this.mergeReservedBytes+=split.mergeReservation;this.updatePeak();
    const merge = this.createSlot('merge', parent.path, parent.lod, `${parent.key}::merge`, parent.priority, undefined,
      { parent: parent.key, mergeParts: parts,measuredInputs:split.measuredOwners });
    split.measuredOwners=[];
    this.diagnostics.splitMerges++;
    merge.promise.then(
      merged => this.finishSplit(parent, { status: diagnostics.status, bytes: merged?.bytes ?? null,sha256:merged?.sha256, diagnostics }),
      error => this.mergeFailed(parent, error),
    );
    this.pump();
  }
  private partFailed(parent: Slot, error: unknown): void {
    if (parent.settled) return;
    if(parent.split?.fallbackTried)return;
    const reason = error instanceof Error ? error : new Error(String(error));
    if(/split part exceeds reserved output budget/.test(reason.message)){
      this.fallbackSplit(parent,reason);return;
    }
    this.cancelTaskTree(parent, reason, true);
    this.pump();
  }
  private fallbackSplit(parent:Slot,reason:Error,reschedule=true):void {
    const split=parent.split;
    if(!split||parent.settled||split.fallbackTried)return;
    split.fallbackTried=true;this.diagnostics.splitFallbacks++;
    this.releaseSplitBuffers(split);
    for(const child of this.childrenOf(parent.key))this.cancelTaskTree(child,reason,true);
    const fallback=this.createSlot('compile',parent.path,parent.lod,`${parent.key}::fallback`,parent.priority,undefined,
      {parent:parent.key,noSplit:true});
    fallback.promise.then(result=>this.finishSplit(parent,result),error=>{
      if(!parent.settled)this.cancelTaskTree(parent,error instanceof Error?error:new Error(String(error)),false);
      this.pump();
    });
    if(reschedule)this.pump();
  }
  private mergeFailed(parent: Slot, error: unknown): void {
    const split = parent.split;
    if (!split || parent.settled) return;
    if (split.fallbackTried) {
      this.cancelTaskTree(parent, error instanceof Error ? error : new Error(String(error)), false);
      this.pump();
      return;
    }
    // A merge failure is a merge-machinery problem, not a source failure. Fall
    // back once to the established monolithic compiler so a huge DEV still
    // renders; this path is rare and never used for normal templates.
    split.fallbackTried = true;
    this.diagnostics.splitFallbacks++;
    this.releaseSplitBuffers(split);
    const fallback = this.createSlot('compile', parent.path, parent.lod, `${parent.key}::fallback`, parent.priority, undefined,
      { parent: parent.key, noSplit: true });
    fallback.promise.then(
      result => this.finishSplit(parent, result),
      reason => {
        if (parent.settled) return;
        this.cancelTaskTree(parent, reason instanceof Error ? reason : new Error(String(reason)), false);
        this.pump();
      },
    );
    this.pump();
  }
  private finishSplit(parent: Slot, result: DevGlbSerializationResult): void {
    if (parent.settled) return;
    parent.settled = true;
    this.slots.delete(parent.key);
    if(parent.split)this.releaseSplitBuffers(parent.split);
    this.releaseSplitAdmission(parent);
    parent.split = undefined;
    if (result.bytes) {
      this.outputResources.hold(`output:${parent.key}`,result.bytes,{...this.taskIdentity(parent),context:parent.measuredContext},'output');
      this.exported.set(parent.key, { task: parent, bytes: result.bytes.byteLength });
      this.exportedBytes += result.bytes.byteLength;
      this.updatePeak();
    }
    this.lastProgressAt = performance.now();
    parent.resolve(result);
    this.pump();
  }
  readonly diagnostics = {
    reads: 0, rpcReads: 0, sourceHits: 0, documentHits: 0,
    readRpcMs: 0, decodeMs: 0, parseMs: 0, queueWaitMs: 0,
    boundsTasks: 0, compileTasks: 0, failedTasks: 0,
    splitCompiles: 0, splitParts: 0, splitMerges: 0, splitFallbacks: 0,
    timedOutTasks: 0, stallSnapshots: 0, idleWorkerReclaims: 0, idlePoolShrinks: 0,
    sourceAffinityHits: 0, sourceAffinityDeferrals: 0,
    stages: {} as Record<string, { count: number; totalMs: number; maxMs: number }>,
  };
  private readonly queueByTemplate = new Map<string,{waitMs:number;dispatches:number}>();
  takeWorkerQueueStats(key:string):{waitMs:number;dispatches:number}|null{
    const row=this.queueByTemplate.get(key)??null;this.queueByTemplate.delete(key);return row;
  }
  get resultPressure() { return { bytes: this.exportedBytes+this.splitHeldBytes+this.mergeReservedBytes,
    peakBytes: this.exportedPeakBytes, count: this.exported.size,
    splitOwner: this.splitOwner?.key ?? null,
    splitReservationBytes: this.splitOwner?.split?.reservation ?? 0,
    admittedBytes: this.exportedBytes + (this.splitOwner?.split?.reservation ?? 0),
    splitPoolBudgetBytes: SPLIT_POOL_RESERVATION_BUDGET }; }
  get activePaths(): string[] { return [...this.active.values()].map(row => `${row.task.path} · ${row.finished ? '提交' : row.task.kind === 'bounds' ? '目录' : row.task.kind === 'merge' ? '合并' : `LOD${row.task.lod}`}`); }
  /** Upgrade authorized lazy sources without replacing active computation or
   * evicting its parse caches. Immutable Files share their backing storage. */
  installSources(files: Map<string, File>): void {
    if (this.stopped || !this.current()) return;
    const loaded = [...files].filter(([path, file]) => file instanceof File && file !== this.files.get(path));
    if (!loaded.length) return;
    for (const [path, file] of loaded) this.files.set(path, file);
    for (const worker of [...this.workers]) {
      try {worker.postMessage({kind:'sources', files:loaded.map(([path, file])=>[path,file.size,file])});}
      catch(error){this.workerFailed(worker,error instanceof Error ? error : Error(String(error)));}
    }
  }
  onActivity: () => void = () => {};
  setPaused(value: boolean): void { this.paused = value; this.pump(); }
  setMemoryPressure(pressure: MemoryPressure): void {
    this.memoryPressure = pressure;
    this.trimIdleWorkers();
    this.pump();
  }
  private trimIdleWorkers(): void {
    if (this.memoryPressure !== 'critical') return;
    for (const worker of [...this.workers]) {
      if (this.workers.length <= Math.max(1, this.active.size) || this.active.has(worker)) continue;
      worker.terminate();
      this.workers = this.workers.filter(value => value !== worker);
      if (this.lastUsedWorker === worker) this.lastUsedWorker = null;
      for (const [path, owner] of this.sourceAffinity) if (owner === worker) this.sourceAffinity.delete(path);
      this.diagnostics.idleWorkerReclaims++; this.memoryShrunk = true; this.idleCompacted = false;
    }
  }
  private pump(): void {
    if (!this.current()) { this.cancel(); return; }
    if (this.stopped) return;
    this.admitNextSplit();
    this.trimIdleWorkers();
    if (this.memoryShrunk && (this.memoryPressure === 'normal' || this.memoryPressure === 'unknown') && this.slots.size) {
      let demand = this.targetWorkerCount;
      if (this.idleCompacted) {
        demand = 0;
        const pressured = this.resultPressure.bytes >= 64 * 1024 * 1024 || this.exported.size >= this.workerCount * 2;
        for (const task of this.slots.values()) {
          // Paused/background or backpressured compiles are not demand for
          // new threads. Bounds and explicit user work remain eligible.
          if (task.kind === 'compile' && (pressured || this.paused && task.lod > 0 && task.priority > 0)) continue;
          if (task.split) continue;
          if (++demand >= this.targetWorkerCount) break;
        }
      }
      while (this.workers.length < demand) {
        try { this.addWorker(this.targetWorkerCount); } catch { break; }
      }
      this.memoryShrunk = this.workers.length < this.targetWorkerCount;
      if (!this.memoryShrunk) this.idleCompacted = false;
    }
    // The worker pool itself is capped at ~60% of logical cores, leaving
    // headroom for IFC/main-thread/UI. Before IFC completes keep the historical
    // two-compile limit; after IFC has completed, use the whole DEV pool.
    const splitPending = this.splitOwner != null || [...this.slots.values()].some(row => row.split && !row.settled);
    for (const worker of this.workers) {
      if (this.active.has(worker)) continue;
      const running = new Set([...this.active.values()].map(row => row.task.key));
      const now = performance.now();
      const pressured = this.resultPressure.bytes >= 64 * 1024 * 1024 || this.exported.size >= this.workerCount * 2;
      const activeSplitParts=[...this.active.values()].filter(row=>!!row.task.partition).length;
      let task: Slot | undefined, best = Infinity;
      for (const candidate of this.slots.values()) {
        // Pausing background refinement leaves L0 and bounds work eligible so
        // the browser remains usable and the base representation can settle.
        if (candidate.split || running.has(candidate.key)) continue;
        // A part can transiently hold its full 128 MiB serializer quota before
        // the smaller transfer cap is checked. Keep at most two such workers.
        if(candidate.partition && activeSplitParts>=2)continue;
        // Only the admitted parent can bypass backpressure. Other split plans
        // and ordinary compiles cannot spend its reserved completion space.
        const ownTemplate = candidate.parent != null && candidate.parent === this.splitOwner?.key;
        if (candidate.parent && !ownTemplate) continue;
        const gated = candidate.kind === 'compile' || candidate.kind === 'merge';
        if (!ownTemplate && gated && (splitPending || ((this.paused || this.memoryPressure === 'high' || this.memoryPressure === 'critical') && candidate.lod > 0 && candidate.priority > 0) || pressured)) continue;
        const affinity = this.sourceAffinity.get(candidate.path.toLowerCase());
        // Keep one source serial on its preferred worker. Split parts are the
        // exception: they must use the whole pool or a large DEV would still
        // compile on one worker. Unrelated sources still fill the remaining
        // workers, so a pathological source cannot become a global gate.
        if (!candidate.parent && affinity && affinity !== worker && this.workers.includes(affinity)) {
          this.diagnostics.sourceAffinityDeferrals++;
          continue;
        }
        const priority = agedWorkPriority(candidate.priority, candidate.queuedAt, now);
        if (!task || priority < best || priority === best && candidate.id < task.id) { task = candidate; best = priority; }
      }
      // A candidate may belong to another worker's source-affinity lane.  Do
      // not stop scanning the pool in that case: the preferred worker can be
      // later in the array and must still receive the queued task.  This is
      // also what keeps one source's cache locality from becoming a global
      // queue gate.
      if (!task) continue;
      const ifcBusy = ifcGeometryBusy();
      const compileLimit = hasCompletedIfcWork() && !ifcBusy ? this.workers.length : 2;
      const gated = task.kind === 'compile' || task.kind === 'merge';
      const release = gated ? beginDevGeometryWork(compileLimit) : null;
      if (gated && !release) {
        // Do not leave idle workers blocked behind a full compile gate: catalog
        // bounds are independent and must keep progressing.
        let boundsTask: Slot | undefined;
        for (const candidate of this.slots.values()) {
          if (candidate.kind !== 'bounds' || running.has(candidate.key)) continue;
          if (!boundsTask || candidate.priority < boundsTask.priority
            || candidate.priority === boundsTask.priority && candidate.id < boundsTask.id) boundsTask = candidate;
        }
        if (!boundsTask) break;
        task = boundsTask;
      }
      this.active.set(worker, { task, release, finished: false, startedAt: performance.now() });
      const affinity = this.sourceAffinity.get(task.path.toLowerCase());
      if (affinity === worker) this.diagnostics.sourceAffinityHits++;
      this.sourceAffinity.set(task.path.toLowerCase(), worker);
      this.lastProgressAt = performance.now();
      const queueWaitMs=Math.max(0,performance.now()-task.queuedAt);
      this.diagnostics.queueWaitMs += queueWaitMs;
      if (task.kind === 'bounds') this.diagnostics.boundsTasks++; else this.diagnostics.compileTasks++;
      perfRecordTaskPhase(this.taskIdentity(task), 'workerQueue', queueWaitMs, this.perf);
      if(task.kind!=='bounds'){
        const templateKey=task.parent??task.key,stats=this.queueByTemplate.get(templateKey)??{waitMs:0,dispatches:0};
        stats.waitMs+=queueWaitMs;stats.dispatches++;this.queueByTemplate.set(templateKey,stats);
      }
      try {
        const payload: Record<string, unknown> = { kind: task.kind, id: task.id, traceId: task.traceId, key: task.key, path: task.path, lod: task.lod, session: this.session };
        if(task.parent)payload.parentTaskId=this.slots.get(task.parent)?.traceId;
        if (task.partition) payload.partition = task.partition;
        if (task.noSplit || this.memoryPressure==='high' || this.memoryPressure==='critical') payload.noSplit = true;
        const transfer: Transferable[] = [];
        if (task.kind === 'merge') {
          const parts = task.mergeParts ?? [];
          payload.parts = parts;
          for (const bytes of parts) transfer.push(bytes.buffer as ArrayBuffer);
          task.mergeParts = undefined;
        }
        worker.postMessage(payload, transfer);
        task.measuredContext=measurementWorkerTask(worker);
        for(const owner of task.measuredInputs??[])this.outputResources.release(owner,'transferred','transport');task.measuredInputs=[];
      }
      catch(error){this.workerFailed(worker,error instanceof Error?error:Error(String(error)));}
    }
    this.trackIdle();
    this.onActivity();
  }
  private async receive(worker: Worker, data: any): Promise<void> {
    if (this.stopped||!this.workers.includes(worker)) return;
    if (!this.current()) { this.cancel(); return; }
    if (data.kind === 'read') {
      try {
        const file = this.files.get(data.path); if (!file) throw new Error(`DEV source missing: ${data.path}`);
        const owner = this.active.get(worker);
        const bytes = owner ? await perfMeasureTaskPhase({...this.taskIdentity(owner.task), sourcePath: data.path},
          'sourceRpc', () => file.arrayBuffer(), this.perf) : await file.arrayBuffer();
        if (!this.current() || this.stopped || !this.workers.includes(worker)) return;
        worker.postMessage({ kind: 'read-result', id: data.id, bytes }, [bytes]);
      } catch (error) { if (!this.stopped&&this.workers.includes(worker)) worker.postMessage({ kind: 'read-result', id: data.id, error: String(error) }); }
      return;
    }
    const owner = this.active.get(worker), task = owner?.task;
    if (data.kind !== 'result' || !task || data.id !== task.id || data.session !== this.session || data.key !== task.key) return;
    owner!.finished = true;
    this.active.delete(worker);
    this.lastProgressAt = performance.now();
    this.lastUsedWorker = worker;
    owner!.release?.(); owner!.release = null;
    if (task.settled) { this.pump(); return; }
    if (data.error) this.diagnostics.failedTasks++;
    const stages = data.stages ?? {};
    // Workers already split source, assembly, mesh and serialization phases.
    // Keep bounded aggregates, rather than retaining every task's trace.
    for (const [name, value] of Object.entries(stages)) {
      if (!name.endsWith('Ms') || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
      if (!(name in this.diagnostics.stages) && Object.keys(this.diagnostics.stages).length >= 32) continue;
      const summary = this.diagnostics.stages[name] ??= { count: 0, totalMs: 0, maxMs: 0 };
      summary.count++; summary.totalMs += value; summary.maxMs = Math.max(summary.maxMs, value);
      // Reported completed stage measurements do not identify the failing
      // phase. Only the enclosing workerWall gets the overall failure status.
      perfRecordTaskPhase(this.taskIdentity(task), `worker.${name}`, value, this.perf);
    }
    this.diagnostics.reads += Number(stages.reads) || 0;
    this.diagnostics.rpcReads += Number(stages.rpcReads) || 0;
    this.diagnostics.sourceHits += Number(stages.sourceHits) || 0;
    this.diagnostics.documentHits += Number(stages.documentHits) || 0;
    this.diagnostics.readRpcMs += Number(stages.readRpcMs) || 0;
    this.diagnostics.decodeMs += Number(stages.decodeMs) || 0;
    this.diagnostics.parseMs += Number(stages.validateParseMs) || 0;
    perfRecordTaskPhase(this.taskIdentity(task), 'workerWall', data.wallMs ?? performance.now() - owner!.startedAt,
      this.perf, data.error ? 'failed' : 'completed', data.result?.bytes?.byteLength ?? 0);
    if (data.error) {
      const error = data.sourceErrorKind==='missing-dependency'&&data.sourceEvidence
        ?new MissingDevDependencyError(task.path,data.error,data.sourceEvidence)
        :data.sourceErrorKind==='source-invalid'&&data.sourceEvidence
          ?new InvalidDevGeometryError(task.path,data.error,data.sourceEvidence)
          :Object.assign(new Error(data.error),{geometryKind:data.sourceErrorKind});
      this.cancelTaskTree(task, error, false);
      this.pump();
      return;
    }
    const result = data.result as DevGlbSerializationResult;
    // A large DEV returns a real assembly-subtree plan instead of bytes. The
    // parent stays in the slot map as the single template owner while its
    // parts run on the same bounded pool.
    if (task.kind === 'compile' && !task.parent && result?.plan) {
      try { this.startSplit(task, result.plan); }
      catch (error) {
        this.cancelTaskTree(task, error instanceof Error ? error : new Error(String(error)), false);
      }
      this.pump();
      return;
    }
    const bytes = result?.bytes?.byteLength ?? 0;
    if (bytes > DEV_GLB_MAX_BYTES) {
      this.cancelTaskTree(task, new Error('DEV compiled result exceeds 128 MiB quota'), false);
      this.pump();
      return;
    }
    if(task.parent&&task.partition&&bytes>task.partition.maxBytes){
      this.cancelTaskTree(task,new Error('DEV split part exceeds reserved output budget'),false);return;
    }
    if (task.kind === 'merge') {
      task.settled = true; this.slots.delete(task.key); task.resolve(result);
      this.pump();
      return;
    }
    if (task.parent) {
      task.settled = true; this.slots.delete(task.key); task.resolve(result);
      return;
    }
    this.slots.delete(task.key);
    if (task.kind === 'compile' && bytes) {
      this.outputResources.hold(`output:${task.key}`,result.bytes!,{...this.taskIdentity(task),context:task.measuredContext},'output');
      this.exported.set(task.key, { task, bytes }); this.exportedBytes += bytes;
      this.updatePeak();
    }
    task.resolve(result);
    this.pump();
  }
  private request(kind: Slot['kind'], path: string, lod: DeviceLod, key: string, priority: number, traceId?: string): Promise<any> {
    if (this.stopped || !this.current()) return Promise.reject(this.terminalError ?? new DOMException('DEV session expired', 'AbortError'));
    const old = this.slots.get(key) ?? this.exported.get(key)?.task; if (old) { old.priority = Math.min(old.priority, priority); return old.promise; }
    const { promise } = this.createSlot(kind, path, lod, key, priority, traceId);
    this.pump(); return promise;
  }
  compile(path: string, lod: DeviceLod, key: string, priority: number, traceId?: string): Promise<DevGlbSerializationResult> { return this.request('compile', path, lod, key, priority, traceId); }
  bounds(path: string): Promise<DevSourceBounds> { return this.request('bounds', path, 0, `bounds:${path.toLowerCase()}`, 0.4); }
  promote(key: string, priority: number): void {
    for (const task of this.slots.values()) {
      if (task.key === key || task.parent === key) task.priority = Math.min(task.priority, priority);
    }
    this.pump();
  }
  /** Whole-DEV browsing compile used by the progressive GLB serialization path. */
  take(path: string): Promise<DevGlbSerializationResult> {
    const key = `progressive:${path.toLowerCase()}`;
    return this.compile(path, 0, key, 3).finally(() => this.acknowledge(key));
  }
  acknowledge(key: string): void {
    this.outputResources.release(`output:${key}`);
    const result = this.exported.get(key);
    if (result) { this.exportedBytes -= result.bytes; this.exported.delete(key); this.lastProgressAt = performance.now(); }
    this.pump();
  }
  /** Cancel an exclusively owned request, including synchronous geometry work.
   * Callers must retain shared keys until their final consumer releases them. */
  cancelTask(key: string): void {
    const task = this.slots.get(key);
    if (!task) return;
    const reason = new DOMException('DEV precision request cancelled', 'AbortError');
    perfRecordTaskPhase(this.taskIdentity(task), 'requestWall', performance.now() - task.queuedAt, this.perf, 'cancelled');
    this.cancelTaskTree(task, reason, true);
    if (!this.workers.length) { this.cancel(new Error('DEV worker replacement unavailable')); return; }
    this.pump();
  }
  cancelQueued(keep: ReadonlySet<string>): void {
    const running = new Set([...this.active.values()].map(row => row.task));
    for (const task of [...this.slots.values()]) {
      if (running.has(task) || task.kind !== 'compile' && task.kind !== 'merge') continue;
      // A split part is owned by its template key, not by a public view key.
      if (keep.has(task.parent ?? task.key)) continue;
      perfRecordTaskPhase(this.taskIdentity(task), 'requestWall', performance.now() - task.queuedAt, this.perf, 'cancelled');
      this.cancelTaskTree(task, new DOMException('DEV request left the current view', 'AbortError'), false);
    }
    this.trackIdle();
    this.pump();
  }
  cancel(error = new Error('DEV preprocessing cancelled')): void {
    if (this.stopped) return; this.stopped = true;
    clearInterval(this.watchdog); this.unsubscribeGate();
    for (const worker of this.workers) worker.terminate();
    for (const row of this.active.values()) row.release?.(); this.active.clear();
    for (const task of this.slots.values()) {
      perfRecordTaskPhase(this.taskIdentity(task), 'requestWall', performance.now() - task.queuedAt, this.perf, 'cancelled');
      task.settled = true; task.reject(error); task.mergeParts = undefined;
      if (task.split) { this.releaseSplitBuffers(task.split); task.split.reservation = 0; }
    } this.slots.clear(); this.files = new Map();
    this.exported.clear(); this.exportedBytes = 0; this.splitHeldBytes=0;this.mergeReservedBytes=0;this.sourceAffinity.clear();
    this.outputResources.clear();
    this.queueByTemplate.clear();
    this.splitOwner = null;
    this.lastUsedWorker = null;
    this.idleSince = null;
  }
}
export function createDevGeometryPreprocessor(state: AppState, session: ProjectLoadSession, files: Map<string, File>): DevGeometryPreprocessor {
  clients.get(state)?.cancel();
  const client = new DevGeometryPreprocessor([], files, () => state.isCurrentSession(session)); clients.set(state, client); return client;
}
export function getDevGeometryPreprocessor(state: AppState) { return clients.get(state); }
export function cancelDevGeometryPreprocessing(state: AppState): void { clients.get(state)?.cancel(); clients.delete(state); }
