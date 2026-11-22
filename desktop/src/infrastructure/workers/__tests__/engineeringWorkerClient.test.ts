import { expect, it, vi } from 'vitest';
import { EngineeringWorkerClient, type EngineeringWorkerPort } from '../engineeringWorkerClient.js';
import type {
  EngineeringSourceInput,
  EngineeringWorkerRequest,
  EngineeringWorkerResponse,
} from '../engineeringWorkerProtocol.js';

function port(): EngineeringWorkerPort {
  return { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null };
}

function deliver(worker: EngineeringWorkerPort, data: EngineeringWorkerResponse) {
  worker.onmessage?.({ data } as MessageEvent<EngineeringWorkerResponse>);
}

it('does not construct a Worker for an already-aborted session', () => {
  const construct = vi.fn();
  vi.stubGlobal('Worker', construct);
  try {
    const controller = new AbortController();
    controller.abort();
    expect(() => EngineeringWorkerClient.create(() => true, controller.signal)).toThrow(/cancelled/);
    expect(construct).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('rejects all pending requests and releases the port, abort listener and timers once', async () => {
  vi.useFakeTimers();
  const worker = port(), controller = new AbortController();
  const unlisten = vi.spyOn(controller.signal, 'removeEventListener');
  const client = new EngineeringWorkerClient(worker, () => true, controller.signal);
  try {
    const pending = [
      expect(client.init('scope', [])).rejects.toMatchObject({ name: 'AbortError' }),
      expect(client.extract()).rejects.toMatchObject({ name: 'AbortError' }),
    ];
    expect(vi.getTimerCount()).toBe(2);
    controller.abort();
    await Promise.all(pending);
    client.close();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

it('rejects a reply queued before the project changes when the caller resumes afterward', async () => {
  const worker = port();
  let current = true;
  const client = new EngineeringWorkerClient(worker, () => current);
  try {
    const pending = expect(client.extract()).rejects.toMatchObject({ name: 'AbortError' });
    const [{ requestId }] = vi.mocked(worker.postMessage).mock.calls[0];
    deliver(worker, { type: 'graph', requestId, summary: { ifcPaths: [], sourceRecords: 1 } });
    current = false;
    await pending;
    expect(worker.terminate).toHaveBeenCalledOnce();
  } finally {
    client.close();
  }
});

it.each(['success', 'error'])('rejects a delayed source read (%s) from a stale project', async (outcome) => {
  const worker = port();
  let current = true;
  const client = new EngineeringWorkerClient(worker, () => current);
  let resolveInput!: (input: EngineeringSourceInput) => void;
  let rejectInput!: (error: Error) => void;
  const read = vi.fn(() => new Promise<EngineeringSourceInput>((resolve, reject) => {
    resolveInput = resolve;
    rejectInput = reject;
  }));
  client.setSourceReader(read);
  try {
    const pending = expect(client.extract()).rejects.toMatchObject({ name: 'AbortError' });
    const [{ requestId }] = vi.mocked(worker.postMessage).mock.calls[0];
    deliver(worker, { type: 'read-sources', requestId, readId: 1, paths: ['main.dev'] });
    expect(read).toHaveBeenCalledOnce();
    current = false;
    if (outcome === 'error') rejectInput(new Error('late input failure'));
    else resolveInput({ batches: [], files: [], errors: [] });
    await pending;
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  } finally {
    client.close();
  }
});

it('rejects a stale result when its project has changed', async () => {
  const worker = port(); let current = true;
  const client = new EngineeringWorkerClient(worker, () => current);
  const pending = expect(client.init('scope', [])).rejects.toMatchObject({ name: 'AbortError' });
  current = false;
  const request = vi.mocked(worker.postMessage).mock.calls[0][0];
  worker.onmessage!({ data: { type: 'ready', requestId: request.requestId } } as MessageEvent);
  await pending;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it('transfers a shared native batch buffer only once', async () => {
  const worker = port();
  vi.mocked(worker.postMessage).mockImplementation((request: EngineeringWorkerRequest) => {
    queueMicrotask(() => worker.onmessage!({ data: { type: 'ready', requestId: request.requestId } } as MessageEvent));
  });
  const client = new EngineeringWorkerClient(worker, () => true);
  const buffer = new Uint8Array(10);
  await client.addFiles([{ path: 'a', bytes: buffer.subarray(0, 5) }, { path: 'b', bytes: buffer.subarray(5) }]);
  expect(vi.mocked(worker.postMessage).mock.calls[0][1]).toHaveLength(1);
  client.close();
});

it('keeps a large extraction alive only while its Worker reports progress', async () => {
  vi.useFakeTimers();const worker=port(),progress=vi.fn(),client=new EngineeringWorkerClient(worker,()=>true,undefined,progress);
  try{
    const pending=client.extract();
    const request=vi.mocked(worker.postMessage).mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(50_000);
    worker.onmessage!({data:{type:'progress',stage:'source-traverse',completed:1,requestId:request.requestId}} as MessageEvent);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith('source-traverse',1);
    worker.onmessage!({data:{type:'graph',requestId:request.requestId,
      summary:{ifcPaths:[],sourceRecords:0}}} as MessageEvent);
    await pending;
  }finally{client.close();vi.useRealTimers();}
});
it('ends an extraction that makes no progress for sixty seconds', async () => {
  vi.useFakeTimers();const worker=port(),client=new EngineeringWorkerClient(worker,()=>true);
  try{
    const pending=expect(client.extract()).rejects.toThrow(/60000 ms/);
    await vi.advanceTimersByTimeAsync(60_001);
    await pending;expect(worker.terminate).toHaveBeenCalledOnce();
  }finally{client.close();vi.useRealTimers();}
});
