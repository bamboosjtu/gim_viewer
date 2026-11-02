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
