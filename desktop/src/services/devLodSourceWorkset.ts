/** Owns bounded immutable source prefetch and partial-cache source recovery for one session. */
import { batchReadCachedFiles } from '@desktop/database.js';
import { type DevArtifactRead } from '@desktop/devLodCache.js';
import type { ProjectLoadSession } from '../shared/projectSession.js';
import { findFileByPath } from '../gim/fileLookup.js';
import { hydrateSubstationGeometryGraph } from '../gim/geometry/substationSourceGraph.js';
import { perfCurrentSession, perfMark } from '../utils/perfTimings.js';
import { type DeviceLod } from '../viewer/devLodPolicy.js';
import { type DevGeometryPreprocessor } from './devGeometryWorkerClient.js';
import type { DevLodDiagnostics } from './devLodDiagnostics.js';
import type { MemoryPressure } from './devLodTypes.js';
import { type DevSourceBounds } from './devSpatialCatalog.js';

export interface DevLodSourceWorksetOptions {
  session: ProjectLoadSession;
  perf: ReturnType<typeof perfCurrentSession>;
  diagnostics: DevLodDiagnostics;
  current: () => boolean;
  memoryPressure: () => MemoryPressure;
  hasMemorySources: () => boolean;
  ifcPending: () => boolean;
  waitForIfc: () => Promise<void>;
  worker: () => DevGeometryPreprocessor;
}
export class DevLodSourceWorkset {
  private get worker() { return this.options.worker(); }
  constructor(private readonly options: DevLodSourceWorksetOptions) { }
  sourceFiles?: Map<string, File>;

  recoveryMisses = new Set<string>();

  sourceRecoveryAttempted = false;

  missedSourcePreparations = new Map<string, Promise<void>>();

  missedSourceTail = Promise.resolve();

  missedSourceBytes = 0;

