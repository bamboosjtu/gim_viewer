import { afterEach, expect, it, vi } from 'vitest';
import { DevGeometryPreprocessor } from '../devGeometryWorkerClient.js';
import { beginIfcGeometryWork, ifcGeometryBusy } from '../../viewer/geometryWorkGate.js';

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  sent: any[] = [];
  terminate = vi.fn();
  constructor() { ControlledWorker.instances.push(this); }
  postMessage(data: any) { this.sent.push(data); }
  complete(error?: string) {
    const task = [...this.sent].reverse().find(data => data.kind === 'compile' || data.kind === 'bounds');
    this.onmessage?.({ data: { ...task, kind: 'result', error, result: { status: 'ready', bytes: new Uint8Array([1]), diagnostics: {} }, wallMs: 1, stages: {} } });
  }
}
afterEach(() => { vi.unstubAllGlobals(); ControlledWorker.instances = []; });
it('compiles alongside IFC, deduplicates templates, prioritizes queued selection and bounds exported results until commit', async () => {
  vi.stubGlobal('Worker', ControlledWorker); vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8 });
  const releaseIfc = await beginIfcGeometryWork();
  const source = new File(['<Device/>'], 'a.mod');
  const client = new DevGeometryPreprocessor([], new Map([['MOD/a.mod', source]]), () => true);
  try {
    const a = client.compile('DEV/a.dev', 0, 'a', 3), b = client.compile('DEV/b.dev', 0, 'b', 3);
    expect(client.compile('DEV/b.dev', 0, 'b', 3)).toBe(b);
    const selected = client.compile('DEV/c.dev', 2, 'c', 0);
    const [first, second] = ControlledWorker.instances;
    expect(first.sent[0].files).toEqual([['MOD/a.mod', source.size, source]]);
    expect(ifcGeometryBusy()).toBe(true); expect(client.workerCount).toBe(2);
    expect(first.sent.filter(data => data.kind === 'compile')).toHaveLength(1);
    first.complete(); await a;
    expect(first.sent.filter(data => data.kind === 'compile')).toHaveLength(1);
    client.acknowledge('a');
    expect(first.sent[first.sent.length - 1]).toMatchObject({ kind: 'compile', key: 'c', lod: 2 });
    first.complete(); second.complete(); await Promise.all([selected, b]);
    client.acknowledge('c'); client.acknowledge('b');
    expect(client.activePaths).toEqual([]);
  } finally { client.cancel(); releaseIfc(); }
});
it('a low-memory device uses one worker and a stale session terminates every worker without another request', async () => {
  vi.stubGlobal('Worker', ControlledWorker); vi.stubGlobal('navigator', { hardwareConcurrency: 16, deviceMemory: 2 });
  let current = true;
  const client = new DevGeometryPreprocessor([], new Map(), () => current);
  const task = client.compile('DEV/a.dev', 0, 'a', 3), rejected = expect(task).rejects.toThrow('cancelled');
  expect(client.workerCount).toBe(1); current = false;
  ControlledWorker.instances[0].complete(); await rejected;
  expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
