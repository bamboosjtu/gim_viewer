import measuredWorkerAsset from './ifcObjectFineWorker.ts?worker&url';
import { createMeasuredWorker, measurementWorkerUrl } from '../measurement/hostWorker.js';
import type { IfcObjectIdentity } from './ifcObjectIdentity.js';
import type { ObjectFineResult } from './ifcObjectFineData.js';
import type { LoaderSettings } from 'web-ifc';

/** Experimental session-owned Worker. Bounded request timeout terminates synchronous WASM too. */
export class IfcObjectFineRuntime {
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private opened: Promise<unknown> | null = null;
  private tasks = new Map<number, { globalId: string; task: Promise<ObjectFineResult> }>();
  private released = false;
  private generation = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private options: {
      wasm: { path: string; absolute: boolean };
      readBytes: () => Promise<Uint8Array | null>;
      webIfcSettings?: LoaderSettings;
      sourcePath?: string;
      timeoutMs?: number;
      worker?: () => Worker;
      onTiming?: (data: Record<string, unknown>) => void;
    },
  ) {}
  private send<T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    if (!this.worker) return Promise.reject(new Error('Object fine model unavailable'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.stop(new Error('Object fine request exceeded fixed budget')),
        this.options.timeoutMs ?? 30000,
      );
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.worker!.postMessage({ ...message, id }, transfer);
    });
  }
  private async open(): Promise<void> {
    if (this.released) throw new Error('Object fine released');
    const generation = this.generation;
    const started = performance.now();
    const bytes = await this.options.readBytes();
    if (this.released || generation !== this.generation)
      throw new DOMException('Object fine cancelled', 'AbortError');
    if (!bytes) throw new Error('IFC source not materialized');
    this.options.onTiming?.({
      stage: 'source-read',
      durationMs: performance.now() - started,
      rawBytes: bytes.byteLength,
    });
    this.worker =
      this.options.worker?.() ??
      createMeasuredWorker(
        'ifc-fine',
        (identity) =>
          new Worker(measurementWorkerUrl(measuredWorkerAsset, identity), {
            type: 'module',
            ...(identity ? { name: identity } : {}),
          }),
        this.options.sourcePath,
      );
    this.worker.onmessage = ({
      data,
    }: MessageEvent<{ id: number; error?: string; data: unknown }>) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.data);
    };
    this.worker.onerror = (e) => this.stop(new Error(e.message));
    const owned =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : new Uint8Array(bytes);
    const info = await this.send<Record<string, unknown>>(
      {
        type: 'open',
        bytes: owned,
        wasm: this.options.wasm,
        webIfcSettings: this.options.webIfcSettings,
      },
      [owned.buffer],
    );
    this.options.onTiming?.({ stage: 'open', ...info });
  }
  load(object: IfcObjectIdentity): Promise<ObjectFineResult> {
    if (this.released) return Promise.reject(new Error('Object fine released'));
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    const existing = this.tasks.get(object.expressId);
    if (existing)
      return existing.globalId === object.globalId
        ? existing.task
        : Promise.reject(new Error('IFC object identity mismatch'));
    const generation = this.generation;
    if (!this.opened)
      this.opened = this.open().catch((error: unknown) => {
        if (generation === this.generation)
          this.stop(error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
    const task = this.opened
      .then(() => {
        if (generation !== this.generation)
          throw new DOMException('Object fine cancelled', 'AbortError');
        return this.send<ObjectFineResult>({
          type: 'object',
          expressId: object.expressId,
          globalId: object.globalId,
        });
      })
      .then((result: ObjectFineResult) => {
        this.options.onTiming?.({
          stage: 'object',
          expressId: object.expressId,
          geometryMs: result.geometryMs,
          wasmHeapBytes: result.wasmHeapBytes,
        });
        this.armIdle();
        return result;
      });
    this.tasks.set(object.expressId, { globalId: object.globalId, task });
    void task.catch(() => {
      if (this.tasks.get(object.expressId)?.task === task) this.tasks.delete(object.expressId);
    });
    return task;
  }
  hasModel(): boolean {
    return !!this.opened;
  }
  forget(expressId: number): void {
    this.tasks.delete(expressId);
  }
  /** The owner calls this after dropping its last consumer. A synchronous
   * WASM call is interruptible only by terminating its dedicated worker. */
  cancel(): void {
    this.stop(new DOMException('IFC precision request cancelled', 'AbortError'));
  }
  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    if (!this.released && this.worker && this.pending.size === 0)
      this.idle = setTimeout(() => this.stop(new Error('Object metadata idle released')), 60000);
  }
  properties(expressId: number): Promise<unknown> {
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    return Promise.resolve(this.opened)
      .then(() => this.send({ type: 'properties', expressId }))
      .finally(() => this.armIdle());
  }
  private stop(error: Error): void {
    this.generation++;
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.opened = null;
    this.tasks.clear();
    this.options.onTiming?.({ stage: 'released', reason: error.message, wasmHeapBytes: 0 });
  }
  release(): void {
    this.released = true;
    this.stop(new Error('Object fine released'));
  }
}