  /** Optional preparation must not strand startup on an unavailable reader. */
  private async preparationWait<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DOMException('DEV source preparation timed out', 'TimeoutError')), Math.max(1, timeoutMs));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Share a bounded immutable source workset without holding computation slots.
     * Unknown/oversized sources and failed reads retain their authorized lazy path. */
  async preloadSources(files: Map<string, File>): Promise<Map<string, File>> {
    try { if (localStorage.getItem('gim-dev-preload') === '0') return files; } catch { /* storage unavailable */ }
    const projectId = this.options.session.projectId;
    const pressured = (): boolean => this.options.memoryPressure() === 'high' || this.options.memoryPressure() === 'critical';
    if (projectId == null || !this.options.current() || pressured()) return files;
    // 剩余 IFC 仍在后台加载时最多等 8 秒再预取，避免大批次 IPC 长时间挤占
    // 剩余 IFC 的读取/转换；超时后让预取与 IFC 并行，靠批次让出主线程。
    if (this.options.ifcPending()) {
      const started = performance.now();
      const deadline = started + 8000;
      while (this.options.ifcPending() && this.options.current() && !pressured() && performance.now() < deadline) {
        await Promise.race([
          this.options.waitForIfc(),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      }
      perfMark('DEV 几何源预取等待 IFC', { waitedMs: Math.round(performance.now() - started) },
        this.options.perf);
      if (!this.options.current() || pressured()) return files;
    }
    const MAX_FILE_BYTES = 8 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
    const MAX_BATCH_BYTES = 4 * 1024 * 1024;
    const BATCH_FILES = 4096;
    const rank = (path: string): number => {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      return ext === 'dev' ? 0 : ext === 'phm' ? 1 : ext === 'stl' ? 2 : ext === 'gl' ? 3 : 4;
    };
    const candidates = [...files.keys()]
      .filter((path) => /\.(dev|phm|mod|stl|gl)$/i.test(path))
      .sort((a, b) => rank(a) - rank(b));
    if (candidates.length === 0) return files;
    const output = new Map(files);
    const deadline = performance.now() + 10_000;
    let loaded = 0;
    let next = 0, admitted = 0;
    while (next < candidates.length && admitted < MAX_TOTAL_BYTES) {
      if (!this.options.current() || pressured() || performance.now() >= deadline) break;
      const chunk: string[] = [];
      let batchBytes = 0;
      while (next < candidates.length && chunk.length < BATCH_FILES) {
        const path = candidates[next], size = files.get(path)!.size;
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES || admitted + size > MAX_TOTAL_BYTES) { next++; continue; }
        if (chunk.length && batchBytes + size > MAX_BATCH_BYTES) break;
        next++; admitted += size; batchBytes += size; chunk.push(path);
      }
      if (!chunk.length) continue;
      let result: Map<string, Uint8Array | null> | null = null;
      try {
        result = await this.preparationWait(batchReadCachedFiles(projectId, chunk), deadline - performance.now());
      } catch (error) {
        perfMark('DEV source preparation fallback', { phase: 'source-batch', reason: String(error) }, this.options.perf);
        if ((error as Error)?.name === 'TimeoutError') break;
        result = null;
      }
      if (!this.options.current() || pressured()) break;
      if (!result) continue;
      for (const path of chunk) {
        const bytes = result.get(path);
        if (!bytes || bytes.byteLength === 0 || bytes.byteLength > files.get(path)!.size) continue;
        loaded += bytes.byteLength;
        if (loaded > MAX_TOTAL_BYTES) break;
        output.set(path, new File([bytes as Uint8Array<ArrayBuffer>], path.split('/').pop() || path));
      }
    }
    perfMark('DEV source workset ready', { entries: [...output].filter(([path, file]) => file !== files.get(path)).length, bytes: loaded, admittedBytes: admitted }, this.options.perf);
    return output;
  }

  async prepareSources(files: Map<string, File>, catalogReads: DevArtifactRead<DevSourceBounds>[] = []): Promise<Map<string, File>> {
    // Reuse the normal catalog batch. Healthy warm startup issues no extra probe.
    const derivedMissing = catalogReads.length > 0 && catalogReads.every(read => read.status === 'miss');
    return this.options.hasMemorySources() || derivedMissing ? this.preloadSources(files) : files;
  }

  recoverMissingSources(key: string, lod: DeviceLod): void {
    if (lod !== 0 || this.sourceRecoveryAttempted || !this.sourceFiles || !this.options.current()) return;
    if (this.recoveryMisses.size < 32) this.recoveryMisses.add(key);
    if (this.recoveryMisses.size < Math.min(32, this.options.diagnostics.uniqueDevSources) || this.worker.diagnostics.rpcReads < 32) return;
    this.sourceRecoveryAttempted = true;
    // Sparse warm misses do not justify reading a large station. Only upgrade
    // an entire, small, known-size source workset after real RPC work is seen.
    const files = this.sourceFiles;
    let bytes = 0;
    for (const file of files.values()) {
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 8 * 1024 * 1024) return;
      bytes += file.size;
      if (bytes > 32 * 1024 * 1024) return;
    }
    void this.preloadSources(files).then(prepared => {
      if (!this.options.current()) return;
      this.worker.installSources(prepared);
      perfMark('DEV partial-cache source upgrade', { misses: this.recoveryMisses.size, indexedBytes: bytes }, this.options.perf);
    }).catch(error => { if (this.options.current()) console.warn('[DEV source upgrade]', error); });
  }

  /** A partial warm cache needs only the missing DEV's reachable sources.
     * Batch those reads before compiling, instead of serial Worker→UI RPC for
     * each small file. Healthy hits perform no reads; admission is session-wide. */
  prepareMissingTemplateSources(dev: string): Promise<void> {
    if (this.options.hasMemorySources() || !this.sourceFiles || this.options.session.projectId == null) return Promise.resolve();
    try { if (localStorage.getItem('gim-dev-preload') === '0') return Promise.resolve(); } catch { /* storage unavailable */ }
    const key = dev.toLowerCase(), old = this.missedSourcePreparations.get(key);
    if (old) return old;
    const pressured = () => this.options.memoryPressure() === 'high' || this.options.memoryPressure() === 'critical';
    const task = this.missedSourceTail.then(async () => {
      if (!this.options.current() || pressured()) return;
      const before = this.missedSourceBytes;
      const prepared = await hydrateSubstationGeometryGraph([dev], async paths => {
        const loaded = new Map<string, File>();
        let batch: string[] = [], bytes = 0;
        const flush = async () => {
          if (!batch.length) return;
          const result = await this.preparationWait(batchReadCachedFiles(this.options.session.projectId!, batch), 5000);
          if (!this.options.current() || pressured()) return;
          for (const [path, data] of result) if (data?.byteLength) {
            const expected = findFileByPath(this.sourceFiles!, path)?.file.size;
            if (expected != null && data.byteLength <= expected) {
              const file = new File([data as Uint8Array<ArrayBuffer>], path.split('/').pop()!);
              // Graph traversal needs these already-read bytes as text. Avoid
              // another asynchronous Blob read per edge on a busy renderer.
              // File structured cloning sends its backing data, not this method.
              if (/\.(dev|phm)$/i.test(path)) {
                const text = new TextDecoder().decode(data);
                Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
              }
              loaded.set(path, file);
            }
          }
          batch = []; bytes = 0;
        };
        for (const path of paths) {
          if (!this.options.current() || pressured()) break;
          const source = findFileByPath(this.sourceFiles!, path);
          if (!source) continue;
          const file = this.sourceFiles!.get(source.path)!;
          const size = file.size;
          if (file instanceof File) { loaded.set(source.path, file); continue; }
          if (!Number.isSafeInteger(size) || size <= 0 || size > 8 * 1024 * 1024 || this.missedSourceBytes + size > 32 * 1024 * 1024) continue;
          if (batch.length && bytes + size > 4 * 1024 * 1024) await flush();
          if (!this.options.current() || pressured()) break;
          this.missedSourceBytes += size; bytes += size; batch.push(source.path);
        }
        if (this.options.current() && !pressured()) await flush();
        return loaded;
      }, this.sourceFiles!.keys());
      if (!this.options.current() || pressured()) return;
      this.worker.installSources(prepared);
      perfMark('DEV missing-template source workset', {
dev, entries: prepared.size, admittedBytes: this.missedSourceBytes - before,
        sessionAdmittedBytes: this.missedSourceBytes
}, this.options.perf);
    }).catch(error => { perfMark('DEV missing-template source fallback', { dev, reason: String(error) }, this.options.perf); });
    this.missedSourcePreparations.set(key, task); this.missedSourceTail = task;
    return task;
  }
  close(): void { this.sourceFiles = undefined; this.recoveryMisses.clear(); }
}
