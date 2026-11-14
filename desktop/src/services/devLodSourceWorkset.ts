/** Materialize only a missing template's reachable sources for one session. */
import { batchReadCachedFiles } from '@desktop/database.js';
import type { ProjectLoadSession } from '../shared/projectSession.js';
import { findFileByPath } from '../gim/fileLookup.js';
import { getFileEntryResolver } from '../gim/entryResolver.js';
import { hydrateSubstationGeometryGraph } from '../gim/geometry/substationSourceGraph.js';
import { perfCurrentSession, perfMark } from '../utils/perfTimings.js';
import { type DevGeometryPreprocessor } from './devGeometryWorkerClient.js';
import type { DevLodDiagnostics } from './devLodDiagnostics.js';
import type { MemoryPressure } from './devLodTypes.js';

export interface DevLodSourceWorksetOptions {
  session: ProjectLoadSession;
  perf: ReturnType<typeof perfCurrentSession>;
  diagnostics: DevLodDiagnostics;
  current: () => boolean;
  memoryPressure: () => MemoryPressure;
  worker: () => DevGeometryPreprocessor;
}
export class DevLodSourceWorkset {
  private get worker() { return this.options.worker(); }
  constructor(private readonly options: DevLodSourceWorksetOptions) { }
  sourceFiles?: Map<string, File>;

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

  /** A cache miss needs only the missing DEV's reachable sources.
     * Batch those reads before compiling, instead of serial Worker→UI RPC for
     * each small file. Healthy hits perform no reads; admission is session-wide. */
  prepareMissingTemplateSources(dev: string): Promise<void> {
    if (!this.sourceFiles || this.options.session.projectId == null) return Promise.resolve();
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
            if (expected != null && data.byteLength === expected) {
              const file = new File([data as Uint8Array<ArrayBuffer>], path.split('/').pop()!);
              // Graph traversal needs these already-read bytes as text. Avoid
              // another asynchronous Blob read per edge on a busy renderer.
              // File structured cloning sends its backing data, not this method.
              if (/\.(dev|phm)$/i.test(path)) {
                const text = new TextDecoder().decode(data);
                Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
              }
              loaded.set(path, file);
            } else perfMark('DEV source preparation fallback', { phase:'source-length',reason:'source-length-mismatch',expectedBytes:expected??null,actualBytes:data.byteLength }, this.options.perf);
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
      }, getFileEntryResolver(this.sourceFiles!));
      if (!this.options.current() || pressured()) return;
      // Keep the immutable values for shared dependencies. The path set stays
      // unchanged, so later templates reuse the same package path index.
      for (const [path, file] of prepared) this.sourceFiles!.set(path, file);
      this.worker.installSources(prepared);
      perfMark('DEV missing-template source workset', {
dev, entries: prepared.size, admittedBytes: this.missedSourceBytes - before,
        sessionAdmittedBytes: this.missedSourceBytes
}, this.options.perf);
    }).catch(error => { perfMark('DEV missing-template source fallback', { dev, reason: String(error) }, this.options.perf); });
    this.missedSourcePreparations.set(key, task); this.missedSourceTail = task;
    return task;
  }
  close(): void { this.sourceFiles = undefined;  }
}
