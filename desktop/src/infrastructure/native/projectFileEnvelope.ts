import { GimError } from '@desktop/contracts.js';

/**
 * 将缓存写入请求封装为 Tauri Raw IPC envelope。
 * 头部：`GIMB` + version(u8) + metadata 长度(u32 LE) + JSON metadata + bytes。
 * 这样大型 IFC/MOD/Fragments 不再经过 JSON 数字数组序列化。
 */
export function packBinaryCacheWrite(
  projectId: number,
  entryPath: string,
  bytes: Uint8Array,
  sourceGimSha256?: string,
): Uint8Array {
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      project_id: projectId,
      entry_path: entryPath,
      ...(sourceGimSha256 ? { source_gim_sha256: sourceGimSha256 } : {}),
    }),
  );
  if (metadata.byteLength > 16 * 1024) throw new Error('缓存写入 metadata 过大');
  const output = new Uint8Array(9 + metadata.byteLength + bytes.byteLength);
  output.set([0x47, 0x49, 0x4d, 0x42, 1], 0); // GIMB + version
  new DataView(output.buffer).setUint32(5, metadata.byteLength, true);
  output.set(metadata, 9);
  output.set(bytes, 9 + metadata.byteLength);
  return output;
}

/** Assemble a raw cache request from separate payload slices in one copy. */
export function packBinaryCacheWriteParts(
  projectId: number,
  entryPath: string,
  parts: readonly Uint8Array[],
  sourceGimSha256?: string,
): Uint8Array {
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      project_id: projectId,
      entry_path: entryPath,
      ...(sourceGimSha256 ? { source_gim_sha256: sourceGimSha256 } : {}),
    }),
  );
  if (metadata.byteLength > 16 * 1024) throw new Error('缓存写入 metadata 过大');
  const payloadBytes = parts.reduce((total, part) => total + part.byteLength, 0);
  if (!Number.isSafeInteger(payloadBytes)) throw new Error('缓存写入长度无效');
  const output = new Uint8Array(9 + metadata.byteLength + payloadBytes);
  output.set([0x47, 0x49, 0x4d, 0x42, 1], 0);
  new DataView(output.buffer).setUint32(5, metadata.byteLength, true);
  output.set(metadata, 9);
  let offset = 9 + metadata.byteLength;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** 批量读取缓存文件的结果项 */
export interface BatchCacheFileItem {
  entry_path: string;
  bytes: Uint8Array | null;
}

/** Rust GIMR v1 envelope 的内部阶段计时。 */
export interface BatchReadRustProfile {
  readMs: number;
  resolveMs: number;
  encodeMs: number;
  totalMs: number;
  bytes: number;
  entryCount: number;
  hitCount: number;
}

export interface LineSemanticPackFullItem {
  entry_path: string;
  /** packed=true 为 semantic 文本；false 仅含独立缓存文件元数据。 */
  packed: boolean;
  size: number;
  bytes: Uint8Array | null;
}

export interface LineSemanticPackFullProfile {
  indexMs: number;
  resolveMs: number;
  readMs: number;
  encodeMs: number;
  totalMs: number;
  bytes: number;
  entryCount: number;
  packedCount: number;
}

export interface LineSemanticPackFullResult {
  items: LineSemanticPackFullItem[];
  profile: LineSemanticPackFullProfile;
}

const LINE_PACK_HEADER_BYTES = 61;

