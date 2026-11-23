/** Supply reachable sources without making an unrelated DEV wait for a slow root. */
import { batchReadCachedFiles } from '../../infrastructure/native/projectFiles.js';
import type { ProjectLoadSession } from '../../shared/projectSession.js';
import { findFileByPath } from '../../gim/fileLookup.js';
import { getFileEntryResolver } from '../../gim/entryResolver.js';
import { hydrateSubstationGeometryGraph } from '../../gim/geometry/substationSourceGraph.js';
import { perfCurrentSession, perfMark } from '../../utils/perfTimings.js';
import type { DevGeometryPreprocessor } from './devGeometryWorkerClient.js';
import type { DevLodDiagnostics } from './devLodDiagnostics.js';
import type { MemoryPressure } from './devLodTypes.js';
import { reportBackgroundError } from '../../utils/backgroundErrors.js';
import { WorkQueue } from '../../utils/workQueue.js';

const sourceTextDecoder = new TextDecoder();

export interface DevLodSourceWorksetOptions {
  session: ProjectLoadSession;
  perf: ReturnType<typeof perfCurrentSession>;
  diagnostics: DevLodDiagnostics;
  current: () => boolean;
  memoryPressure: () => MemoryPressure;
  worker: () => DevGeometryPreprocessor;
}
interface FileRead {
  path: string;
  size: number;
  queuedAt: number;
  required: boolean;
  started: boolean;
  resolve: (file: File | undefined) => void;
}
export class DevLodSourceWorkset {
  constructor(private readonly options: DevLodSourceWorksetOptions) {}
  sourceFiles?: Map<string, File>;
  missedSourcePreparations = new Map<string, Promise<void>>();
  missedSourceBytes = 0;
  private roots: Array<{ dev: string; queuedAt: number; resolve: () => void }> = [];
  private rootsRunning = 0;
  private reads = new WorkQueue<FileRead>();
  private readsRunning = 0;
  private scheduled = false;
  private closed = false;
  private inflight = new Map<string, { row: FileRead; promise: Promise<File | undefined> }>();
  private references = new Map<string, Promise<readonly string[]>>();
  private current = () => !this.closed && this.options.current();
  private pressured = () => ['high', 'critical'].includes(this.options.memoryPressure());

