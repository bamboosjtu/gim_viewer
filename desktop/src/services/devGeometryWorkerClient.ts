import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { DevGlbSerializationResult } from './glbCacheService.js';
import type { DeviceLod } from '../viewer/xmlModGeometry.js';
import type { DevSourceBounds } from './devSpatialCatalog.js';
import { InvalidDevGeometryError } from '../gim/geometry/sourceGeometryError.js';
import { perfCurrentSession, perfMark } from '../utils/perfTimings.js';
import { beginDevGeometryWork } from '../viewer/geometryWorkGate.js';
interface Slot { id: number; key: string; path: string; kind: 'compile' | 'bounds'; lod: DeviceLod; priority: number;
  promise: Promise<any>; resolve: (value: any) => void; reject: (error: Error) => void }
const clients = new WeakMap<AppState, DevGeometryPreprocessor>();
let serial = 0;
/** Bounded DEV pool, deduplicated by template/LOD. A completed compile occupies
 * its slot until the consumer commits it, so export results cannot accumulate. */
export class DevGeometryPreprocessor {
  private workers: Worker[] = [];
  private slots = new Map<string, Slot>();
  private active = new Map<Worker, { task: Slot; release: (() => void) | null; finished: boolean }>();
  private stopped = false;
  private paused = false;
  private sequence = 0;
  private readonly session = ++serial;
  private readonly perf = perfCurrentSession();
  constructor(_paths: string[], private files: Map<string, File>, private current: () => boolean) {
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const count = navigator.hardwareConcurrency >= 6 && (memory == null || memory >= 4) ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./devGeometryWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { void this.receive(worker, data); };
      worker.onerror = event => this.cancel(new Error(event.message || 'DEV geometry worker failed'));
      // File/Blob is immutable and structured-clonable: share its backing store,
      // rather than routing thousands of small in-memory reads through the UI.
      // Disk-backed File shims retain the authorized read RPC path.
      worker.postMessage({ kind: 'init', cacheDivisor: count, files: [...files].filter(([p]) => /\.(dev|phm|mod|stl|gl)$/i.test(p)).map(([p, f]) => [p, f.size, f instanceof File ? f : null]) });
      this.workers.push(worker);
    }
  }
  get workerCount(): number { return this.workers.length; }
  get activePaths(): string[] { return [...this.active.values()].map(row => `${row.task.path} · ${row.finished ? '提交' : row.task.kind === 'bounds' ? '目录' : `LOD${row.task.lod}`}`); }
  onActivity: () => void = () => {};
  setPaused(value: boolean): void { this.paused = value; this.pump(); }
  private pump(): void {
    if (!this.current()) { this.cancel(); return; }
    if (this.stopped) return;
    for (const worker of this.workers) {
      if (this.active.has(worker)) continue;
      const running = new Set([...this.active.values()].map(row => row.task.key));
      const task = [...this.slots.values()].filter(s => !running.has(s.key) && (!this.paused || s.kind === 'bounds')).sort((a, b) => a.priority - b.priority || a.id - b.id)[0];
      if (!task) break;
      const release = task.kind === 'compile' ? beginDevGeometryWork() : null;
      if (task.kind === 'compile' && !release) break;
      this.active.set(worker, { task, release, finished: false });
      perfMark('DEV worker start', { path: task.path, kind: task.kind, lod: task.lod, key: task.key, concurrency: this.active.size }, this.perf);
      worker.postMessage({ kind: task.kind, id: task.id, key: task.key, path: task.path, lod: task.lod, session: this.session });
    }
    this.onActivity();
  }
  private async receive(worker: Worker, data: any): Promise<void> {
    if (this.stopped) return;
    if (!this.current()) { this.cancel(); return; }
    if (data.kind === 'read') {
      try {
        const file = this.files.get(data.path); if (!file) throw new Error(`DEV source missing: ${data.path}`);
        const bytes = await file.arrayBuffer(); if (!this.current() || this.stopped) return;
        worker.postMessage({ kind: 'read-result', id: data.id, bytes }, [bytes]);
      } catch (error) { if (!this.stopped) worker.postMessage({ kind: 'read-result', id: data.id, error: String(error) }); }
      return;
    }
    const owner = this.active.get(worker), task = owner?.task;
    if (data.kind !== 'result' || !task || data.id !== task.id || data.session !== this.session || data.key !== task.key) return;
    this.slots.delete(task.key); owner!.finished = true;
    owner!.release?.(); owner!.release = null;
    perfMark('DEV worker result', { path: task.path, kind: task.kind, lod: task.lod, key: task.key,
      workerWallMs: data.wallMs, stages: data.stages, bytes: data.result?.bytes?.byteLength ?? 0, error: data.error }, this.perf);
    if (data.error) task.reject(data.sourceEvidence ? new InvalidDevGeometryError(task.path, data.error, data.sourceEvidence) : new Error(data.error));
    else task.resolve(data.result);
    if (task.kind === 'bounds' || data.error) this.active.delete(worker);
    this.pump();
  }
  private request(kind: Slot['kind'], path: string, lod: DeviceLod, key: string, priority: number): Promise<any> {
    if (this.stopped || !this.current()) return Promise.reject(new DOMException('DEV session expired', 'AbortError'));
    const old = this.slots.get(key); if (old) { old.priority = Math.min(old.priority, priority); return old.promise; }
    let resolve!: Slot['resolve'], reject!: Slot['reject'];
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.slots.set(key, { id: ++this.sequence, key, path, kind, lod, priority, promise, resolve, reject });
    this.pump(); return promise;
  }
  compile(path: string, lod: DeviceLod, key: string, priority: number): Promise<DevGlbSerializationResult> { return this.request('compile', path, lod, key, priority); }
  bounds(path: string): Promise<DevSourceBounds> { return this.request('bounds', path, 0, `bounds:${path.toLowerCase()}`, 2.5); }
  promote(key: string, priority: number): void { const slot = this.slots.get(key); if (slot) slot.priority = Math.min(slot.priority, priority); this.pump(); }
  /** Compatibility for explicitly invoked all-device compiler; product uses compile(). */
  take(path: string): Promise<DevGlbSerializationResult> {
    const key = `legacy:${path.toLowerCase()}`;
    return this.compile(path, 2, key, 3).finally(() => this.acknowledge(key));
  }
  acknowledge(key: string): void {
    for (const [worker, row] of this.active) if (row.task.key === key && row.finished) this.active.delete(worker);
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
  }
}
export function createDevGeometryPreprocessor(state: AppState, session: ProjectLoadSession, files: Map<string, File>): DevGeometryPreprocessor {
  clients.get(state)?.cancel();
  const client = new DevGeometryPreprocessor([], files, () => state.isCurrentSession(session)); clients.set(state, client); return client;
}
export function startDevGeometryPreprocessing(state: AppState, session: ProjectLoadSession): void {
  if (clients.has(state) || !state.currentFiles || typeof Worker === 'undefined') return;
  createDevGeometryPreprocessor(state, session, state.currentFiles);
}
export function getDevGeometryPreprocessor(state: AppState) { return clients.get(state); }
export function cancelDevGeometryPreprocessing(state: AppState): void { clients.get(state)?.cancel(); clients.delete(state); }
