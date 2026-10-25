import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { DevGlbSerializationResult } from './glbCacheService.js';
import type { DeviceLod } from '../viewer/xmlModGeometry.js';
import type { DevSourceBounds } from './devSpatialCatalog.js';
import { InvalidDevGeometryError } from '../gim/geometry/sourceGeometryError.js';
import { perfCurrentSession, perfMark, perfRecordTaskPhase, perfMeasureTaskPhase, type PerfTaskIdentity } from '../utils/perfTimings.js';
import { beginDevGeometryWork, hasCompletedIfcWork, ifcGeometryBusy, onGeometryWorkAvailable, geometryWorkSnapshot } from '../viewer/geometryWorkGate.js';
import { agedWorkPriority } from '../utils/workPriority.js';
import type { MemoryPressure } from '../utils/memoryPressure.js';
interface Slot { id: number; traceId: string; key: string; path: string; kind: 'compile' | 'bounds'; lod: DeviceLod; priority: number; queuedAt: number;
  promise: Promise<any>; resolve: (value: any) => void; reject: (error: Error) => void }
const clients = new WeakMap<AppState, DevGeometryPreprocessor>();
let serial = 0;
const IDLE_POOL_TIMEOUT_MS = 30_000;
/** Computation slots and unacknowledged results have separate lifetimes.
 * Stop starting compiles at 64 MiB of exported results (or 2 results/worker).
 * Already running tasks may finish; one result is limited to 128 MiB. */
