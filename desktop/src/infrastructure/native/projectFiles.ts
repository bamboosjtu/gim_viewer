import { DESKTOP_COMMANDS, GimError, nativeError, hasErrorCode } from '@desktop/contracts.js';
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

/**
 * 在 Tauri 环境下写入缓存文件到 app_data_dir/extracted/{projectId}/{entryPath}。
 * 返回本地缓存路径 local_cache_path。
 */
export async function writeCacheFile(
  projectId: number,
  entryPath: string,
  bytes: Uint8Array,
  sourceGimSha256?: string | null,
  isCurrent?: NativeOwner,
): Promise<string> {
  requireNativeOwner(isCurrent);
  const packet = packBinaryCacheWrite(projectId, entryPath, bytes, sourceGimSha256 ?? undefined);
  try {
    return await invokeTimed<string>(DESKTOP_COMMANDS.write_cache_file_binary, packet, {
      isCurrent,
    });
  } finally {
    releaseOwnedBytes(packet);
  }
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
  options?: { borrowPayload: boolean },
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
  // Borrow only when the consumer immediately builds an independent File or
  // decodes the bytes. A retained view would pin the whole response buffer.
  const parsed = parseBatchCachePayload(payload, { copyBytes: !options?.borrowPayload });
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