function readLinePackProfile(bytes: Uint8Array, view: DataView): LineSemanticPackFullProfile {
  const header = LINE_PACK_HEADER_BYTES;
  if (
    bytes.byteLength < header ||
    new TextDecoder().decode(bytes.slice(0, 4)) !== 'GIMF' ||
    bytes[4] !== 1
  ) {
    throw new GimError('PACK_INVALID', '线路语义 pack full envelope 无效');
  }
  const count = view.getUint32(5, true);
  if (count > 200_000) throw new GimError('INDEX_INVALID', '线路语义 pack 条目数超限');
  // A valid line source always contains at least one packed CBM entry.  Treat
  // an empty full response as an invalid index instead of committing an empty
  // graph from a truncated header-only response.
  if (count === 0) throw new GimError('INDEX_INVALID', '线路语义 pack 条目为空');
  const indexMs = view.getFloat64(9, true);
  const resolveMs = view.getFloat64(17, true);
  const readMs = view.getFloat64(25, true);
  const encodeMs = view.getFloat64(33, true);
  const totalMs = view.getFloat64(41, true);
  const packedBytes = view.getBigUint64(49, true);
  if (packedBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new GimError('PACK_INVALID', '线路语义 pack 字节数过大');
  }
  const packedCount = view.getUint32(57, true);
  if (packedCount > count) throw new GimError('INDEX_INVALID', '线路语义 pack packed 条目数无效');
  return {
    indexMs: Number.isFinite(indexMs) && indexMs >= 0 ? indexMs : 0,
    resolveMs: Number.isFinite(resolveMs) && resolveMs >= 0 ? resolveMs : 0,
    readMs: Number.isFinite(readMs) && readMs >= 0 ? readMs : 0,
    encodeMs: Number.isFinite(encodeMs) && encodeMs >= 0 ? encodeMs : 0,
    totalMs: Number.isFinite(totalMs) && totalMs >= 0 ? totalMs : 0,
    bytes: Number(packedBytes),
    entryCount: count,
    packedCount,
  };
}

/** 解析 Rust GIMF v1 full semantic-pack envelope（纯函数，供回归测试）。 */
export function parseLineSemanticPackFullPayload(
  value: ArrayBuffer | Uint8Array,
): LineSemanticPackFullResult {
  const bytes = toUint8Array(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const profile = readLinePackProfile(bytes, view);
  const { entryCount: count, packedCount, bytes: packedBytes } = profile;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = LINE_PACK_HEADER_BYTES;
  let countedPacked = 0;
  let countedBytes = 0;
  let hasPackedCbm = false;
  const seenPaths = new Set<string>();
  const items: LineSemanticPackFullItem[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 4 > bytes.byteLength)
      throw new GimError('PACK_TRUNCATED', '线路语义 pack full 路径长度越界');
    const pathLen = view.getUint32(offset, true);
    offset += 4;
    if (pathLen === 0 || pathLen > 4096 || offset + pathLen + 1 + 8 + 8 > bytes.byteLength) {
      throw new GimError('INDEX_INVALID', '线路语义 pack full 路径或长度无效');
    }
    let entryPath: string;
    try {
      entryPath = decoder.decode(bytes.slice(offset, offset + pathLen));
    } catch {
      throw new GimError('INDEX_INVALID', '线路语义 pack full 路径不是 UTF-8');
    }
    offset += pathLen;
    const normalizedPath = entryPath.replace(/\\/g, '/').toLowerCase();
    const pathParts = normalizedPath.split('/');
    const duplicatePath = seenPaths.has(normalizedPath);
    if (
      !entryPath ||
      entryPath.startsWith('/') ||
      /^[a-z]:\//i.test(normalizedPath) ||
      pathParts.some((part) => !part || part === '.' || part === '..') ||
      duplicatePath
    ) {
      throw new GimError('INDEX_INVALID', `线路语义 pack full 路径无效或重复: ${entryPath}`);
    }
    seenPaths.add(normalizedPath);
    const flags = bytes[offset++];
    if (flags & ~1) throw new GimError('INDEX_INVALID', '线路语义 pack full flags 无效');
    const packed = (flags & 1) !== 0;
    const sizeBig = view.getBigUint64(offset, true);
    offset += 8;
    const dataLenBig = view.getBigUint64(offset, true);
    offset += 8;
    if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER) || dataLenBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GimError('PACK_INVALID', '线路语义 pack full 条目大小过大');
    }
    const size = Number(sizeBig);
    const dataLen = Number(dataLenBig);
    if ((packed && dataLen !== size) || (!packed && dataLen !== 0)) {
      throw new GimError('PACK_INVALID', `线路语义 pack full 条目长度不一致: ${entryPath}`);
    }
    if (offset + dataLen > bytes.byteLength)
      throw new GimError('PACK_TRUNCATED', `线路语义 pack full 数据越界: ${entryPath}`);
    const data = packed ? bytes.slice(offset, offset + dataLen) : null;
    offset += dataLen;
    if (packed) {
      countedPacked += 1;
      countedBytes += dataLen;
      if (dataLen > 0 && normalizedPath.endsWith('.cbm')) hasPackedCbm = true;
    }
    items.push({ entry_path: entryPath, packed, size, bytes: data });
  }
  if (offset !== bytes.byteLength)
    throw new GimError('PACK_INVALID', '线路语义 pack full envelope 存在尾随数据');
  if (countedPacked !== packedCount || countedBytes !== packedBytes) {
    throw new GimError('PACK_INVALID', '线路语义 pack full profile 与条目不一致');
  }
  if (!hasPackedCbm) {
    throw new GimError('INDEX_INVALID', '线路语义 pack 不包含有效 packed CBM 入口');
  }
  return {
    items,
    profile,
  };
}

