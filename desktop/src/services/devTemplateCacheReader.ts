import { readDevArtifactBatch, type DevArtifactRead, type DevArtifactReadStatus } from '@desktop/devLodCache.js';
import { ByteWorkBudget } from '../utils/byteWorkBudget.js';
interface Lease<T> { status: DevArtifactReadStatus; value?: T; error?: string; release: () => void }
interface Request<T> { key: string; resolve: (lease: Lease<T>) => void; reject: (error: unknown) => void }
/** One reservation covers the whole batch until its last consumer finishes.
 * Native reads defer rows that exceed the remaining byte ceiling. Neither
 * prefetch nor concurrent parsing can bypass the shared cold/warm budget. */
export class DevTemplateCacheReader<T> {
  readonly diagnostics = {
    batches: 0,
    entries: 0,
    deferred: 0,
    hits: 0,
    misses: 0,
    readErrors: 0,
    invalid: 0,
    lastError: '' as string,
  };
  private queue: Request<T>[] = [];
  private running = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private leases = new Set<() => void>();
  constructor(private budget: ByteWorkBudget, private context: { projectId: number | null; sourceSha256: string | null }) {}
  read(key: string): Promise<Lease<T>> {
    if (this.closed) return Promise.reject(new DOMException('DEV cache reader released', 'AbortError'));
    const promise = new Promise<Lease<T>>((resolve, reject) => this.queue.push({ key, resolve, reject }));
    if (!this.running && !this.timer) this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, 0);
    return promise;
  }
  private record(status: DevArtifactReadStatus): void {
    if (status === 'hit') this.diagnostics.hits++;
    else if (status === 'miss') this.diagnostics.misses++;
    else if (status === 'invalid') this.diagnostics.invalid++;
    else if (status === 'read-error') this.diagnostics.readErrors++;
    else if (status === 'deferred') this.diagnostics.deferred++;
  }
  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        let batch: Request<T>[] = [];
        let release: (() => void) | undefined;
        try {
          release = await this.budget.acquire(this.budget.limit);
          if (this.closed) throw new DOMException('DEV cache reader released', 'AbortError');
          batch = this.queue.splice(0, 64);
          let values: Map<string, DevArtifactRead<T>>;
          try {
            values = await readDevArtifactBatch<T>('templates', batch.map((row) => row.key), this.context, this.budget.limit);
          } catch (error) {
            // The bridge already isolates per-row failures. An AbortError is
            // a queue-turnover signal, not a cache fact: reject so the runtime
            // can schedule the still-wanted request again.
            if ((error as Error)?.name === 'AbortError') { for (const row of batch) row.reject(error); continue; }
            values = new Map(batch.map((row) => [row.key, { status: 'read-error' as const, error: String(error) }]));
          }
          if (this.closed) throw new DOMException('DEV cache reader released', 'AbortError');
          const deferred: Request<T>[] = [];
          const terminal: Array<{ row: Request<T>; value: DevArtifactRead<T> }> = [];
          for (const row of batch) {
            const value = values.get(row.key) ?? { status: 'deferred' as const };
            if (value.status === 'deferred') deferred.push(row);
            else terminal.push({ row, value });
          }
          if (!terminal.length) {
            // No row fits this reservation. Resolve as read-error instead of
            // spinning forever; the caller can compile and record the reason.
            for (const row of batch) row.resolve({
              status: 'read-error',
              release: () => { /* no reservation consumed */ },
            });
            this.diagnostics.batches++;
            this.diagnostics.entries += batch.length;
            this.diagnostics.readErrors += batch.length;
            this.diagnostics.lastError = 'batch made no progress';
            continue;
          }
          this.diagnostics.batches++;
          this.diagnostics.entries += terminal.length;
          this.diagnostics.deferred += deferred.length;
          this.queue.unshift(...deferred);
          let remaining = terminal.length;
          const reservation = release;
          release = undefined;
          const finish = (): void => { if (--remaining === 0) reservation(); };
          for (const { row, value } of terminal) {
            let done = false;
            const consume = (): void => { if (done) return; done = true; this.leases.delete(consume); finish(); };
            this.leases.add(consume);
            this.record(value.status);
            row.resolve({ status: value.status, value: value.value, error: value.error, release: consume });
          }
        } catch (error) {
          for (const row of batch) row.reject(error);
        } finally {
          release?.();
        }
      }
    } finally {
      this.running = false;
    }
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const row of this.queue) row.reject(new DOMException('DEV cache reader released', 'AbortError'));
    this.queue = [];
    for (const release of this.leases) release();
    this.leases.clear();
  }
}
