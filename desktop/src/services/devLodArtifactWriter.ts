/** Owns bounded asynchronous artifact admission, persistence and cancellation. */
import { prepareDevArtifact, writeDevArtifactDetailed } from '@desktop/devLodCache.js';
import type { ProjectLoadSession } from '../app/state.js';
import { ByteWorkBudget } from '../utils/byteWorkBudget.js';
import { perfCurrentSession, perfRecordTaskPhase, type PerfTaskIdentity } from '../utils/perfTimings.js';
import { type DeviceLod } from '../viewer/devLodPolicy.js';
import type { DevLodDiagnostics } from './devLodDiagnostics.js';

export interface DevLodArtifactWriterOptions {
  session: ProjectLoadSession;
  perf: ReturnType<typeof perfCurrentSession>;
  diagnostics: DevLodDiagnostics;
  current: () => boolean;
  requestReady: () => void;
  taskIdentity: (source: string, kind: string, lod?: DeviceLod, priority?: number) => PerfTaskIdentity;
  recordCacheDecision: (dev: string, lod: DeviceLod, status: 'write-failed', reason?: string) => void;
}
export class DevLodArtifactWriter {
  constructor(private readonly options: DevLodArtifactWriterOptions) { }
  /** Admitted writes own at most one maximum asset plus metadata (129 MiB).
    * Waiting template buffers retain their input lease until writer admission. */
  private writeBudget = new ByteWorkBudget(129 * 1024 * 1024);

  private writeWaitingBytes = 0;

  private writeSlots = 0;

  private writeWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  private pendingWrites = new Map<string, Promise<void>>();

  private writeAdmissions = new Map<string, Promise<void>>();

  private async withWriteSlot<T>(work: () => Promise<T>): Promise<T> {
    while (this.writeSlots >= 4) {
      if (!this.options.current()) throw new DOMException('DEV cache write cancelled', 'AbortError');
      await new Promise<void>((resolve, reject) => this.writeWaiters.push({ resolve, reject }));
    }
    if (!this.options.current()) throw new DOMException('DEV cache write cancelled', 'AbortError');
    this.writeSlots++;
    try { return await work(); }
    finally { this.writeSlots--; this.writeWaiters.shift()?.resolve(); }
  }

  updateWriteDiagnostics(): void {
    Object.assign(this.options.diagnostics, {
cacheWriteReservedBytes: this.writeBudget.bytes, cacheWritePeakBytes: this.writeBudget.peakBytes,
      cacheWriteWaitingBytes: this.writeWaitingBytes, cacheWritePendingCount: this.pendingWrites.size,
      cacheWritesSettled: this.pendingWrites.size === 0,
      cacheWritesReady: this.pendingWrites.size === 0 && this.options.diagnostics.artifactWriteFailures === 0 && this.options.diagnostics.cacheWriteCancelled === 0
});
  }

