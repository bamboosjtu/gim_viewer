/**
 * Native manifest-only 解压后的变电小文件物化。
 *
 * Rust 解压会把条目直接落盘，前端的 DiskBackedFile 原本在每次
 * text()/arrayBuffer() 时发起一次 read_cached_entry。变电冷路径会由
 * CBM/FAM/DEV、空间/STD 及几何索引重复访问同一批小文本文件；本模块只
 * 在进入变电流程前用既有 batch_read_cached_files 一次物化有界的小文件，
 * 不读取 IFC，也不引入全局缓存或改变大文件 lazy 语义。
 */

import { batchReadCachedFiles } from '@desktop/database.js';
import { isDiskBackedFile, isSemanticPackBackedFile } from '@desktop/gimExtract.js';

/** 单个条目的上限；substation 的 CBM/DEV/FAM/PHM/小 MOD 均远低于该值。 */
export const NATIVE_SMALL_FILE_MAX_BYTES = 256 * 1024;
/** 单批上限，避免一次响应占用过多 WebView 内存。 */
export const NATIVE_SMALL_FILE_BATCH_MAX_FILES = 512;
export const NATIVE_SMALL_FILE_BATCH_MAX_BYTES = 16 * 1024 * 1024;

export interface NativeSmallFileHydrationOptions {
  maxFiles?: number;
  maxBytes?: number;
  isCurrent?: () => boolean;
}

export interface NativeSmallFileHydrationResult {
  files: Map<string, File>;
  requested: number;
  hydrated: number;
  bytes: number;
  batches: number;
  misses: number;
  cancelled: boolean;
}

interface Candidate {
  path: string;
  file: File;
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index >= 0 ? path.slice(index + 1).toLowerCase() : '';
}

function toFile(bytes: Uint8Array, path: string, original: File): File {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const name = path.split(/[\\/]/).pop() || path;
  return new File([buffer], name, {
    type: original.type || 'application/octet-stream',
    lastModified: original.lastModified || 0,
  });
}

function chunkCandidates(candidates: Candidate[], maxFiles: number, maxBytes: number): Candidate[][] {
  const chunks: Candidate[][] = [];
  let current: Candidate[] = [];
  let currentBytes = 0;
  for (const candidate of candidates) {
    const size = Math.max(0, candidate.file.size || 0);
    if (current.length > 0 && (current.length >= maxFiles || currentBytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(candidate);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function findBytes(
  bytesMap: Map<string, Uint8Array | null>,
  normalized: Map<string, Uint8Array | null>,
  path: string,
): Uint8Array | null | undefined {
  if (bytesMap.has(path)) return bytesMap.get(path);
  return normalized.get(path.replace(/\\/g, '/').toLowerCase());
}

/**
 * 将 native DiskBackedFile 的小型非 IFC 条目按批次物化为普通 File。
 * 任何 batch 失败都保留原始 lazy File，调用方可继续工作；不会把一次
 * 性能优化失败变成工程加载失败。工程已切换时返回 cancelled，调用方
 * 必须丢弃 returned map。
 */
export async function hydrateNativeSmallFiles(
  files: Map<string, File>,
  projectId: number | null | undefined,
  options: NativeSmallFileHydrationOptions = {},
): Promise<NativeSmallFileHydrationResult> {
  const isCurrent = options.isCurrent ?? (() => true);
  const output = new Map(files);
  const requestedCandidates: Candidate[] = [];

  if (projectId == null) {
    return {
      files: output,
      requested: 0,
      hydrated: 0,
      bytes: 0,
      batches: 0,
      misses: 0,
      cancelled: !isCurrent(),
    };
  }

  for (const [path, file] of files) {
    if (!isDiskBackedFile(file) || isSemanticPackBackedFile(file)) continue;
    // IFC 必须保持单独的 lazy read/decode 生命周期；大文件也不应被
    // 物化到全局 Map，避免这条修复重新引入内存峰值。
    if (extensionOf(path) === 'ifc') continue;
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > NATIVE_SMALL_FILE_MAX_BYTES) continue;
    requestedCandidates.push({ path, file });
  }

  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? NATIVE_SMALL_FILE_BATCH_MAX_FILES));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? NATIVE_SMALL_FILE_BATCH_MAX_BYTES));
  let hydrated = 0;
  let bytes = 0;
  let batches = 0;
  let misses = 0;

  for (const chunk of chunkCandidates(requestedCandidates, maxFiles, maxBytes)) {
    if (!isCurrent()) {
      return { files: output, requested: requestedCandidates.length, hydrated, bytes, batches, misses, cancelled: true };
    }
    batches += 1;
    let result: Map<string, Uint8Array | null>;
    try {
      result = await batchReadCachedFiles(projectId, chunk.map((candidate) => candidate.path));
    } catch {
      // 保留 lazy source；后续解析仍可通过 read_cached_entry 正常降级。
      continue;
    }
    if (!isCurrent()) {
      return { files: output, requested: requestedCandidates.length, hydrated, bytes, batches, misses, cancelled: true };
    }
    const normalized = new Map<string, Uint8Array | null>();
    for (const [path, value] of result) {
      const key = path.replace(/\\/g, '/').toLowerCase();
      if (!normalized.has(key)) normalized.set(key, value);
    }
    for (const candidate of chunk) {
      const value = findBytes(result, normalized, candidate.path);
      // null 是明确的 batch miss；保留原始 File，让业务层按需重试或记录
      // 缺失，而不是把 miss 错误地变成空文件。
      if (value == null) {
        misses += 1;
        continue;
      }
      output.set(candidate.path, toFile(value, candidate.path, candidate.file));
      hydrated += 1;
      bytes += value.byteLength;
    }
  }

  return {
    files: output,
    requested: requestedCandidates.length,
    hydrated,
    bytes,
    batches,
    misses,
    cancelled: false,
  };
}