  prepareMissingTemplateSources(dev: string): Promise<void> {
    if (!this.sourceFiles || this.options.session.projectId == null || !this.current())
      return Promise.resolve();
    try {
      if (localStorage.getItem('gim-dev-preload') === '0') return Promise.resolve();
    } catch {
      /* no storage */
    }
    const key = dev.toLowerCase(),
      old = this.missedSourcePreparations.get(key);
    if (old) return old;
    const task = new Promise<void>((resolve) =>
      this.roots.push({ dev, queuedAt: performance.now(), resolve }),
    );
    this.missedSourcePreparations.set(key, task);
    this.drainRoots();
    return task;
  }
  private drainRoots(): void {
    // Independent roots complete on their own dependencies; native reads are
    // separately coalesced and bounded to avoid duplicate shared-source I/O.
    // Admit one catalog window, rather than splitting its small source reads
    // into groups of eight roots. Native I/O stays at two bounded batches.
    while (this.current() && this.rootsRunning < 64 && this.roots.length) {
      const row = this.roots.shift()!;
      this.rootsRunning++;
      void this.prepare(row.dev, performance.now() - row.queuedAt)
        .catch((error) =>
          perfMark(
            'DEV missing-template source fallback',
            { dev: row.dev, reason: String(error) },
            this.options.perf,
          ),
        )
        .finally(() => {
          this.rootsRunning--;
          row.resolve();
          this.drainRoots();
        });
    }
  }
  private async prepare(dev: string, queueWaitMs: number): Promise<void> {
    if (!this.current() || this.pressured() || !this.sourceFiles) return;
    const started = performance.now();
    const prepared = await hydrateSubstationGeometryGraph(
      [dev],
      async (paths) => {
        const rows = await Promise.all(paths.map((path) => this.read(path)));
        return new Map(rows.flatMap((file, i) => (file ? [[paths[i], file] as const] : [])));
      },
      getFileEntryResolver(this.sourceFiles),
      this.references,
    );
    if (this.current())
      perfMark(
        'DEV missing-template source workset',
        {
          dev,
          entries: prepared.size,
          queueWaitMs,
          prepareMs: performance.now() - started,
          sessionAdmittedBytes: this.missedSourceBytes,
        },
        this.options.perf,
      );
  }
  /** An executing Worker needs this source even when speculative preparation
   * is paused. Reuse the same bounded queue and publish it once to every Worker. */
  readForWorker(path: string): Promise<File | undefined> {
    return this.read(path, true);
  }
  private read(path: string, required = false): Promise<File | undefined> {
    if (!this.sourceFiles || this.options.session.projectId == null || !this.current())
      return Promise.resolve(undefined);
    const source = findFileByPath(this.sourceFiles, path);
    if (!source) return Promise.resolve(undefined);
    const size = source.file.size;
    if (source.file instanceof File) return Promise.resolve(source.file);
    const old = this.inflight.get(source.path);
    if (old) {
      if (required && !old.row.required) {
        old.row.required = true;
        if (!old.row.started) this.reads.set(source.path, old.row, 0, old.row.queuedAt);
      }
      return old.promise;
    }
    if (this.pressured() && !required) return Promise.resolve(undefined);
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > 8 * 1024 * 1024 ||
      this.missedSourceBytes + size > 128 * 1024 * 1024
    )
      return Promise.resolve(undefined);
    this.missedSourceBytes += size;
    let row!: FileRead;
    const promise = new Promise<File | undefined>((resolve) => {
      row = {
        path: source.path,
        size,
        queuedAt: performance.now(),
        required,
        started: false,
        resolve,
      };
    });
    this.reads.set(source.path, row, required ? 0 : 1, row.queuedAt);
    this.inflight.set(source.path, { row, promise });
    this.scheduleReads();
    return promise;
  }
  private scheduleReads(): void {
    if (this.scheduled || !this.current()) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drainReads();
    });
  }
  private drainReads(): void {
    while (this.current() && this.readsRunning < 2 && this.reads.size) {
      const batch: FileRead[] = [];
      let bytes = 0;
      while (this.reads.size && batch.length < 256) {
        const [path, row] = this.reads.take()!;
        if (batch.length && bytes + row.size > 4 * 1024 * 1024) {
          this.reads.set(path, row, row.required ? 0 : 1, row.queuedAt);
          break;
        }
        row.started = true;
        batch.push(row);
        bytes += row.size;
      }
      this.readsRunning++;
      void this.load(batch)
        .finally(() => {
          this.readsRunning--;
          this.scheduleReads();
        })
        .catch(reportBackgroundError);
    }
  }
  private async load(batch: FileRead[]): Promise<void> {
    const started = performance.now(),
      queueWaitMs = Math.max(...batch.map((row) => started - row.queuedAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Map<string, File>();
    try {
      const result = await Promise.race([
        batchReadCachedFiles(
          this.options.session.projectId!,
          batch.map((row) => row.path),
          this.current,
          { borrowPayload: true },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error('DEV source preparation timed out')), 5000);
        }),
      ]);
      if (!this.current()) return;
      for (const row of batch) {
        if (this.pressured() && !row.required) continue;
        const data = result.get(row.path);
        if (!data || data.byteLength !== row.size) continue;
        const file = new File([data as Uint8Array<ArrayBuffer>], row.path.split('/').pop()!);
        if (/\.(dev|phm)$/i.test(row.path)) {
          const text = sourceTextDecoder.decode(data);
          Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
        }
        loaded.set(row.path, file);
      }
      // Publish each completed batch before root discovery finishes, so bounds
      // and compilation reuse it without another native read.
      this.options.worker().installSources(loaded);
      for (const [path, file] of loaded) this.sourceFiles!.set(path, file);
      perfMark(
        'DEV source batch ready',
        {
          entries: loaded.size,
          bytes: [...loaded.values()].reduce((sum, file) => sum + file.size, 0),
          queueWaitMs,
          readMs: performance.now() - started,
        },
        this.options.perf,
      );
    } catch (error) {
      if (this.current())
        perfMark('DEV source preparation fallback', { reason: String(error) }, this.options.perf);
    } finally {
      if (timer) clearTimeout(timer);
      for (const row of batch) {
        this.inflight.delete(row.path);
        row.resolve(loaded.get(row.path));
      }
    }
  }
  close(): void {
    this.closed = true;
    this.sourceFiles = undefined;
    this.references.clear();
    for (const row of this.roots) row.resolve();
    this.roots = [];
    while (this.reads.size) this.reads.take()![1].resolve(undefined);
    this.inflight.clear();
  }
}
