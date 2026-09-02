import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { parseBatchCachePayload } from '../database.js';

describe('batch_read_cached_files envelope', () => {
  it('解析 GIMR v2 Rust 内部计时头', () => {
    const bytes = new Uint8Array(57);
    bytes.set(new TextEncoder().encode('GIMR'), 0);
    bytes[4] = 2;
    const view = new DataView(bytes.buffer);
    view.setUint32(5, 0, true);
    view.setFloat64(9, 1.5, true);
    view.setFloat64(17, 2.5, true);
    view.setFloat64(25, 0.5, true);
    view.setFloat64(33, 4.5, true);
    view.setBigUint64(41, BigInt(2048), true);
    view.setUint32(49, 0, true);
    view.setUint32(53, 0, true);

    const result = parseBatchCachePayload(bytes);
    expect(result.items).toEqual([]);
    expect(result.profile).toEqual({
      readMs: 1.5,
      resolveMs: 2.5,
      encodeMs: 0.5,
      totalMs: 4.5,
      bytes: 2048,
      entryCount: 0,
      hitCount: 0,
    });
  });
});
