import { DESKTOP_COMMANDS, GimError, nativeError, hasErrorCode } from '@desktop/contracts.js';
import type { GeometryCacheManifest, GeometryCacheManifestEntry } from '@desktop/contracts.js';
import { invokeTimed, requireNativeOwner, type NativeOwner } from './invokeTimed.js';
import {
  packBinaryCacheWrite,
  parseBatchCachePayload,
  parseLineSemanticPackFullPayload,
  toUint8Array,
  type LineSemanticPackFullResult,
} from './projectFileEnvelope.js';
import { perfCurrentSession, perfRecordBatchRead } from '../../utils/perfTimings.js';
import { releaseOwnedBytes } from '../../shared/ownedBytes.js';
import { StaleSessionError } from '../../shared/sessionScope.js';

const utf8Encoder = new TextEncoder();

async function writeBinary(
  command:
    typeof DESKTOP_COMMANDS.write_cache_file_binary | typeof DESKTOP_COMMANDS.write_glb_file_binary,
  projectId: number,
  entryPath: string,
  bytes: Uint8Array,
  sourceGimSha256?: string | null,
  isCurrent?: NativeOwner,
): Promise<string> {
  requireNativeOwner(isCurrent);
  const packet = packBinaryCacheWrite(projectId, entryPath, bytes, sourceGimSha256 ?? undefined);
  try {
    return await invokeTimed<string>(command, packet, { isCurrent });
  } finally {
    releaseOwnedBytes(packet);
  }
}

/**
 * 在 Tauri 环境下写入缓存文件到 app_data_dir/extracted/{projectId}/{entryPath}。
 * 返回本地缓存路径 local_cache_path。
 */
export function writeCacheFile(
  projectId: number,
  entryPath: string,
  bytes: Uint8Array,
  sourceGimSha256?: string | null,
  isCurrent?: NativeOwner,
): Promise<string> {
  return writeBinary(
    DESKTOP_COMMANDS.write_cache_file_binary,
    projectId,
    entryPath,
    bytes,
    sourceGimSha256,
    isCurrent,
  );
}

/**
 * 在 Tauri 环境下从缓存读取 IFC 文件（路径由 projectId + entryPath 计算，不接受任意路径）。
 */
export async function readCachedIfc(
  projectId: number,
  entryPath: string,
  isCurrent?: NativeOwner,
): Promise<Uint8Array> {
  const bytes = await invokeTimed<ArrayBuffer>(
    DESKTOP_COMMANDS.read_cached_ifc,
    {
      projectId,
      entryPath,
    },
    { isCurrent },
  );
  return toUint8Array(bytes);
}

/**
 * 按 GIM entry_path 从 extracted/{projectId} 读取任意缓存条目。
 * 路径由 Rust 侧重新计算并校验，前端不传绝对路径。
 */
export async function readCachedEntry(
  projectId: number,
  entryPath: string,
  isCurrent?: NativeOwner,
): Promise<Uint8Array> {
  const bytes = await invokeTimed<ArrayBuffer>(
    DESKTOP_COMMANDS.read_cached_entry,
    {
      projectId,
      entryPath,
    },
    { isCurrent },
  );
  return toUint8Array(bytes);
}

/**
 * 批量读取缓存文件（一次 IPC 替代 N 次 read_cached_ifc）。
 * 用于缓存命中时批量加载 DEV/PHM/MOD/STL，避免数千次 IPC。
 */
