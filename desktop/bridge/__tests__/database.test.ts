import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  LineSemanticPackError,
  parseBatchCachePayload,
  parseLineSemanticPackFullPayload,
} from '../database.js';

/** 构造与 Rust read_line_semantic_pack_all 对齐的 GIMF v1 envelope。 */
function fullEnvelope(
  items: Array<{ path: string; packed: boolean; size: number; data?: Uint8Array }>,
  overrides: { count?: number; packedCount?: number; packedBytes?: bigint } = {},
): Uint8Array {
  const packed = items.filter((item) => item.packed);
  const packedBytes = overrides.packedBytes
    ?? BigInt(packed.reduce((sum, item) => sum + (item.data?.byteLength ?? item.size), 0));
  const packedCount = overrides.packedCount ?? packed.length;
  const count = overrides.count ?? items.length;
  const out = new Uint8Array(61);
  out.set(new TextEncoder().encode('GIMF'), 0);
  out[4] = 1;
  const view = new DataView(out.buffer);
  view.setUint32(5, count, true);
  view.setFloat64(9, 1.1, true);
  view.setFloat64(17, 2.2, true);
  view.setFloat64(25, 3.3, true);
  view.setFloat64(33, 4.4, true);
  view.setFloat64(41, 5.5, true);
  view.setBigUint64(49, packedBytes, true);
  view.setUint32(57, packedCount, true);
  const chunks: Uint8Array[] = [out];
  for (const item of items) {
    const path = new TextEncoder().encode(item.path);
    const data = item.packed ? (item.data ?? new Uint8Array(item.size)) : new Uint8Array(0);
    const header = new Uint8Array(4 + path.byteLength + 1 + 8 + 8);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, path.byteLength, true);
    header.set(path, 4);
    header[4 + path.byteLength] = item.packed ? 1 : 0;
    headerView.setBigUint64(4 + path.byteLength + 1, BigInt(item.size), true);
    headerView.setBigUint64(4 + path.byteLength + 1 + 8, BigInt(data.byteLength), true);
    chunks.push(header, data);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

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

describe('read_line_semantic_pack_all GIMF v1 envelope', () => {
  it('解析 packed 与 metadata-only 条目，并保留性能阶段计时', () => {
    const payload = fullEnvelope([
      { path: 'Cbm/project.cbm', packed: true, size: 3, data: new TextEncoder().encode('A=B') },
      { path: 'Mod/tower.STL', packed: false, size: 1234 },
    ]);
    const result = parseLineSemanticPackFullPayload(payload);
    expect(result.items.map((item) => ({
      entry_path: item.entry_path,
      packed: item.packed,
      size: item.size,
      bytes: item.bytes ? Array.from(item.bytes) : null,
    }))).toEqual([
      { entry_path: 'Cbm/project.cbm', packed: true, size: 3, bytes: [65, 61, 66] },
      { entry_path: 'Mod/tower.STL', packed: false, size: 1234, bytes: null },
    ]);
    expect(result.profile).toMatchObject({
      indexMs: 1.1,
      resolveMs: 2.2,
      readMs: 3.3,
      encodeMs: 4.4,
      totalMs: 5.5,
      bytes: 3,
      entryCount: 2,
      packedCount: 1,
    });
  });

  it.each([
    ['empty index', () => fullEnvelope([], { count: 0, packedCount: 0, packedBytes: 0n }), 'INDEX_INVALID'],
    ['empty packed CBM', () => fullEnvelope([{ path: 'CBM/project.cbm', packed: true, size: 0, data: new Uint8Array(0) }]), 'INDEX_INVALID'],
    ['truncated item', () => fullEnvelope([], { count: 1 }), 'PACK_TRUNCATED'],
    ['data truncated', () => fullEnvelope([{ path: 'CBM/a.cbm', packed: true, size: 4, data: new Uint8Array([1, 2]) }], { packedBytes: 2n }), 'PACK_INVALID'],
    ['data length mismatch', () => fullEnvelope([{ path: 'CBM/a.cbm', packed: true, size: 3, data: new Uint8Array([1, 2]) }], { packedBytes: 2n }), 'PACK_INVALID'],
    ['packed count mismatch', () => fullEnvelope([{ path: 'CBM/a.cbm', packed: true, size: 1, data: new Uint8Array([1]) }], { packedCount: 0, packedBytes: 1n }), 'PACK_INVALID'],
  ])('%s 被识别为整体损坏而不是逐条 fallback', (_name, makePayload, kind) => {
    expect(() => parseLineSemanticPackFullPayload(makePayload())).toThrow(LineSemanticPackError);
    try { parseLineSemanticPackFullPayload(makePayload()); } catch (error) {
      expect((error as LineSemanticPackError).kind).toBe(kind);
    }
  });

  it('拒绝非法 flags、重复大小写路径和路径穿越', () => {
    const flagsPayload = fullEnvelope([{ path: 'CBM/a.cbm', packed: true, size: 1, data: new Uint8Array([1]) }]);
    flagsPayload[61 + 4 + 'CBM/a.cbm'.length] = 2;
    expect(() => parseLineSemanticPackFullPayload(flagsPayload)).toThrow(LineSemanticPackError);
    try { parseLineSemanticPackFullPayload(flagsPayload); } catch (error) {
      expect((error as LineSemanticPackError).kind).toBe('INDEX_INVALID');
    }

    const duplicatePayload = fullEnvelope([
      { path: 'CBM/a.cbm', packed: true, size: 1, data: new Uint8Array([1]) },
      { path: String.raw`cbm\A.CBM`, packed: true, size: 1, data: new Uint8Array([2]) },
    ]);
    expect(() => parseLineSemanticPackFullPayload(duplicatePayload)).toThrow(LineSemanticPackError);
    try { parseLineSemanticPackFullPayload(duplicatePayload); } catch (error) {
      expect((error as LineSemanticPackError).kind).toBe('INDEX_INVALID');
    }

    const traversalPayload = fullEnvelope([{ path: 'CBM/../a.cbm', packed: true, size: 1, data: new Uint8Array([1]) }]);
    expect(() => parseLineSemanticPackFullPayload(traversalPayload)).toThrow(LineSemanticPackError);
    try { parseLineSemanticPackFullPayload(traversalPayload); } catch (error) {
      expect((error as LineSemanticPackError).kind).toBe('INDEX_INVALID');
    }
  });
});
