// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { readCachedEntry, readLineSemanticPackAll, writeCacheFile } from '../projectFiles.js';

const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => mock);

beforeEach(() => mock.invoke.mockReset());

it('rejects a late native read result and keeps subsequent reads on the new project', async () => {
  let deliver!: (bytes: ArrayBuffer) => void;
  mock.invoke.mockReturnValueOnce(new Promise<ArrayBuffer>((resolve) => { deliver = resolve; }));
  let active = true;
  const stale = expect(readCachedEntry(1, 'old.cbm', () => active)).rejects.toMatchObject({
    name: 'StaleSessionError',
  });
  active = false;
  deliver(new Uint8Array([1]).buffer);
  await stale;
  mock.invoke.mockResolvedValueOnce(new Uint8Array([2]).buffer);
  await expect(readCachedEntry(2, 'new.cbm', () => true)).resolves.toEqual(new Uint8Array([2]));
  expect(mock.invoke.mock.calls).toEqual([
    ['read_cached_entry', { projectId: 1, entryPath: 'old.cbm' }],
    ['read_cached_entry', { projectId: 2, entryPath: 'new.cbm' }],
  ]);
  await expect(readCachedEntry(1, 'old.cbm', () => active)).rejects.toMatchObject({ name: 'StaleSessionError' });
  expect(mock.invoke).toHaveBeenCalledTimes(2);
});

it('releases the owned v1 packet on write failure while preserving the caller buffer and native code', async () => {
  const input = new Uint8Array([5, 6, 7]);
  let packet!: Uint8Array;
  mock.invoke.mockImplementationOnce((_command: string, bytes: Uint8Array) => {
    packet = bytes;
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('GIMB');
    expect(bytes[4]).toBe(1);
    const metadataLen = new DataView(bytes.buffer).getUint32(5, true);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + metadataLen)))).toEqual({
      project_id: 7, entry_path: 'model.ifc', source_gim_sha256: 'old',
    });
    expect([...bytes.subarray(9 + metadataLen)]).toEqual([5, 6, 7]);
    return Promise.reject({ code: 'IO', message: 'disk full', context: { project_id: 7 } });
  });
  await expect(writeCacheFile(7, 'model.ifc', input, 'old')).rejects.toMatchObject({
    code: 'IO', message: 'disk full', context: { project_id: 7 },
  });
  if ('transfer' in ArrayBuffer.prototype) expect(packet.byteLength).toBe(0);
  expect([...input]).toEqual([5, 6, 7]);
  mock.invoke.mockResolvedValueOnce('cache/model.ifc');
  await expect(writeCacheFile(7, 'model.ifc', input, 'old')).resolves.toBe('cache/model.ifc');
  expect(mock.invoke.mock.calls.every(([command]) => command === 'write_cache_file_binary')).toBe(true);
});

it('reports a superseded semantic pack read without remapping a late native error to a pack failure', async () => {
  let fail!: (error: unknown) => void;
  mock.invoke.mockReturnValueOnce(new Promise<never>((_, reject) => { fail = reject; }));
  let active = true;
  const stale = expect(readLineSemanticPackAll(1, () => active)).rejects.toMatchObject({
    name: 'StaleSessionError',
  });
  active = false;
  fail({ code: 'IO', message: 'old pack removed' });
  await stale;
});

it('discards an admitted write receipt when its project closes and releases its packet after IPC completes', async () => {
  let finish!: (path: string) => void;
  const result = new Promise<string>((resolve) => { finish = resolve; });
  mock.invoke.mockReturnValueOnce(result);
  let active = true;
  const pending = expect(writeCacheFile(1, 'old.dev', new Uint8Array([1]), 'old', () => active))
    .rejects.toMatchObject({ name: 'StaleSessionError' });
  const packet = mock.invoke.mock.calls[0][1] as Uint8Array;
  active = false;
  expect(packet.byteLength).toBeGreaterThan(1);
  finish('cache/old.dev');
  await pending;
  if ('transfer' in ArrayBuffer.prototype) expect(packet.byteLength).toBe(0);
});