/** Parse GIMR v1 with the Rust timing header. By default each entry owns its bytes. Synchronous decoders
 * may borrow views only while consuming this payload, then retain independent
 * output; transferring a borrowed entry would detach the entire batch. */
export function parseBatchCachePayload(
  value: ArrayBuffer | Uint8Array,
  options: { copyBytes?: boolean } = {},
): {
  items: BatchCacheFileItem[];
  profile?: BatchReadRustProfile;
} {
  const bytes = toUint8Array(value);
  const decoder = new TextDecoder();
  if (bytes.byteLength < 9 || decoder.decode(bytes.subarray(0, 4)) !== 'GIMR' || bytes[4] !== 1) {
    throw new Error('批量缓存读取响应 envelope 无效');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(5, true);
  if (count > 200_000) throw new Error('批量缓存读取条目数超限');
  const results: BatchCacheFileItem[] = [];
  let offset = 9;
  // readMs/resolveMs/encodeMs/totalMs (4 f64) + bytes (u64) +
  // hitCount/missCount (2 u32) = 48 bytes。
  if (bytes.byteLength < offset + 48) throw new Error('批量缓存读取 profile 越界');
  const readMs = view.getFloat64(offset, true);
  offset += 8;
  const resolveMs = view.getFloat64(offset, true);
  offset += 8;
  const encodeMs = view.getFloat64(offset, true);
  offset += 8;
  const totalMs = view.getFloat64(offset, true);
  offset += 8;
  const totalBytes = view.getBigUint64(offset, true);
  offset += 8;
  if (totalBytes > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('批量缓存读取 profile 字节数过大');
  const hitCount = view.getUint32(offset, true);
  offset += 4;
  // missCount 保留在 envelope 中用于未来完整性检查；业务 Map 不需要读取。
  offset += 4;
  const profile: BatchReadRustProfile = {
    readMs,
    resolveMs,
    encodeMs,
    totalMs,
    bytes: Number(totalBytes),
    entryCount: count,
    hitCount,
  };
  for (let i = 0; i < count; i++) {
    if (offset + 4 > bytes.byteLength) throw new Error('批量缓存读取路径长度越界');
    const pathLen = view.getUint32(offset, true);
    offset += 4;
    if (pathLen > 4096 || offset + pathLen + 1 + 8 > bytes.byteLength)
      throw new Error('批量缓存读取路径或长度无效');
    const entryPath = decoder.decode(bytes.subarray(offset, offset + pathLen));
    offset += pathLen;
    const present = bytes[offset++] === 1;
    const sizeBig = view.getBigUint64(offset, true);
    offset += 8;
    if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('批量缓存读取文件过大');
    const size = Number(sizeBig);
    if (offset + size > bytes.byteLength) throw new Error('批量缓存读取数据越界');
    const data = present
      ? options.copyBytes === false
        ? bytes.subarray(offset, offset + size)
        : bytes.slice(offset, offset + size)
      : null;
    offset += size;
    results.push({ entry_path: entryPath, bytes: data });
  }
  if (offset !== bytes.byteLength) throw new Error('批量缓存读取响应存在尾随数据');
  return { items: results, profile };
}
