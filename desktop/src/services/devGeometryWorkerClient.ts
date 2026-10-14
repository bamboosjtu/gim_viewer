import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { DevGlbSerializationResult } from './glbCacheService.js';
import { InvalidDevGeometryError } from '../gim/geometry/sourceGeometryError.js';
import { collectCbmDeviceInstances } from './modAutoLoadService.js';
import { perfCurrentSession, perfMark } from '../utils/perfTimings.js';

interface Slot { promise: Promise<DevGlbSerializationResult>; resolve: (value: DevGlbSerializationResult) => void; reject: (error: Error) => void }
const clients = new WeakMap<AppState, DevGeometryPreprocessor>();

/** One worker per project; at most two unconsumed DEV results, no IFC bytes. */
export class DevGeometryPreprocessor {
  private worker: Worker;
  private slots = new Map<string, Slot>();
  private next = 0;
  private busy = false;
  private stopped = false;
  private retainedBytes = 0;
  private sizes = new Map<string, number>();
  private currentPath: string | null = null;
  private readonly perf = perfCurrentSession();
  constructor(private paths: string[], private files: Map<string, File>, private current: () => boolean) {
    this.worker = new Worker(new URL('./devGeometryWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => { void this.receive(data); };
    this.worker.onerror = event => this.cancel(new Error(event.message || 'DEV geometry worker failed'));
    this.worker.postMessage({ kind: 'init', files: [...files].filter(([p]) => /\.(dev|phm|mod|stl|gl)$/i.test(p)).map(([p, f]) => [p, f.size]) });
    this.pump();
  }
  private pump(): void {
    if (!this.current()) { this.cancel(); return; }
    if (this.stopped || this.busy || this.slots.size >= 2 || this.retainedBytes >= 32 * 1024 * 1024) return;
    const path = this.paths[this.next++];
    if (!path) { if (!this.slots.size) this.cancel(); return; }
    let resolve!: Slot['resolve'], reject!: Slot['reject'];
    const promise = new Promise<DevGlbSerializationResult>((res, rej) => { resolve = res; reject = rej; });
    void promise.catch(() => {}); // Prefetch failures are reported when consumed.
    this.slots.set(path.toLowerCase(), { promise, resolve, reject });
    this.busy = true; this.currentPath = path;
    this.worker.postMessage({ kind: 'compile', path });
  }
  private async receive(data: any): Promise<void> {
    if (this.stopped) return;
    if (!this.current()) { this.cancel(); return; }
    if (data.kind === 'read') {
      try {
        const file = this.files.get(data.path);
        if (!file) throw new Error(`DEV source missing: ${data.path}`);
        const bytes = await file.arrayBuffer();
        if (!this.current() || this.stopped) return;
        this.worker.postMessage({ kind: 'read-result', id: data.id, bytes }, [bytes]);
      } catch (error) {
        if (!this.stopped) this.worker.postMessage({ kind: 'read-result', id: data.id, error: String(error) });
      }
      return;
    }
    if (data.kind !== 'result' || data.path !== this.currentPath) return;
    const key = data.path.toLowerCase(), slot = this.slots.get(key);
    this.busy = false; this.currentPath = null;
    const size = data.result?.bytes?.byteLength ?? 0;
    this.sizes.set(key, size); this.retainedBytes += size;
    perfMark('DEV worker compiled', { path: data.path, durationMs: data.durationMs, bytes: size, error: data.error }, this.perf);
    if (data.error) slot?.reject(data.sourceEvidence
      ? new InvalidDevGeometryError(data.path, data.error, data.sourceEvidence) : new Error(data.error));
    else slot?.resolve(data.result);
    this.pump();
  }
  async take(path: string): Promise<DevGlbSerializationResult> {
    const key = path.toLowerCase();
    this.pump();
    const slot = this.slots.get(key);
    if (!slot) throw new Error(`DEV preprocessing order/session mismatch: ${path}`);
    try { return await slot.promise; }
    finally {
      this.slots.delete(key); this.retainedBytes -= this.sizes.get(key) ?? 0; this.sizes.delete(key);
      this.pump();
    }
  }
  cancel(error = new Error('DEV preprocessing cancelled')): void {
    if (this.stopped) return;
    this.stopped = true; this.worker.terminate();
    for (const slot of this.slots.values()) slot.reject(error);
    this.slots.clear(); this.sizes.clear(); this.files = new Map(); this.retainedBytes = 0;
  }
}

export function startDevGeometryPreprocessing(state: AppState, session: ProjectLoadSession): void {
  if (clients.has(state) || !state.currentFiles || !state.currentCbmTree || typeof Worker === 'undefined') return;
  const paths = [...new Map(collectCbmDeviceInstances(state.currentCbmTree).filter(n => n.devPath).map(n => {
    const raw = n.devPath!.replace(/\\/g, '/'), path = /^dev\//i.test(raw) ? raw : `DEV/${raw}`;
    return [path.toLowerCase(), path];
  })).values()];
  if (paths.length) clients.set(state, new DevGeometryPreprocessor(paths, state.currentFiles, () => state.isCurrentSession(session)));
}
export function getDevGeometryPreprocessor(state: AppState) { return clients.get(state); }
export function cancelDevGeometryPreprocessing(state: AppState): void {
  clients.get(state)?.cancel(); clients.delete(state);
}
