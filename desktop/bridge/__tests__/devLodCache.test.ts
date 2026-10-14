import { expect, it, vi } from 'vitest';
import { packDevArtifact, unpackDevArtifact, readDevArtifact, writeDevArtifact } from '../devLodCache.js';

it('retains binary template bytes and rejects mismatched or truncated cache records', () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const packed = packDevArtifact('key', { sha: 'test', result: { status: 'complete', bytes: source } });
  const restored = unpackDevArtifact<any>('key', packed);
  expect(restored.result.bytes).toEqual(source); restored.result.bytes[0] = 99;
  expect(source[0]).toBe(1);
  expect(() => unpackDevArtifact('other', packed)).toThrow('key mismatch');
  expect(() => unpackDevArtifact('key', packed.subarray(0, 5))).toThrow('metadata invalid');
  expect(unpackDevArtifact('missing', new Uint8Array())).toBeNull();
});

it('does not reopen unavailable IndexedDB for every device read and write', async () => {
  const open = vi.fn(() => {
    const request: any = { error: Error('storage unavailable') };
    queueMicrotask(() => request.onerror()); return request;
  });
  vi.stubGlobal('indexedDB', { open });
  try {
    expect(await readDevArtifact('catalog', 'one')).toBeNull();
    expect(await readDevArtifact('catalog', 'two')).toBeNull();
    expect(await writeDevArtifact('templates', 'three', {})).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
