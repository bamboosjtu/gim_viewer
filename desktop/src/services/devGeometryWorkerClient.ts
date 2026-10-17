import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { DevGlbSerializationResult } from './glbCacheService.js';
import type { DeviceLod } from '../viewer/xmlModGeometry.js';
import type { DevSourceBounds } from './devSpatialCatalog.js';
import { InvalidDevGeometryError } from '../gim/geometry/sourceGeometryError.js';
import { perfCurrentSession, perfMark } from '../utils/perfTimings.js';
import { beginDevGeometryWork } from '../viewer/geometryWorkGate.js';
import { agedWorkPriority } from '../utils/workPriority.js';
interface Slot { id: number; key: string; path: string; kind: 'compile' | 'bounds'; lod: DeviceLod; priority: number; queuedAt: number;
  promise: Promise<any>; resolve: (value: any) => void; reject: (error: Error) => void }
const clients = new WeakMap<AppState, DevGeometryPreprocessor>();
let serial = 0;
/** Computation slots and unacknowledged results have separate lifetimes.
 * Stop starting compiles at 64 MiB of exported results (or 2 results/worker).
 * Already running tasks may finish; one result is limited to 128 MiB. */
export class DevGeometryPreprocessor {
  private workers: Worker[] = [];
  private slots = new Map<string, Slot>();
  private active = new Map<Worker, { task: Slot; release: (() => void) | null; finished: boolean }>();
  private exported = new Map<string, { task: Slot; bytes: number }>();
  private exportedBytes = 0;
  private exportedPeakBytes = 0;
  private stopped = false;
  private paused = false;
  private sequence = 0;
  private readonly session = ++serial;
  private readonly perf = perfCurrentSession();
  private replacements=0;
  private terminalError:Error|null=null;
  constructor(_paths: string[], private files: Map<string, File>, private current: () => boolean) {
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const count = navigator.hardwareConcurrency >= 6 && (memory == null || memory >= 4) ? 2 : 1;
    for (let i = 0; i < count; i++) {
      this.addWorker(count);
    }
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
    const owner=this.active.get(worker);this.active.delete(worker);owner?.release?.();
    if(owner){this.slots.delete(owner.task.key);owner.task.reject(error);}
    // Bounded pool repair: a failed source is surfaced as a normal task error,
    // never an AbortError that the runtime would silently requeue forever.
    if(this.current()&&this.replacements<2){this.replacements++;try{this.addWorker(Math.max(1,this.workers.length+1));}catch{/* Healthy workers can drain the queue. */}}
    if(!this.workers.length){this.terminalError=error;this.cancel(error);}else this.pump();
    this.onActivity();
  }
  get workerCount(): number { return this.workers.length; }
  get resultPressure() { return { bytes: this.exportedBytes, peakBytes: this.exportedPeakBytes, count: this.exported.size }; }
  get activePaths(): string[] { return [...this.active.values()].map(row => `${row.task.path} · ${row.finished ? '提交' : row.task.kind === 'bounds' ? '目录' : `LOD${row.task.lod}`}`); }
  onActivity: () => void = () => {};
  setPaused(value: boolean): void { this.paused = value; this.pump(); }
  private pump(): void {
    if (!this.current()) { this.cancel(); return; }
    if (this.stopped) return;
    for (const worker of this.workers) {
      if (this.active.has(worker)) continue;
      const running = new Set([...this.active.values()].map(row => row.task.key));
      const now = performance.now();
      const pressured = this.exportedBytes >= 64 * 1024 * 1024 || this.exported.size >= this.workerCount * 2;
      let task: Slot | undefined, best = Infinity;
      for (const candidate of this.slots.values()) {
        if (running.has(candidate.key) || candidate.kind === 'compile' && (this.paused || pressured)) continue;
        const priority = agedWorkPriority(candidate.priority, candidate.queuedAt, now);
        if (!task || priority < best || priority === best && candidate.id < task.id) { task = candidate; best = priority; }
      }
      if (!task) break;
      const release = task.kind === 'compile' ? beginDevGeometryWork() : null;
      if (task.kind === 'compile' && !release) break;
      this.active.set(worker, { task, release, finished: false });
      perfMark('DEV worker start', { path: task.path, kind: task.kind, lod: task.lod, key: task.key, concurrency: this.active.size }, this.perf);
      try {worker.postMessage({ kind: task.kind, id: task.id, key: task.key, path: task.path, lod: task.lod, session: this.session });}
      catch(error){this.workerFailed(worker,error instanceof Error?error:Error(String(error)));}
    }
    this.onActivity();
  }
  private async receive(worker: Worker, data: any): Promise<void> {
    if (this.stopped||!this.workers.includes(worker)) return;
    if (!this.current()) { this.cancel(); return; }
    if (data.kind === 'read') {
      try {
        const file = this.files.get(data.path); if (!file) throw new Error(`DEV source missing: ${data.path}`);
        const bytes = await file.arrayBuffer(); if (!this.current() || this.stopped || !this.workers.includes(worker)) return;
        worker.postMessage({ kind: 'read-result', id: data.id, bytes }, [bytes]);
      } catch (error) { if (!this.stopped&&this.workers.includes(worker)) worker.postMessage({ kind: 'read-result', id: data.id, error: String(error) }); }
      return;
    }
    const owner = this.active.get(worker), task = owner?.task;
    if (data.kind !== 'result' || !task || data.id !== task.id || data.session !== this.session || data.key !== task.key) return;
    this.slots.delete(task.key); owner!.finished = true;
    owner!.release?.(); owner!.release = null;
    perfMark('DEV worker result', { path: task.path, kind: task.kind, lod: task.lod, key: task.key,
      workerWallMs: data.wallMs, stages: data.stages, bytes: data.result?.bytes?.byteLength ?? 0, error: data.error }, this.perf);
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
  private request(kind: Slot['kind'], path: string, lod: DeviceLod, key: string, priority: number): Promise<any> {
    if (this.stopped || !this.current()) return Promise.reject(this.terminalError ?? new DOMException('DEV session expired', 'AbortError'));
    const old = this.slots.get(key) ?? this.exported.get(key)?.task; if (old) { old.priority = Math.min(old.priority, priority); return old.promise; }
    let resolve!: Slot['resolve'], reject!: Slot['reject'];
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.slots.set(key, { id: ++this.sequence, key, path, kind, lod, priority, queuedAt: performance.now(), promise, resolve, reject });
    this.pump(); return promise;
  }
  compile(path: string, lod: DeviceLod, key: string, priority: number): Promise<DevGlbSerializationResult> { return this.request('compile', path, lod, key, priority); }
  bounds(path: string): Promise<DevSourceBounds> { return this.request('bounds', path, 0, `bounds:${path.toLowerCase()}`, 0.75); }
  promote(key: string, priority: number): void { const slot = this.slots.get(key); if (slot) slot.priority = Math.min(slot.priority, priority); this.pump(); }
  /** Whole-DEV LOD2 compile used by the progressive GLB serialization path. */
  take(path: string): Promise<DevGlbSerializationResult> {
    const key = `legacy:${path.toLowerCase()}`;
    return this.compile(path, 2, key, 3).finally(() => this.acknowledge(key));
  }
  acknowledge(key: string): void {
    const result = this.exported.get(key);
    if (result) { this.exportedBytes -= result.bytes; this.exported.delete(key); }
    this.pump();
  }
  cancelQueued(keep: ReadonlySet<string>): void {
    const running = new Set([...this.active.values()].map(row => row.task));
    for (const [key, task] of this.slots) if (!running.has(task) && task.kind === 'compile' && !keep.has(key)) {
      this.slots.delete(key); task.reject(new DOMException('DEV request left the current view', 'AbortError'));
    }
  }
  cancel(error = new Error('DEV preprocessing cancelled')): void {
    if (this.stopped) return; this.stopped = true;
    for (const worker of this.workers) worker.terminate();
    for (const row of this.active.values()) row.release?.(); this.active.clear();
    for (const task of this.slots.values()) task.reject(error); this.slots.clear(); this.files = new Map();
    this.exported.clear(); this.exportedBytes = 0;
  }
}
export function createDevGeometryPreprocessor(state: AppState, session: ProjectLoadSession, files: Map<string, File>): DevGeometryPreprocessor {
  clients.get(state)?.cancel();
  const client = new DevGeometryPreprocessor([], files, () => state.isCurrentSession(session)); clients.set(state, client); return client;
}
export function getDevGeometryPreprocessor(state: AppState) { return clients.get(state); }
export function cancelDevGeometryPreprocessing(state: AppState): void { clients.get(state)?.cancel(); clients.delete(state); }
