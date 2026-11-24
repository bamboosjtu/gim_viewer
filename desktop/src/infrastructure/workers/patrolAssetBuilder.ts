import type { PatrolPart, PatrolAsset } from '../../shared/patrolSpatialAsset.js';

/** The caller serializes local builds. Dispose rejects an outstanding transfer. */
export class PatrolAssetBuilder {
  private worker?: Worker;
  private next = 0;
  private readonly jobs = new Map<
    number,
    { resolve: (a: PatrolAsset) => void; reject: (e: Error) => void }
  >();
  build(parts: PatrolPart[]): Promise<PatrolAsset> {
    if (!this.worker) {
      this.worker = new Worker(
        new URL('../../viewer/patrol/collision/patrolWorker.ts', import.meta.url),
        { type: 'module' },
      );
      this.worker.onmessage = ({
        data,
      }: MessageEvent<{ id: number; asset: PatrolAsset } | { id: number; error: string }>) => {
        const job = this.jobs.get(data.id);
        if (!job) return;
        this.jobs.delete(data.id);
        if ('error' in data) job.reject(Error(data.error));
        else job.resolve(data.asset);
      };
      this.worker.onerror = (event) => this.dispose(Error(event.message));
    }
    const worker = this.worker,
      id = ++this.next;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      try {
        worker.postMessage(
          { id, parts },
          Array.from(
            new Set(parts.flatMap((p) => [p.positions.buffer, p.indices.buffer])),
          ) as ArrayBuffer[],
        );
      } catch (error) {
        this.jobs.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  dispose(error: Error = new DOMException('巡视已结束', 'AbortError')) {
    this.worker?.terminate();
    this.worker = undefined;
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
  }
}
