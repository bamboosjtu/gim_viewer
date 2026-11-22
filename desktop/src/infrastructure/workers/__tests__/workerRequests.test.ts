import { expect, it, vi } from 'vitest';
import { WorkerRequests } from '../workerRequests.js';

it('settles timeouts, send failures and late replies exactly once', async () => {
  vi.useFakeTimers();
  try {
    const stop = vi.fn();
    const requests = new WorkerRequests<number>(100, stop);
    const timeout = expect(requests.request(1, () => {})).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(100);
    await timeout;
    expect(stop).toHaveBeenCalledOnce();
    requests.settle(1, 42);
    await expect(requests.request(2, () => { throw Error('send'); })).rejects.toThrow('send');
    expect(requests.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
