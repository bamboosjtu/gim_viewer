import { expect, it, vi } from 'vitest';
import { EngineeringWorkerClient, type EngineeringWorkerPort } from '../engineeringWorkerClient.js';
import type { EngineeringWorkerRequest } from '../engineeringWorkerProtocol.js';

function port(): EngineeringWorkerPort {
  return { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null };
}

it('rejects all pending requests and terminates once on abort', async () => {
  const worker = port(), controller = new AbortController();
  const client = new EngineeringWorkerClient(worker, () => true, controller.signal);
  const pending = expect(client.init('scope', [])).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await pending; client.close();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(worker.onmessage).toBeNull();
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
      summary:{ifcPaths:[],sourceRecords:0},geometryOccurrences:null}} as MessageEvent);
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
