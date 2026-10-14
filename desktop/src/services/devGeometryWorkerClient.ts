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
/** One DEV worker, random-access deduplicated requests; nothing is prefetched. */
export class DevGeometryPreprocessor {
  private worker: Worker;
  private slots = new Map<string, Slot>();
  private active: Slot | null = null;
  private releaseGeometry: (() => void) | null = null;
  private stopped = false;
  private paused = false;
  private sequence = 0;
  private readonly session = ++serial;
  private readonly perf = perfCurrentSession();
  constructor(_paths: string[], private files: Map<string, File>, private current: () => boolean) {
    this.worker = new Worker(new URL('./devGeometryWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => { void this.receive(data); };
    this.worker.onerror = event => this.cancel(new Error(event.message || 'DEV geometry worker failed'));
    this.worker.postMessage({ kind: 'init', files: [...files].filter(([p]) => /\.(dev|phm|mod|stl|gl)$/i.test(p)).map(([p, f]) => [p, f.size]) });
  }
  setPaused(value: boolean): void { this.paused = value; this.pump(); }
  private pump(): void {
    if (!this.current()) { this.cancel(); return; }
    if (this.stopped || this.active) return;
    const task = [...this.slots.values()].filter(s => !this.paused || s.kind === 'bounds').sort((a, b) => a.priority - b.priority || a.id - b.id)[0];
    if (!task) return;
    if (task.kind === 'compile') { this.releaseGeometry = beginDevGeometryWork(); if (!this.releaseGeometry) return; }
    this.active = task;
    this.worker.postMessage({ kind: task.kind, id: task.id, key: task.key, path: task.path, lod: task.lod, session: this.session });
  }
  private async receive(data: any): Promise<void> {
    if (this.stopped) return;
    if (!this.current()) { this.cancel(); return; }
    if (data.kind === 'read') {
      try {
        const file = this.files.get(data.path); if (!file) throw new Error(`DEV source missing: ${data.path}`);
        const bytes = await file.arrayBuffer(); if (!this.current() || this.stopped) return;
        this.worker.postMessage({ kind: 'read-result', id: data.id, bytes }, [bytes]);
      } catch (error) { if (!this.stopped) this.worker.postMessage({ kind: 'read-result', id: data.id, error: String(error) }); }
      return;
    }
    const task = this.active;
    if (data.kind !== 'result' || !task || data.id !== task.id || data.session !== this.session || data.key !== task.key) return;
    this.active = null; this.slots.delete(task.key);
    this.releaseGeometry?.(); this.releaseGeometry = null;
    perfMark('DEV worker result', { path: task.path, kind: task.kind, lod: task.lod, key: task.key,
      workerWallMs: data.wallMs, stages: data.stages, bytes: data.result?.bytes?.byteLength ?? 0, error: data.error }, this.perf);
    if (data.error) task.reject(data.sourceEvidence ? new InvalidDevGeometryError(task.path, data.error, data.sourceEvidence) : new Error(data.error));
    else task.resolve(data.result);
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
  bounds(path: string): Promise<DevSourceBounds> { return this.request('bounds', path, 0, `bounds:${path.toLowerCase()}`, 4); }
  promote(key: string, priority: number): void { const slot = this.slots.get(key); if (slot) slot.priority = Math.min(slot.priority, priority); this.pump(); }
  /** Compatibility for explicitly invoked all-device compiler; product uses compile(). */
  take(path: string): Promise<DevGlbSerializationResult> { return this.compile(path, 2, `legacy:${path.toLowerCase()}`, 3); }
  cancelQueued(keep: ReadonlySet<string>): void {
    for (const [key, task] of this.slots) if (task !== this.active && task.kind === 'compile' && !keep.has(key)) {
      this.slots.delete(key); task.reject(new DOMException('DEV request left the current view', 'AbortError'));
    }
  }
  cancel(error = new Error('DEV preprocessing cancelled')): void {
    if (this.stopped) return; this.stopped = true; this.worker.terminate();
    this.releaseGeometry?.(); this.releaseGeometry = null;
    for (const task of this.slots.values()) task.reject(error); this.slots.clear(); this.files = new Map(); this.active = null;
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
