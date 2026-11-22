// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { readCachedEntry, writeCacheFile } from '@desktop/database.js';
import type { EngineeringCacheResult } from '../engineeringCacheCodec.js';
import { EngineeringCacheStore } from '../engineeringCacheStore.js';

vi.mock('@desktop/database.js', () => ({ readCachedEntry: vi.fn(), writeCacheFile: vi.fn() }));

const identity = { sourceSha256: 'a'.repeat(64), parserVersion: 'test-v1', entries: ['entry.cbm'] };
const current = () => true;
const metrics = { encodeMs: 1, plainBytes: 2, encodedBytes: 1 };
const artifact = (value = 1): EngineeringCacheResult => ({
  buildId: value,
  domain: 'sources',
  bytes: new Uint8Array([value]),
  metrics,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(writeCacheFile).mockResolvedValue('saved');
});

it('discards an old build reply that arrives after the current build changes', async () => {
  let buildCurrent = true;
  const store = new EngineeringCacheStore(1, identity, current);
  const encoded = deferred<EngineeringCacheResult>();
  const onEncoded = vi.fn();
  const pending = expect(store.saveDomain('sources', () => encoded.promise, () => buildCurrent, onEncoded))
    .rejects.toMatchObject({ name: 'StaleSessionError' });
  const result = artifact();
  buildCurrent = false;
  encoded.resolve(result);
  await pending;
  expect(result.bytes).toBeUndefined();
  expect(onEncoded).not.toHaveBeenCalled();
  expect(writeCacheFile).not.toHaveBeenCalled();
});

it('cancels a physical write waiting for source commit on project switch', async () => {
  const commit = deferred<void>();
  const store = new EngineeringCacheStore(1, identity, current, commit.promise);
  const bytes = new Uint8Array([7]);
  const encoded = vi.fn(async () => bytes);
  const pending = expect(store.saveGeometry(encoded)).rejects.toMatchObject({ name: 'StaleSessionError' });
  await Promise.resolve();
  expect(encoded).toHaveBeenCalledOnce();
  expect(writeCacheFile).not.toHaveBeenCalled();
  store.close();
  await pending;
  commit.resolve(undefined);
  expect(writeCacheFile).not.toHaveBeenCalled();
  if ('transfer' in ArrayBuffer.prototype) expect(bytes.byteLength).toBe(0);
});

it('orders writes for the same artifact and skips a cancelled waiter across sessions', async () => {
  const held = deferred<string>();
  vi.mocked(writeCacheFile).mockReturnValueOnce(held.promise);
  const old = new EngineeringCacheStore(1, identity, current);
  const cancelled = new EngineeringCacheStore(1, identity, current);
  const currentStore = new EngineeringCacheStore(1, identity, current);
  const save = (store: EngineeringCacheStore, data: EngineeringCacheResult) =>
    store.saveDomain('sources', async () => data, current, vi.fn());
  const oldResult = artifact(1), queuedResult = artifact(2), newResult = artifact(3);
  const oldWrite = expect(save(old, oldResult)).rejects.toMatchObject({ name: 'StaleSessionError' });
  await expect.poll(() => vi.mocked(writeCacheFile).mock.calls.length).toBe(1);
  old.close();
  const queued = expect(save(cancelled, queuedResult)).rejects.toMatchObject({ name: 'StaleSessionError' });
  const latest = save(currentStore, newResult);
  await Promise.resolve();
  cancelled.close();
  await queued;
  expect(queuedResult.bytes).toBeUndefined();
  expect(writeCacheFile).toHaveBeenCalledOnce();
  held.resolve('old-completion');
  await oldWrite;
  await expect(latest).resolves.toEqual({ status: 'saved' });
  expect(writeCacheFile).toHaveBeenCalledTimes(2);
  expect(oldResult.bytes).toBeUndefined();
  expect(newResult.bytes).toBeUndefined();
});

it('clears ownership after a failed native write and allows retrying the same v1 entry', async () => {
  vi.mocked(writeCacheFile).mockRejectedValueOnce(new Error('disk-full'));
  const store = new EngineeringCacheStore(4, identity, current);
  const failed = artifact();
  await expect(store.saveDomain('sources', async () => failed, current, vi.fn())).rejects.toThrow('disk-full');
  expect(failed.bytes).toBeUndefined();
  const retry = artifact();
  await expect(store.saveDomain('sources', async () => retry, current, vi.fn())).resolves.toEqual({ status: 'saved' });
  expect(vi.mocked(writeCacheFile).mock.calls.map(([projectId, entry, , sha]) => [projectId, entry, sha])).toEqual(
    Array.from({ length: 2 }, () => [4, `__derived__/engineering-source-v1/${identity.sourceSha256}.bin`, identity.sourceSha256]),
  );
  expect(retry.bytes).toBeUndefined();
});

it('rejects reads that finish after closing the cache owner', async () => {
  const read = deferred<Uint8Array>();
  vi.mocked(readCachedEntry).mockReturnValue(read.promise);
  const store = new EngineeringCacheStore(1, identity, current);
  const pending = expect(store.readDomains()).rejects.toMatchObject({ name: 'StaleSessionError' });
  store.close();
  read.resolve(new Uint8Array([1]));
  await pending;
  expect(readCachedEntry).toHaveBeenCalledTimes(3);
});
