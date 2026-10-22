import { expect, it, vi } from 'vitest';
import { IfcObjectFineRuntime } from '../ifcObjectFineRuntime.js';

const identity = { expressId: 7, globalId: 'g7', key: 'object:7', modelId: 'model',
  sourcePath: 'CBM/model.ifc', ifcType: 'IFCWALL', name: 'wall', provider: 'ifc-object-fine' } as const;
class FineWorker {
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  sent: any[] = [];
  terminate = vi.fn();
  postMessage(message: any) { this.sent.push(message); }
  reply(data: any) { this.onmessage?.({ data: { id: this.sent[this.sent.length - 1].id, data } }); }
}

it('cancel during a source read rejects the old generation without creating or stopping its replacement worker', async () => {
  let resolveRead!: (bytes: Uint8Array) => void;
  const firstRead = new Promise<Uint8Array>(resolve => { resolveRead = resolve; });
  const readBytes = vi.fn().mockReturnValueOnce(firstRead).mockResolvedValue(new Uint8Array([1]));
  const workers: FineWorker[] = [];
  const runtime = new IfcObjectFineRuntime({ wasm: { path: '/', absolute: true }, readBytes,
    worker: () => { const worker = new FineWorker(); workers.push(worker); return worker as any; } });
  try {
    const old = runtime.load(identity);
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    runtime.cancel();
    const next = runtime.load(identity);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    resolveRead(new Uint8Array([2])); await rejected;
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].reply({});
    await vi.waitFor(() => expect(workers[0].sent[workers[0].sent.length - 1].type).toBe('object'));
    workers[0].reply({ parts: [], geometryMs: 1 });
    await expect(next).resolves.toMatchObject({ geometryMs: 1 });
  } finally { runtime.release(); }
});

it('cancel terminates synchronous fine work and a later explicit request gets a fresh worker', async () => {
  const workers: FineWorker[] = [];
  const runtime = new IfcObjectFineRuntime({ wasm: { path: '/', absolute: true }, readBytes: async () => new Uint8Array([1]),
    worker: () => { const worker = new FineWorker(); workers.push(worker); return worker as any; } });
  try {
    const old = runtime.load(identity);
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0].reply({});
    await vi.waitFor(() => expect(workers[0].sent[workers[0].sent.length - 1].type).toBe('object'));
    runtime.cancel(); await rejected;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const next = runtime.load(identity);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    workers[1].reply({});
    await vi.waitFor(() => expect(workers[1].sent[workers[1].sent.length - 1].type).toBe('object'));
    workers[1].reply({ parts: [], geometryMs: 2 });
    await expect(next).resolves.toMatchObject({ geometryMs: 2 });
  } finally { runtime.release(); }
});