  /** Persist a derived artifact without blocking geometry availability.
     * Source SHA, project identity and atomic native replacement still apply. */
  persistArtifact(store: 'templates' | 'catalog', key: string, value: unknown, lod?: DeviceLod, devPath?: string,
    trace?: PerfTaskIdentity, inputHandoff?: () => void): Promise<void> {
    let releasedInput = false;
    const releaseInput = (): void => { if (!releasedInput) { releasedInput = true; inputHandoff?.(); } };
    if (!this.options.current() || !this.options.session.sourceSha256) { releaseInput(); return Promise.resolve(); }
    const queueKey = `${store}:${key}`;
    if (this.pendingWrites.has(queueKey)) { releaseInput(); return this.writeAdmissions.get(queueKey) ?? Promise.resolve(); }
    const identity = trace ?? this.options.taskIdentity(devPath ?? key, `${store}-write`, lod);
    const queuedAt = performance.now();
    let prepared: ReturnType<typeof prepareDevArtifact>;
    try { prepared = prepareDevArtifact(key, value); }
    catch (error) {
      perfRecordTaskPhase(identity, 'cachePrepare', performance.now() - queuedAt, this.options.perf, 'failed');
      releaseInput(); this.options.diagnostics.artifactWriteFailures++;
      this.options.diagnostics.errors.push(`缓存准备失败 ${store}:${key}: ${String(error)}`);
      if (this.options.diagnostics.errors.length > 32) this.options.diagnostics.errors.shift();
      this.updateWriteDiagnostics(); return Promise.resolve();
    }
    perfRecordTaskPhase(identity, 'cachePrepare', performance.now() - queuedAt, this.options.perf, 'completed', prepared.retainedBytes);
    this.writeWaitingBytes += prepared.retainedBytes;
    const admission = this.writeBudget.acquire(prepared.retainedBytes).finally(() => {
      this.writeWaitingBytes -= prepared.retainedBytes; releaseInput(); this.updateWriteDiagnostics();
    });
    const admitted = admission.then(() => undefined, () => undefined);
    let enteredWrite = false;
    const task = admission.then(async releaseWrite => {
      try {
        await this.withWriteSlot(async () => {
          if (!this.options.current()) return;
          enteredWrite = true;
          perfRecordTaskPhase(identity, 'cacheWriteQueue', performance.now() - queuedAt, this.options.perf);
          this.options.diagnostics.artifactWriteAttempts++;
          const writeAt = performance.now();
          let detail: Awaited<ReturnType<typeof writeDevArtifactDetailed>>;
          try { detail = await writeDevArtifactDetailed(store, key, value, this.options.session, prepared); }
          catch (error) { perfRecordTaskPhase(identity, 'cacheWrite', performance.now() - writeAt, this.options.perf, 'failed'); throw error; }
          perfRecordTaskPhase(identity, 'cacheWrite', performance.now() - writeAt, this.options.perf, detail.ok ? 'completed' : 'failed');
          if (!detail.ok) {
            if (store === 'catalog') this.options.diagnostics.catalogWriteFailures++;
            else if (lod != null) {
              this.options.diagnostics.lodWriteFailed[lod]++;
              this.options.recordCacheDecision(devPath ?? '', lod, 'write-failed', detail.error);
            }
            this.options.diagnostics.artifactWriteFailures++;
            this.options.diagnostics.errors.push(`缓存写入失败 ${store}:${key}: ${detail.error ?? 'unknown'}`);
            if (this.options.diagnostics.errors.length > 32) this.options.diagnostics.errors.shift();
          } else if (store === 'templates' && lod != null) {
            this.options.diagnostics.lodPersisted[lod]++;
          }
        });
      } finally { releaseWrite(); }
    }).catch((error) => {
      if (!enteredWrite) perfRecordTaskPhase(identity, 'cacheWriteQueue', performance.now() - queuedAt, this.options.perf,
        (error as Error)?.name === 'AbortError' ? 'cancelled' : 'failed');
      if ((error as Error)?.name === 'AbortError') { this.options.diagnostics.cacheWriteCancelled++; return; }
      this.options.diagnostics.artifactWriteFailures++;
      this.options.diagnostics.errors.push(`缓存写入异常 ${store}:${key}: ${String(error)}`);
      if (this.options.diagnostics.errors.length > 32) this.options.diagnostics.errors.shift();
    }).finally(() => {
      this.pendingWrites.delete(queueKey); this.writeAdmissions.delete(queueKey); this.updateWriteDiagnostics(); this.options.requestReady();
    });
    this.pendingWrites.set(queueKey, task);
    this.writeAdmissions.set(queueKey, admitted); this.updateWriteDiagnostics();
    return admitted;
  }
  close(): void {
    this.writeBudget.close();
    for (const waiter of this.writeWaiters) waiter.reject(new DOMException('DEV cache write cancelled', 'AbortError'));
    this.writeWaiters = [];
  }
}