export async function batchReadCachedFiles(
  projectId: number,
  entryPaths: string[],
  isCurrent?: NativeOwner,
): Promise<Map<string, Uint8Array | null>> {
  requireNativeOwner(isCurrent);
  const perfSession = perfCurrentSession();
  // The request is a small JSON object, but serializing it a second time only
  // to measure IPC would distort the very batch-read timing we are collecting.
  // Account for the known UTF-8 path bytes plus a conservative fixed envelope
  // estimate instead. The response is an ArrayBuffer and is measured exactly
  // by invokeTimed.
  const pathBytes = entryPaths.reduce((sum, path) => sum + utf8Encoder.encode(path).byteLength, 0);
  const requestBytes = pathBytes + entryPaths.length * 6 + String(projectId).length + 32;
  const payload = await invokeTimed<ArrayBuffer>(
    DESKTOP_COMMANDS.batch_read_cached_files,
    {
      projectId,
      entryPaths,
    },
    { requestBytes, isCurrent },
  );
  const parsed = parseBatchCachePayload(payload);
  if (parsed.profile) perfRecordBatchRead(parsed.profile, perfSession.id);
  const map = new Map<string, Uint8Array | null>();
  for (const item of parsed.items) {
    map.set(item.entry_path, item.bytes);
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
  isCurrent?: NativeOwner,
): Promise<Map<string, Uint8Array | null>> {
  requireNativeOwner(isCurrent);
  const perfSession = perfCurrentSession();
  const pathBytes = entryPaths.reduce((sum, path) => sum + utf8Encoder.encode(path).byteLength, 0);
  const requestBytes = pathBytes + entryPaths.length * 6 + String(projectId).length + 32;
  let payload: ArrayBuffer;
  try {
    payload = await invokeTimed<ArrayBuffer>(
      DESKTOP_COMMANDS.read_line_semantic_pack,
      {
        projectId,
        entryPaths,
      },
      { requestBytes, isCurrent },
    );
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
function normalizeLineSemanticPackError(error: unknown): GimError | StaleSessionError {
  if (error instanceof StaleSessionError) return error;
  const failure = nativeError(error);
  if (
    hasErrorCode(
      failure,
      'PACK_INVALID',
      'INDEX_INVALID',
      'PACK_TRUNCATED',
      'SOURCE_CHANGED',
      'SESSION_SUPERSEDED',
      'CANCELLED',
      'RESOURCE_LIMIT',
      'UNAUTHORIZED',
      'INVALID_PATH',
    )
  )
    return failure;
  return new GimError('PACK_INVALID', failure.message, failure.context);
}

/**
 * 读取完整线路 semantic pack。Rust 侧依据 index 返回所有语义字节及
 * metadata-only 条目，WebView 不再把 2 万条路径作为 invoke 参数传回。
 */
export async function readLineSemanticPackAll(
  projectId: number,
  isCurrent?: NativeOwner,
): Promise<LineSemanticPackFullResult> {
  let payload: ArrayBuffer;
  try {
    payload = await invokeTimed<ArrayBuffer>(
      DESKTOP_COMMANDS.read_line_semantic_pack_all,
      {
        projectId,
      },
      { isCurrent },
    );
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

export function writeGlbFile(
  projectId: number,
  entryPath: string,
  bytes: Uint8Array,
  sourceGimSha256?: string | null,
  isCurrent?: NativeOwner,
): Promise<string> {
  return writeBinary(
    DESKTOP_COMMANDS.write_glb_file_binary,
    projectId,
    entryPath,
    bytes,
    sourceGimSha256,
    isCurrent,
  );
}

/**
 * 在 Tauri 环境下读取 GLB 缓存文件。
 *
 * Rust 侧返回 `tauri::ipc::Response`（原始二进制），JS 侧 `invoke` 返回 `ArrayBuffer`，
 * 避免 `Vec<u8>` 经 JSON 序列化为数字数组带来的 3x 体积膨胀和解析开销。
 */
export async function readGlbFile(
  projectId: number,
  entryPath: string,
  isCurrent?: NativeOwner,
): Promise<Uint8Array> {
  const buffer = await invokeTimed<ArrayBuffer>(
    DESKTOP_COMMANDS.read_glb_file,
    {
      projectId,
      entryPath,
    },
    { isCurrent },
  );
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
  const payload = await invokeTimed<ArrayBuffer>(
    DESKTOP_COMMANDS.batch_read_glb_files,
    {
      projectId,
      entryPaths,
    },
    { requestBytes },
  );
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
  return invokeTimed<GeometryCacheManifest>(DESKTOP_COMMANDS.read_geometry_cache_manifest, {
    projectId,
  });
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

/** 授权打开 DB 中已有的最近工程，路径不接受页面输入。 */
export function authorizeCachedGimProject(
  projectId: number,
  isCurrent?: NativeOwner,
): Promise<string> {
  return invokeTimed<string>(
    DESKTOP_COMMANDS.authorize_cached_gim_project,
    { projectId },
    { isCurrent },
  );
}
