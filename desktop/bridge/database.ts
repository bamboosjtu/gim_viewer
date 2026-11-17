import {DESKTOP_COMMANDS} from './contracts.js';
import type {GimProjectRecord, GimIndexPayload, ProcessMemorySnapshot, GeometryCacheManifestEntry, GeometryCacheManifest, GeometryRefsPayload, GimIndexResult, GimCacheValidation, ProjectCacheDiagnostic, LineGraphPayload, LineGraphResult, LineAttributeResult, CachedProjectSummary} from './contracts.js';
export type {GimProjectRecord, GimEntryPayload, CbmNodePayload, IfcModelPayload, FileDevEntryPayload, GimIndexPayload, IfcModelRecord, CbmNodeRecord, ProcessMemorySnapshot, GeometryCacheManifestStatus, GeometryCacheManifestEntry, GeometryCacheManifest, DevSolidModelPayload, DevSubDevicePayload, PhmSolidModelPayload, GeometryRefsPayload, GimEntryRecord, FileDevEntryRecord, GimIndexResult, GimCacheValidation, IfcCacheFileDiagnostic, ProjectCacheDiagnostic, LineCbmNodePayload, LineCbmChildPayload, LineCbmRefPayload, LineFileStatPayload, LineGraphPayload, LineCbmNodeRecord, LineCbmChildRecord, LineCbmRefRecord, LineFileStatRecord, LineGraphResult, LineAttributeResult, CachedProjectSummary} from './contracts.js';
import {GimError, nativeError, hasErrorCode} from './contracts.js';
import type {LineFamPropertyPayload, LineDevPropertyPayload} from './contracts.js';
export type {FamPropertyPayload, DevPropertyPayload, FamPropertyRecord, DevPropertyRecord, LineFamPropertyPayload, LineDevPropertyPayload, LineFamPropertyRecord, LineDevPropertyRecord} from './contracts.js';
import type { FileInfo } from './fileReader.js';
import { invokeTimed } from './invokeTimed.js';
import { perfCurrentSession, perfRecordBatchRead } from '../src/utils/perfTimings.js';

const utf8Encoder = new TextEncoder();

/** 数据库中的 GIM 项目完整记录 */


/**
 * 在 Tauri 环境下 upsert GIM 项目记录到本地 SQLite。
 * 仅在 Tauri 环境可用，浏览器环境不应调用此函数。
 */
export async function upsertGimProject(info: FileInfo): Promise<GimProjectRecord> {
  return invokeTimed<GimProjectRecord>(DESKTOP_COMMANDS.upsert_gim_project, { info });
}

// ===== GIM 索引入库 =====













/**
 * 在 Tauri 环境下保存 GIM 索引（事务：先删后插）。
 */
export async function saveGimIndex(payload: GimIndexPayload): Promise<void> {
  await invokeTimed<void>(DESKTOP_COMMANDS.save_gim_index, { payload });
}

/**
 * 两阶段发布第二阶段：几何引用 + FAM/DEV 属性。
 * 单事务替换并重算 receipt，成功后置 `substation_properties_complete=1`。
 */
export async function saveSubstationSemanticRest(payload: import("./contracts.js").SubstationSemanticRestPayload): Promise<void> {
  await invokeTimed<void>(DESKTOP_COMMANDS.save_substation_semantic_rest, { payload });
}

// ===== GIM 索引读取 =====





// ===== 缓存文件落盘 =====

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
  const metadata = new TextEncoder().encode(JSON.stringify({
    project_id: projectId,
    entry_path: entryPath,
    ...(sourceGimSha256 ? { source_gim_sha256: sourceGimSha256 } : {}),
  }));
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
  const metadata = new TextEncoder().encode(JSON.stringify({
    project_id: projectId,
    entry_path: entryPath,
    ...(sourceGimSha256 ? { source_gim_sha256: sourceGimSha256 } : {}),
  }));
  if (metadata.byteLength > 16 * 1024) throw new Error('缓存写入 metadata 过大');
  const payloadBytes = parts.reduce((total, part) => total + part.byteLength, 0);
  if (!Number.isSafeInteger(payloadBytes)) throw new Error('缓存写入长度无效');
  const output = new Uint8Array(9 + metadata.byteLength + payloadBytes);
  output.set([0x47, 0x49, 0x4d, 0x42, 1], 0);
  new DataView(output.buffer).setUint32(5, metadata.byteLength, true);
  output.set(metadata, 9);
  let offset = 9 + metadata.byteLength;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array
    ? value
    : new Uint8Array(value);
}