export class DevGeometryPreprocessor {
  private workers: Worker[] = [];
  private slots = new Map<string, Slot>();
  private active = new Map<Worker, { task: Slot; release: (() => void) | null; finished: boolean; startedAt: number }>();
  private exported = new Map<string, { task: Slot; bytes: number }>();
  private exportedBytes = 0;
  private exportedPeakBytes = 0;
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
      idleMs: this.idleSince === null ? 0 : Math.max(0, now - this.idleSince),
      tasks: [...this.active.values()].slice(0, 8).map(({ task, startedAt }) => ({ id: task.id,
        path: task.path, lod: task.lod, kind: task.kind, priority: task.priority, elapsedMs: now - startedAt })) };
  }
  private addWorker(count:number):void {
      const worker = new Worker(new URL('./devGeometryWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { void this.receive(worker, data); };
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
  readonly diagnostics = {
    reads: 0, rpcReads: 0, sourceHits: 0, documentHits: 0,
    readRpcMs: 0, decodeMs: 0, parseMs: 0, queueWaitMs: 0,
    boundsTasks: 0, compileTasks: 0, failedTasks: 0,
    timedOutTasks: 0, stallSnapshots: 0, idleWorkerReclaims: 0, idlePoolShrinks: 0,
    sourceAffinityHits: 0, sourceAffinityDeferrals: 0,
    stages: {} as Record<string, { count: number; totalMs: number; maxMs: number }>,
  };
  get resultPressure() { return { bytes: this.exportedBytes, peakBytes: this.exportedPeakBytes, count: this.exported.size }; }
  get activePaths(): string[] { return [...this.active.values()].map(row => `${row.task.path} · ${row.finished ? '提交' : row.task.kind === 'bounds' ? '目录' : `LOD${row.task.lod}`}`); }
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
    this.trimIdleWorkers();
    if (this.memoryShrunk && (this.memoryPressure === 'normal' || this.memoryPressure === 'unknown') && this.slots.size) {
      let demand = this.targetWorkerCount;
      if (this.idleCompacted) {
        demand = 0;
        const pressured = this.exportedBytes >= 64 * 1024 * 1024 || this.exported.size >= this.workerCount * 2;
        for (const task of this.slots.values()) {
          // Paused/background or backpressured compiles are not demand for
          // new threads. Bounds and explicit user work remain eligible.
          if (task.kind === 'compile' && (pressured || this.paused && task.lod > 0 && task.priority > 0)) continue;
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
    for (const worker of this.workers) {
      if (this.active.has(worker)) continue;
      const running = new Set([...this.active.values()].map(row => row.task.key));
      const now = performance.now();
      const pressured = this.exportedBytes >= 64 * 1024 * 1024 || this.exported.size >= this.workerCount * 2;
      let task: Slot | undefined, best = Infinity;
      for (const candidate of this.slots.values()) {
        // Pausing background refinement leaves L0 and bounds work eligible so
        // the browser remains usable and the base representation can settle.
        if (running.has(candidate.key) || candidate.kind === 'compile' && (((this.paused || this.memoryPressure === 'high' || this.memoryPressure === 'critical') && candidate.lod > 0 && candidate.priority > 0) || pressured)) continue;
        const affinity = this.sourceAffinity.get(candidate.path.toLowerCase());
        // Keep one source serial on its preferred worker.  Unrelated sources
        // still fill the remaining workers, so a pathological source cannot
        // become a global scheduling gate.
        if (affinity && affinity !== worker && this.workers.includes(affinity)) {
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
      const release = task.kind === 'compile' ? beginDevGeometryWork(compileLimit) : null;
      if (task.kind === 'compile' && !release) {
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
      this.diagnostics.queueWaitMs += Math.max(0, performance.now() - task.queuedAt);
      if (task.kind === 'bounds') this.diagnostics.boundsTasks++; else this.diagnostics.compileTasks++;
      perfRecordTaskPhase(this.taskIdentity(task), 'workerQueue', Math.max(0, performance.now() - task.queuedAt), this.perf);
      try {worker.postMessage({ kind: task.kind, id: task.id, key: task.key, path: task.path, lod: task.lod, session: this.session });}
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
    this.slots.delete(task.key); owner!.finished = true;
    this.lastProgressAt = performance.now();
    this.lastUsedWorker = worker;
    owner!.release?.(); owner!.release = null;
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
    const bytes = data.result?.bytes?.byteLength ?? 0;
    if (data.error) task.reject(data.sourceEvidence ? new InvalidDevGeometryError(task.path, data.error, data.sourceEvidence) : new Error(data.error));
    else if (bytes > 128 * 1024 * 1024) task.reject(new Error('DEV compiled result exceeds 128 MiB quota'));
    else {
      if (task.kind === 'compile' && bytes) {
        this.exported.set(task.key, { task, bytes }); this.exportedBytes += bytes;
        this.exportedPeakBytes = Math.max(this.exportedPeakBytes, this.exportedBytes);
      }
      task.resolve(data.result);
    }
    this.active.delete(worker);
    this.pump();
  }
  private request(kind: Slot['kind'], path: string, lod: DeviceLod, key: string, priority: number, traceId?: string): Promise<any> {
    if (this.stopped || !this.current()) return Promise.reject(this.terminalError ?? new DOMException('DEV session expired', 'AbortError'));
    const old = this.slots.get(key) ?? this.exported.get(key)?.task; if (old) { old.priority = Math.min(old.priority, priority); return old.promise; }
    let resolve!: Slot['resolve'], reject!: Slot['reject'];
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const id = ++this.sequence;
    this.slots.set(key, { id, traceId: traceId ?? `${this.perf.id}:dev-worker:${this.session}:${id}`, key, path, kind, lod, priority, queuedAt: performance.now(), promise, resolve, reject });
    this.pump(); return promise;
  }
  compile(path: string, lod: DeviceLod, key: string, priority: number, traceId?: string): Promise<DevGlbSerializationResult> { return this.request('compile', path, lod, key, priority, traceId); }
  bounds(path: string): Promise<DevSourceBounds> { return this.request('bounds', path, 0, `bounds:${path.toLowerCase()}`, 0.4); }
  promote(key: string, priority: number): void { const slot = this.slots.get(key); if (slot) slot.priority = Math.min(slot.priority, priority); this.pump(); }
  /** Whole-DEV LOD2 compile used by the progressive GLB serialization path. */
  take(path: string): Promise<DevGlbSerializationResult> {
    const key = `legacy:${path.toLowerCase()}`;
    return this.compile(path, 2, key, 3).finally(() => this.acknowledge(key));
  }
  acknowledge(key: string): void {
    const result = this.exported.get(key);
    if (result) { this.exportedBytes -= result.bytes; this.exported.delete(key); this.lastProgressAt = performance.now(); }
    this.pump();
  }
  /** Cancel an exclusively owned request, including synchronous geometry work.
   * Callers must retain shared keys until their final consumer releases them. */
  cancelTask(key: string): void {
    const task = this.slots.get(key);
    if (!task) return;
    this.slots.delete(key);
    for (const [worker, owner] of this.active) {
      if (owner.task !== task) continue;
      this.active.delete(worker);
      owner.release?.();
      worker.terminate();
      this.workers = this.workers.filter(value => value !== worker);
      if (this.lastUsedWorker === worker) this.lastUsedWorker = null;
      for (const [path, value] of this.sourceAffinity) if (value === worker) this.sourceAffinity.delete(path);
      if (!this.stopped && this.current()) {
        try { this.addWorker(this.workers.length + 1); }
        catch { /* Cancellation still settles; healthy workers keep draining. */ }
      }
      break;
    }
    task.reject(new DOMException('DEV precision request cancelled', 'AbortError'));
    perfRecordTaskPhase(this.taskIdentity(task), 'requestWall', performance.now() - task.queuedAt, this.perf, 'cancelled');
    if (!this.workers.length) { this.cancel(new Error('DEV worker replacement unavailable')); return; }
    this.pump();
  }
  cancelQueued(keep: ReadonlySet<string>): void {
    const running = new Set([...this.active.values()].map(row => row.task));
    for (const [key, task] of this.slots) if (!running.has(task) && task.kind === 'compile' && !keep.has(key)) {
      perfRecordTaskPhase(this.taskIdentity(task), 'requestWall', performance.now() - task.queuedAt, this.perf, 'cancelled');
      this.slots.delete(key); task.reject(new DOMException('DEV request left the current view', 'AbortError'));
    }
    this.trackIdle();
  }
  cancel(error = new Error('DEV preprocessing cancelled')): void {
    if (this.stopped) return; this.stopped = true;
    clearInterval(this.watchdog); this.unsubscribeGate();
    for (const worker of this.workers) worker.terminate();
    for (const row of this.active.values()) row.release?.(); this.active.clear();
    for (const task of this.slots.values()) {
      perfRecordTaskPhase(this.taskIdentity(task), 'requestWall', performance.now() - task.queuedAt, this.perf, 'cancelled');
      task.reject(error);
    } this.slots.clear(); this.files = new Map();
    this.exported.clear(); this.exportedBytes = 0; this.sourceAffinity.clear();
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
