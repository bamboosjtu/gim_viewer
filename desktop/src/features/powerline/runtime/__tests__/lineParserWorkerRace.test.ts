import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../../../app/state.js';
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

  terminate = vi.fn();
}

describe('Line Parser Worker session race', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.instances.length = 0;
    vi.resetModules();
  });

  it('terminates the previous scope and rejects its late result or error without disturbing the replacement', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { parseLineInWorker } = await import('../lineParserWorkerClient.js');
    const state = new AppState();
    const sessionA = state.activateProject(1, 'A');
    const files = [{ path: 'CBM/project.cbm', bytes: new TextEncoder().encode('').buffer }];
    const promiseA = parseLineInWorker(files, state.sessionScope(sessionA));
    const abandoned = expect(promiseA).rejects.toMatchObject({ name: 'StaleSessionError' });
    const first = FakeWorker.instances[0];
    const requestA = first.requests[0] as { requestId: number; session: typeof sessionA };
    const receive = first.onmessage, fail = first.onerror;
    const sessionB = state.activateProject(2, 'B');
    const promiseB = parseLineInWorker(files, state.sessionScope(sessionB));
    const second = FakeWorker.instances[1];
    const requestB = second.requests[0] as { requestId: number; session: typeof sessionB };
    const emptyGraph = {
      projectType: 'transmission_line' as const,
      root: null,
      nodesByPath: new Map(),
      filesByType: { cbm: [], dev: [], fam: [], phm: [], mod: [], stl: [], ifc: [], other: [] },
      stats: {},
    };
    const timings = { decodeMs: 0, graphMs: 0, attributesMs: 0, totalMs: 0, fileCount: 1, bytes: 0, cacheEntries: 1 };
    await abandoned;
    expect(first.terminate).toHaveBeenCalledOnce();
    receive?.(new MessageEvent<LineParserWorkerResponse>('message', { data: {
      type: 'result', requestId: requestA.requestId, session: requestA.session,
      graph: emptyGraph, attributes: { famPayloads: [], devPayloads: [], unmatchedRefs: [] }, timings,
    }}));
    fail?.(new ErrorEvent('error', { message: 'late worker failure' }));
    expect(second.terminate).not.toHaveBeenCalled();
    second.emit({
      type: 'result', requestId: requestB.requestId, session: requestB.session,
      graph: emptyGraph, attributes: { famPayloads: [], devPayloads: [], unmatchedRefs: [] }, timings,
    });
    await expect(promiseB).resolves.toMatchObject({ timings: { worker: true } });
    state.invalidatePendingLoads();
    expect(second.terminate).toHaveBeenCalledOnce();
  });
});