/**
 * 在 Tauri 环境下写入缓存文件到 app_data_dir/extracted/{projectId}/{entryPath}。
 * 返回本地缓存路径 local_cache_path。
 */
export async function writeCacheFile(
  projectId: number,
  entryPath: string,
  bytes: Uint8Array,
  sourceGimSha256?: string | null,
): Promise<string> {
  return invokeTimed<string>(
    DESKTOP_COMMANDS.write_cache_file_binary,
    packBinaryCacheWrite(projectId, entryPath, bytes, sourceGimSha256 ?? undefined),
  );
}

/**
 * 在 Tauri 环境下从缓存读取 IFC 文件（路径由 projectId + entryPath 计算，不接受任意路径）。
 */
export async function readCachedIfc(projectId: number, entryPath: string): Promise<Uint8Array> {
  const bytes = await invokeTimed<ArrayBuffer>(DESKTOP_COMMANDS.read_cached_ifc, { projectId, entryPath });
  return toUint8Array(bytes);
}

/**
 * 按 GIM entry_path 从 extracted/{projectId} 读取任意缓存条目。
 * 路径由 Rust 侧重新计算并校验，前端不传绝对路径。
 */
export async function readCachedEntry(projectId: number, entryPath: string): Promise<Uint8Array> {
  const bytes = await invokeTimed<ArrayBuffer>(DESKTOP_COMMANDS.read_cached_entry, { projectId, entryPath });
  return toUint8Array(bytes);
}

/**
 * 获取 Tauri 后端进程及可测 WebView2 descendant process-tree RSS。
 * processTreeRssBytes 为 null 时必须结合 processTreeAvailable/reason 解读，
 * 不能把后端 rssBytes 当作完整桌面进程树内存。
 */


