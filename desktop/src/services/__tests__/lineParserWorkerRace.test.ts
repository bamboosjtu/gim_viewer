import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LineParserWorkerResponse } from '../lineParserWorker.js';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<LineParserWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: unknown[] = [];

  constructor(_url: URL, _options: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  postMessage(request: unknown, _transfer: Transferable[]): void {
    this.requests.push(request);
  }

  emit(response: LineParserWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<LineParserWorkerResponse>);
  }

  terminate(): void { /* test double */ }
}

describe('Line Parser Worker session race', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.instances.length = 0;
    vi.resetModules();
  });

  it('A 结果晚于 B 时，客户端拒绝 A，仅交付 B', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    // 不使用 Vite 专用的 query suffix：tsc 无法为该虚拟模块解析声明，且
    // terminateLineParserWorker 已确保每次测试结束时模块状态被清理。
    const { parseLineInWorker, terminateLineParserWorker } = await import('../lineParserWorkerClient.js');
    const sessionA = { generation: 1, projectId: 1, sourceSha256: 'A', geometryToken: 1 };
    const sessionB = { generation: 2, projectId: 2, sourceSha256: 'B', geometryToken: 2 };
    const files = [{ path: 'CBM/project.cbm', bytes: new TextEncoder().encode('').buffer }];
    const promiseA = parseLineInWorker(files, sessionA);
    const instance = FakeWorker.instances[0];
    const requestA = instance.requests[0] as { requestId: number; session: typeof sessionA };
    const promiseB = parseLineInWorker(files, sessionB);
    const requestB = instance.requests[1] as { requestId: number; session: typeof sessionB };
    const emptyGraph = {
      projectType: 'transmission_line' as const,
      root: null,
      nodesByPath: new Map(),
      filesByType: { cbm: [], dev: [], fam: [], phm: [], mod: [], stl: [], ifc: [], other: [] },
      stats: {},
    };
    const timings = { decodeMs: 0, graphMs: 0, attributesMs: 0, totalMs: 0, fileCount: 1, bytes: 0, cacheEntries: 1 };
    instance.emit({
      type: 'result', requestId: requestA.requestId, session: requestA.session,
      graph: emptyGraph, attributes: { famPayloads: [], devPayloads: [], unmatchedRefs: [] }, timings,
    });
    instance.emit({
      type: 'result', requestId: requestB.requestId, session: requestB.session,
      graph: emptyGraph, attributes: { famPayloads: [], devPayloads: [], unmatchedRefs: [] }, timings,
    });
    await expect(promiseA).rejects.toThrow('过期');
    await expect(promiseB).resolves.toMatchObject({ timings: { worker: true } });
    terminateLineParserWorker();
  });
});