export async function getProcessMemory(): Promise<ProcessMemorySnapshot> {
  return invokeTimed<ProcessMemorySnapshot>(DESKTOP_COMMANDS.get_process_memory);
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

/**
 * 批量读取缓存文件（一次 IPC 替代 N 次 read_cached_ifc）。
 * 用于缓存命中时批量加载 DEV/PHM/MOD/STL，避免数千次 IPC。
 */
export async function batchReadCachedFiles(
  projectId: number,
  entryPaths: string[],
): Promise<Map<string, Uint8Array | null>> {
  const perfSession = perfCurrentSession();
  // The request is a small JSON object, but serializing it a second time only
  // to measure IPC would distort the very batch-read timing we are collecting.
  // Account for the known UTF-8 path bytes plus a conservative fixed envelope
  // estimate instead. The response is an ArrayBuffer and is measured exactly
  // by invokeTimed.
  const pathBytes = entryPaths.reduce((sum, path) => sum + utf8Encoder.encode(path).byteLength, 0);
  const requestBytes = pathBytes + entryPaths.length * 6 + String(projectId).length + 32;
  const payload = await invokeTimed<ArrayBuffer>(DESKTOP_COMMANDS.batch_read_cached_files, {
    projectId,
    entryPaths,
  }, { requestBytes });
  const parsed = parseBatchCachePayload(payload);
  if (parsed.profile) perfRecordBatchRead(parsed.profile, perfSession.id);
  const map = new Map<string, Uint8Array | null>();
  for (const item of parsed.items) {
    map.set(
      item.entry_path,
      item.bytes,
    );
  }
  return map;
}

/**
 * 一次读取 native 线路 semantic pack。响应仍使用 GIMR v1 envelope，
 * 因而 Rust 内部 read/resolve/encode 计时会和普通 batch 统一进入诊断。
 */
export async function readLineSemanticPack(
  projectId: number,
  entryPaths: string[],
): Promise<Map<string, Uint8Array | null>> {
  const perfSession = perfCurrentSession();
  const pathBytes = entryPaths.reduce((sum, path) => sum + utf8Encoder.encode(path).byteLength, 0);
  const requestBytes = pathBytes + entryPaths.length * 6 + String(projectId).length + 32;
  let payload: ArrayBuffer;
  try {
    payload = await invokeTimed<ArrayBuffer>(DESKTOP_COMMANDS.read_line_semantic_pack, {
      projectId,
      entryPaths,
    }, { requestBytes });
  } catch (error) {
    throw normalizeLineSemanticPackError(error);
  }
  let parsed: ReturnType<typeof parseBatchCachePayload>;
  try {
    parsed = parseBatchCachePayload(payload);
  } catch (error) {
    throw new GimError('PACK_INVALID', error instanceof Error ? error.message : String(error));
  }
  if (parsed.profile) perfRecordBatchRead(parsed.profile, perfSession.id);
  const map = new Map<string, Uint8Array | null>();
  for (const item of parsed.items) map.set(item.entry_path, item.bytes);
  return map;
}

/** A native pack failure always carries a code; display text does not choose a recovery path. */
function normalizeLineSemanticPackError(error: unknown): GimError {
  const failure=nativeError(error);
  if(hasErrorCode(failure,'PACK_INVALID','INDEX_INVALID','PACK_TRUNCATED','SOURCE_CHANGED','SESSION_SUPERSEDED','CANCELLED','RESOURCE_LIMIT','UNAUTHORIZED','INVALID_PATH'))return failure;
  return new GimError('PACK_INVALID',failure.message,failure.context);
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

/**
 * 读取完整线路 semantic pack。Rust 侧依据 index 返回所有语义字节及
 * metadata-only 条目，WebView 不再把 2 万条路径作为 invoke 参数传回。
 */
export async function readLineSemanticPackAll(projectId: number): Promise<LineSemanticPackFullResult> {
  let payload: ArrayBuffer;
  try {
    payload = await invokeTimed<ArrayBuffer>(DESKTOP_COMMANDS.read_line_semantic_pack_all, { projectId });
  } catch (error) {
    throw normalizeLineSemanticPackError(error);
  }
  try {
    return parseLineSemanticPackFullPayload(payload);
  } catch (error) {
    // 解析 envelope 失败同样是整体 source cache 损坏；不要降级为逐条读取。
    const normalized = normalizeLineSemanticPackError(error);
    throw normalized;
  }
}

/** 解析 Rust GIMF v1 full semantic-pack envelope（纯函数，供回归测试）。 */
export function parseLineSemanticPackFullPayload(value: ArrayBuffer | Uint8Array): LineSemanticPackFullResult {
  const bytes = toUint8Array(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const header = 61;
  if (bytes.byteLength < header || new TextDecoder().decode(bytes.slice(0, 4)) !== 'GIMF' || bytes[4] !== 1) {
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
  let offset = header;
  let countedPacked = 0;
  let countedBytes = 0;
  let hasPackedCbm = false;
  const seenPaths = new Set<string>();
  const items: LineSemanticPackFullItem[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 4 > bytes.byteLength) throw new GimError('PACK_TRUNCATED', '线路语义 pack full 路径长度越界');
    const pathLen = view.getUint32(offset, true); offset += 4;
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
    if (!entryPath || entryPath.startsWith('/') || /^[a-z]:\//i.test(normalizedPath)
      || pathParts.some((part) => !part || part === '.' || part === '..')
      || duplicatePath) {
      throw new GimError('INDEX_INVALID', `线路语义 pack full 路径无效或重复: ${entryPath}`);
    }
    seenPaths.add(normalizedPath);
    const flags = bytes[offset++];
    if (flags & ~1) throw new GimError('INDEX_INVALID', '线路语义 pack full flags 无效');
    const packed = (flags & 1) !== 0;
    const sizeBig = view.getBigUint64(offset, true); offset += 8;
    const dataLenBig = view.getBigUint64(offset, true); offset += 8;
    if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER) || dataLenBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GimError('PACK_INVALID', '线路语义 pack full 条目大小过大');
    }
    const size = Number(sizeBig);
    const dataLen = Number(dataLenBig);
    if ((packed && dataLen !== size) || (!packed && dataLen !== 0)) {
      throw new GimError('PACK_INVALID', `线路语义 pack full 条目长度不一致: ${entryPath}`);
    }
    if (offset + dataLen > bytes.byteLength) throw new GimError('PACK_TRUNCATED', `线路语义 pack full 数据越界: ${entryPath}`);
    const data = packed ? bytes.slice(offset, offset + dataLen) : null;
    offset += dataLen;
    if (packed) {
      countedPacked += 1;
      countedBytes += dataLen;
      if (dataLen > 0 && normalizedPath.endsWith('.cbm')) hasPackedCbm = true;
    }
    items.push({ entry_path: entryPath, packed, size, bytes: data });
  }
  if (offset !== bytes.byteLength) throw new GimError('PACK_INVALID', '线路语义 pack full envelope 存在尾随数据');
  if (countedPacked !== packedCount || countedBytes !== Number(packedBytes)) {
    throw new GimError('PACK_INVALID', '线路语义 pack full profile 与条目不一致');
  }
  if (!hasPackedCbm) {
    throw new GimError('INDEX_INVALID', '线路语义 pack 不包含有效 packed CBM 入口');
  }
  return {
    items,
    profile: {
      indexMs: Number.isFinite(indexMs) && indexMs >= 0 ? indexMs : 0,
      resolveMs: Number.isFinite(resolveMs) && resolveMs >= 0 ? resolveMs : 0,
      readMs: Number.isFinite(readMs) && readMs >= 0 ? readMs : 0,
      encodeMs: Number.isFinite(encodeMs) && encodeMs >= 0 ? encodeMs : 0,
      totalMs: Number.isFinite(totalMs) && totalMs >= 0 ? totalMs : 0,
      bytes: Number(packedBytes),
      entryCount: count,
      packedCount,
    },
  };
}

/** Parse GIMR v1 with the Rust timing header. By default each entry owns its bytes. Synchronous decoders
 * may borrow views only while consuming this payload, then retain independent
 * output; transferring a borrowed entry would detach the entire batch. */
export function parseBatchCachePayload(value: ArrayBuffer | Uint8Array, options: { copyBytes?: boolean } = {}): {
  items: BatchCacheFileItem[];
  profile?: BatchReadRustProfile;
} {
  const bytes = toUint8Array(value);
  if (bytes.byteLength < 9 || new TextDecoder().decode(bytes.slice(0, 4)) !== 'GIMR' || bytes[4] !== 1) {
    throw new Error('批量缓存读取响应 envelope 无效');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(5, true);
  if (count > 200_000) throw new Error('批量缓存读取条目数超限');
  const results: BatchCacheFileItem[] = [];
  let offset = 9;
  let profile: BatchReadRustProfile | undefined;
  // readMs/resolveMs/encodeMs/totalMs (4 f64) + bytes (u64) +
  // hitCount/missCount (2 u32) = 48 bytes。
  if (bytes.byteLength < offset + 48) throw new Error('批量缓存读取 profile 越界');
  const readMs = view.getFloat64(offset, true); offset += 8;
  const resolveMs = view.getFloat64(offset, true); offset += 8;
  const encodeMs = view.getFloat64(offset, true); offset += 8;
  const totalMs = view.getFloat64(offset, true); offset += 8;
  const totalBytes = view.getBigUint64(offset, true); offset += 8;
  if (totalBytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('批量缓存读取 profile 字节数过大');
  const hitCount = view.getUint32(offset, true); offset += 4;
  // missCount 保留在 envelope 中用于未来完整性检查；业务 Map 不需要读取。
  offset += 4;
  profile = {
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
    const pathLen = view.getUint32(offset, true); offset += 4;
    if (pathLen > 4096 || offset + pathLen + 1 + 8 > bytes.byteLength) throw new Error('批量缓存读取路径或长度无效');
    const entryPath = new TextDecoder().decode(bytes.slice(offset, offset + pathLen)); offset += pathLen;
    const present = bytes[offset++] === 1;
    const sizeBig = view.getBigUint64(offset, true); offset += 8;
    if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('批量缓存读取文件过大');
    const size = Number(sizeBig);
    if (offset + size > bytes.byteLength) throw new Error('批量缓存读取数据越界');
    const data = present ? options.copyBytes === false
      ? bytes.subarray(offset, offset + size) : bytes.slice(offset, offset + size) : null;
    offset += size;
    results.push({ entry_path: entryPath, bytes: data });
  }
  if (offset !== bytes.byteLength) throw new Error('批量缓存读取响应存在尾随数据');
  return { items: results, profile };
}

// ===== GLB 几何缓存（方案 C：MOD → glTF 离线预序列化） =====

/**
 * 在 Tauri 环境下写入 GLB 缓存文件（方案 C：序列化后的 glTF 二进制）。
 * 路径由 projectId + entryPath 计算，存储在 app_data_dir/glbcache/{projectId}/ 下。
 */
export async function writeGlbFile(
  projectId: number,
  entryPath: string,
  bytes: Uint8Array,
  sourceGimSha256?: string | null,
): Promise<string> {
  return invokeTimed<string>(
    DESKTOP_COMMANDS.write_glb_file_binary,
    packBinaryCacheWrite(projectId, entryPath, bytes, sourceGimSha256 ?? undefined),
  );
}

/**
 * 在 Tauri 环境下读取 GLB 缓存文件。
 *
 * Rust 侧返回 `tauri::ipc::Response`（原始二进制），JS 侧 `invoke` 返回 `ArrayBuffer`，
 * 避免 `Vec<u8>` 经 JSON 序列化为数字数组带来的 3x 体积膨胀和解析开销。
 */
export async function readGlbFile(projectId: number, entryPath: string): Promise<Uint8Array> {
  const buffer = await invokeTimed<ArrayBuffer>(DESKTOP_COMMANDS.read_glb_file, { projectId, entryPath });
  return new Uint8Array(buffer);
}

/**
 * 批量读取 DEV GLB 缓存。Rust 返回 GIMR v1 二进制 envelope，避免旧的
 * JSON 数字数组响应；调用方负责按文件数/预计字节数切分批次。
 */
export async function batchReadGlbFiles(
  projectId: number,
  entryPaths: string[],
): Promise<Map<string, Uint8Array | null>> {
  const perfSession = perfCurrentSession();
  const pathBytes = entryPaths.reduce((sum, path) => sum + utf8Encoder.encode(path).byteLength, 0);
  const requestBytes = pathBytes + entryPaths.length * 6 + String(projectId).length + 32;
  const payload = await invokeTimed<ArrayBuffer>(DESKTOP_COMMANDS.batch_read_glb_files, {
    projectId,
    entryPaths,
  }, { requestBytes });
  const parsed = parseBatchCachePayload(payload);
  if (parsed.profile) perfRecordBatchRead(parsed.profile, perfSession.id);
  const map = new Map<string, Uint8Array | null>();
  for (const item of parsed.items) map.set(item.entry_path, item.bytes);
  return map;
}

/**
 * 方案 C：写入 GLB 几何缓存版本标记文件。
 *
 * 在 DEV LOD 模板编译完成 MOD/STL → .glb 序列化后调用一次，把当前 GEOMETRY_CACHE_VERSION 写入
 * glbcache/{projectId}/_version.txt。
 * 下次 validateGimCache 时读取此文件并比较；版本不匹配只使 geometry
 * domain 失效，不影响 CBM/IFC 语义缓存。
 */
export async function writeGeometryCacheVersion(
  projectId: number,
  sourceSha256?: string | null,
): Promise<string> {
  return invokeTimed<string>(DESKTOP_COMMANDS.write_geometry_cache_version, {
    projectId,
    sourceSha256: sourceSha256 ?? null,
  });
}







/** 读取 DEV 粒度 GLB manifest（仅读取描述，不传输 GLB 内容）。 */
export async function readGeometryCacheManifest(projectId: number): Promise<GeometryCacheManifest> {
  return invokeTimed<GeometryCacheManifest>(DESKTOP_COMMANDS.read_geometry_cache_manifest, { projectId });
}

export async function writeGeometryCacheManifest(
  projectId: number,
  sourceSha256: string,
  entries: GeometryCacheManifestEntry[],
): Promise<string> {
  return invokeTimed<string>(DESKTOP_COMMANDS.write_geometry_cache_manifest, {
    projectId,
    sourceSha256,
    entries,
  });
}

/**
 * 删除单个 DEV GLB，并从 manifest 移除同一 DEV 条目。
 *
 * 用于 warm fast path parse failure 的定向恢复；不会影响其它 DEV、IFC
 * 或语义索引缓存。Rust 侧会再次校验 project source SHA。
 */
export async function invalidateGlbCacheEntry(
  projectId: number,
  entryPath: string,
  sourceSha256?: string | null,
): Promise<void> {
  return invokeTimed<void>(DESKTOP_COMMANDS.invalidate_glb_cache_entry, {
    projectId,
    entryPath,
    sourceSha256: sourceSha256 ?? null,
  });
}

// ===== 几何引用链（v6） =====









/** 批量写入 DEV/PHM 几何引用链 */
export async function saveGeometryRefs(payload: GeometryRefsPayload): Promise<void> {
  await invokeTimed(DESKTOP_COMMANDS.save_geometry_refs, { payload });
}

// ===== GIM 索引完整读取 + 缓存校验 =====











/**
 * 完整读取 GIM 索引（只读）。
 */
export async function getGimIndex(projectId: number): Promise<GimIndexResult> {
  return invokeTimed<GimIndexResult>(DESKTOP_COMMANDS.get_gim_index, { projectId });
}

/**
 * 校验 GIM 缓存完整性（只读，不修复）。
 */
export async function validateGimCache(
  projectId: number,
  expectedProjectType: 'substation' | 'transmission_line',
): Promise<GimCacheValidation> {
  return invokeTimed<GimCacheValidation>(DESKTOP_COMMANDS.validate_gim_cache, {
    projectId,
    expectedProjectType,
  });
}

// ==================== 诊断 ====================






/** 返回当前 SQLite 文件路径 */
export async function getDbPath(): Promise<string> {
  return invokeTimed<string>(DESKTOP_COMMANDS.get_db_path);
}

/** 获取最近打开项目的缓存诊断 */
export async function getLatestProjectCacheDiagnostic(): Promise<ProjectCacheDiagnostic | null> {
  return invokeTimed<ProjectCacheDiagnostic | null>(DESKTOP_COMMANDS.get_latest_project_cache_diagnostic);
}

// ==================== 线路工程图缓存（v4） ====================

/** line_cbm_node 写入 payload（对应 GimGraphNode） */


/** line_cbm_child 写入 payload（父→子关系） */


/** line_cbm_ref 写入 payload（节点引用清单） */


/** line_file_stat 写入 payload（文件类型统计） */


/** 线路工程图完整写入 payload */


// ===== v5: 线路工程 FAM/DEV 属性缓存 =====

/** line_fam_property 写入 payload
 *  FAM 行格式：`中文展示键=ENGLISH_KEY=值`（值可能含 =，前端已 rejoin）
 */

/** line_dev_property 写入 payload（普通 KEY=VALUE） */

/**
 * v5: 在 Tauri 环境下统一保存线路工程缓存（图 + FAM/DEV 属性，单事务）。
 *
 * 生产线路首次导入路径应调用此命令，不得再单独调用 saveLineGraph。
 * 事务内：删除 6 张表旧数据 → 插入 graph + fam + dev → 更新
 * line_parser_version = LINE_PARSER_VERSION（当前 gim-line-parser-v1），同时保留
 * parser_version 作为当前数据库发布标记，project_type = transmission_line。
 */
/** 属性分块大小：每批 IPC 传输的记录数（acc-plan P1-2） */
const LINE_ATTR_CHUNK_SIZE = 4000;

/**
 * 分块保存线路工程缓存（图 + FAM/DEV 属性）。
 *
 * 三阶段协议（对应 Rust save_line_graph_begin / save_line_attrs_chunk /
 * save_line_project_finish）：
 * 1. begin：清空旧表 + 写入 graph（4 张表）
 * 2. attrs_chunk × N：每批 ATTR_CHUNK_SIZE 条，fam/dev 同批交错传输
 * 3. finish：写入 line_parser_version（提交点），缓存生效
 *
 * 中途失败时版本戳未更新 → 缓存判定无效 → 下次打开完整重建。
 *
 * @param onProgress 可选进度回调 (已写入条数, 总条数)
 */
export async function saveLineProjectCache(
  projectId: number,
  graphPayload: LineGraphPayload,
  famProps: LineFamPropertyPayload[],
  devProps: LineDevPropertyPayload[],
  onProgress?: (done: number, total: number) => void,
  sourceSha256?: string | null,
  /** 已由调用方生成 graphPayload JSON 时复用其 UTF-8 字节数，避免再次序列化。 */
  graphPayloadBytes?: number,
): Promise<void> {
  const sessionId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  await invokeTimed<void>(DESKTOP_COMMANDS.save_line_graph_begin, {
    projectId,
    sessionId,
    graphPayload,
    sourceSha256: sourceSha256 ?? graphPayload.source_sha256 ?? null,
    expectedFamProperties: famProps.length,
    expectedDevProperties: devProps.length,
  }, graphPayloadBytes === undefined ? {} : { requestBytes: graphPayloadBytes });

  const total = famProps.length + devProps.length;
  let done = 0;
  const maxChunks = Math.max(
    Math.ceil(famProps.length / LINE_ATTR_CHUNK_SIZE),
    Math.ceil(devProps.length / LINE_ATTR_CHUNK_SIZE),
    1,
  );
  for (let i = 0; i < maxChunks; i++) {
    const famChunk = famProps.slice(i * LINE_ATTR_CHUNK_SIZE, (i + 1) * LINE_ATTR_CHUNK_SIZE);
    const devChunk = devProps.slice(i * LINE_ATTR_CHUNK_SIZE, (i + 1) * LINE_ATTR_CHUNK_SIZE);
    await invokeTimed<void>(DESKTOP_COMMANDS.save_line_attrs_chunk, {
      projectId,
      sessionId,
      famProps: famChunk,
      devProps: devChunk,
    });
    done += famChunk.length + devChunk.length;
    onProgress?.(done, total);
  }

  await invokeTimed<void>(DESKTOP_COMMANDS.save_line_project_finish, { projectId, sessionId });
}

// ===== 线路工程图读取 =====

/** line_cbm_node 读取记录 */


/** line_cbm_child 读取记录 */


/** line_cbm_ref 读取记录 */


/** line_file_stat 读取记录 */


/** 线路工程图完整读取结果 */


/**
 * 完整读取线路工程图缓存（只读）。
 */
export async function getLineGraph(projectId: number): Promise<LineGraphResult> {
  return invokeTimed<LineGraphResult>(DESKTOP_COMMANDS.get_line_gim_graph, { projectId });
}

// ===== v5: 线路工程 FAM/DEV 属性读取 =====

/** line_fam_property 读取记录 */

/** line_dev_property 读取记录 */

/** 线路工程 FAM/DEV 属性读取结果 */


/**
 * v5: 读取线路工程 FAM/DEV 属性缓存（只读）。
 *
 * 二次打开线路 GIM（缓存命中）时调用，配合 getLineGraph 恢复全部状态。
 */
export async function getLineAttributes(projectId: number): Promise<LineAttributeResult> {
  return invokeTimed<LineAttributeResult>(DESKTOP_COMMANDS.get_line_attributes, { projectId });
}

/**
 * 缓存项目摘要（list_cached_projects 返回）。
 */


/**
 * 列出所有缓存的项目（只读，按最近打开排序）。
 * 供缓存管理 UI 使用。
 */
export async function listCachedProjects(): Promise<CachedProjectSummary[]> {
  return invokeTimed<CachedProjectSummary[]>(DESKTOP_COMMANDS.list_cached_projects);
}

/** 授权打开 DB 中已有的最近工程，路径不接受页面输入。 */
export async function authorizeCachedGimProject(projectId: number): Promise<string> {
  return invokeTimed<string>(DESKTOP_COMMANDS.authorize_cached_gim_project, { projectId });
}

/** 读取应用设置（本地 SQLite app_setting 表）。 */
export async function getAppSettings(): Promise<Record<string, string>> {
  return invokeTimed<Record<string, string>>(DESKTOP_COMMANDS.get_app_settings);
}

/** 写入单个应用设置；value 为空字符串表示清除。 */
export async function setAppSetting(key: string, value: string): Promise<void> {
  await invokeTimed<void>(DESKTOP_COMMANDS.set_app_setting, { key, value });
}

/** 打开成功后异步更新最近打开时间。 */
export async function touchGimProjectOpened(projectId: number): Promise<void> {
  await invokeTimed<void>(DESKTOP_COMMANDS.touch_gim_project_opened, { projectId });
}

/**
 * 删除指定项目的全部缓存（DB 记录 + 磁盘文件）。
 * 返回操作摘要文本。
 */
export async function deleteProjectCache(projectId: number): Promise<string> {
  return invokeTimed<string>(DESKTOP_COMMANDS.delete_project_cache, { projectId });
}

/**
 * 获取指定项目的缓存诊断（供缓存管理 UI 的"复制诊断"按钮使用）。
 * 返回与 getLatestProjectCacheDiagnostic 相同结构的 ProjectCacheDiagnostic。
 */
export async function getProjectDiagnostic(projectId: number): Promise<ProjectCacheDiagnostic> {
  return invokeTimed<ProjectCacheDiagnostic>(DESKTOP_COMMANDS.get_project_diagnostic, { projectId });
}
