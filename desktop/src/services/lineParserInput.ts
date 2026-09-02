/**
 * 线路解析输入读取协调器。
 *
 * 首次 native 解压得到的 semantic-pack-backed 文本先通过一次连续 pack IPC
 * 读取；其余 DiskBackedFile 再按文件数/总字节上限调用 batchReadCachedFiles。
 * WASM/浏览器普通 File 仍走 File.arrayBuffer() 兼容路径。返回的 ArrayBuffer
 * 会交给 Worker transferable。
 */

import { isTauri } from '@desktop/runtime.js';
import {
  batchReadCachedFiles,
  readLineSemanticPack,
} from '@desktop/database.js';
import { isDiskBackedFile, isSemanticPackBackedFile } from '@desktop/gimExtract.js';
import type { LineParserWorkerFile } from './lineParserWorker.js';

const TEXT_EXTENSIONS = new Set(['cbm', 'dev', 'fam', 'phm']);

/**
 * 线路 MOD 同时承载两种内容：数百字节的文本族（例如 CROSS 的
 * `CODE=...`）和数 MB 的几何族。后者不参与线路首屏语义解析，只会在
 * 用户查看来源时通过 currentFiles/缓存懒加载。原生 manifest-only File
 * 的 size 来自 Rust 清单，因此可在发起批量读取前安全跳过大几何条目。
 */
export const LINE_PARSER_SMALL_MOD_MAX_BYTES = 256 * 1024;

export interface LineParserBatchOptions {
  maxFiles?: number;
  maxBytes?: number;
  /** 工程切换时终止后续批次；回调必须只读取不可变 session 状态。 */
  isCurrent?: () => boolean;
}

export interface LineParserInputResult {
  files: LineParserWorkerFile[];
  /** 实际读取的有效字节（缺失文件不计入）。 */
  bytes: number;
  /** DiskBackedFile 批量读取 IPC 调用次数。 */
  batches: number;
  /** 读取路径数（含批量结果为 null 的条目）。 */
  requested: number;
  /** 读取过程中工程已切换；调用方应丢弃局部 files，不提交结果。 */
  cancelled?: boolean;
  /** Native line MOD geometry omitted from Worker input (metadata remains). */
  skippedLargeModFiles: number;
  /** Bytes omitted from Worker input for large MOD geometry files. */
  skippedLargeModBytes: number;
  /** 使用连续线路 semantic pack 的 IPC 次数（通常为 0 或 1）。 */
  semanticPackReads: number;
}

interface Candidate {
  path: string;
  file: File;
}

function isLineParserTextPath(path: string, file: File): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  const extension = path.slice(dot + 1).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return true;
  // Keep the old behavior for regular browser Files. Only native disk-backed
  // files are filtered, because their large MOD bytes would otherwise make a
  // needless IPC round-trip and Worker transfer.
  return extension === 'mod'
    && (!isDiskBackedFile(file) || file.size <= LINE_PARSER_SMALL_MOD_MAX_BYTES);
}

function toTransferable(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  // batchReadCachedFiles 的 envelope 解析会为每个条目生成精确长度的
  // Uint8Array；其 backing buffer 已经独占该条目时直接转移，避免再复制一遍。
  if (bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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

function buildBatchByteLookup(result: Map<string, Uint8Array | null>): Map<string, Uint8Array | null> {
  const normalized = new Map<string, Uint8Array | null>();
  for (const [candidatePath, bytes] of result) {
    const key = candidatePath.replace(/\\/g, '/').toLowerCase();
    if (!normalized.has(key)) normalized.set(key, bytes);
  }
  return normalized;
}

function lookupBatchBytes(
  result: Map<string, Uint8Array | null>,
  normalizedResult: Map<string, Uint8Array | null>,
  path: string,
): Uint8Array | null | undefined {
  const exact = result.get(path);
  if (exact !== undefined || result.has(path)) return exact;
  const key = path.replace(/\\/g, '/').toLowerCase();
  return normalizedResult.get(key);
}

async function readRegularCandidates(
  candidates: Candidate[],
  isCurrent: () => boolean,
): Promise<LineParserWorkerFile[]> {
  const result: LineParserWorkerFile[] = [];
  for (const candidate of candidates) {
    if (!isCurrent()) break;
    try {
      const bytes = await candidate.file.arrayBuffer();
      if (!isCurrent()) break;
      result.push({ path: candidate.path, bytes });
    } catch (error) {
      console.warn('[LineParserInput] 文件读取失败:', candidate.path, error);
    }
  }
  return result;
}

/** 读取线路 Worker 所需的可序列化输入。 */
export async function readLineParserInput(
  files: Map<string, File>,
  projectId: number | null,
  options: LineParserBatchOptions = {},
): Promise<LineParserInputResult> {
  // 8 MiB 仍是主要内存上限；将文件数上限提高到 1024 可显著减少
  // 小文件密集线路的 IPC 次数，而不会把单批响应放大到不可控规模。
  const maxFiles = Math.max(1, options.maxFiles ?? 1024);
  const maxBytes = Math.max(1, options.maxBytes ?? 8 * 1024 * 1024);
  const isCurrent = options.isCurrent ?? (() => true);
  const candidates = Array.from(files.entries())
    .filter(([path, file]) => isLineParserTextPath(path, file))
    .map(([path, file]) => ({ path, file }));
  const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
  const skippedLargeMod = Array.from(files.entries()).filter(([path, file]) => {
    const dot = path.lastIndexOf('.');
    return dot >= 0
      && path.slice(dot + 1).toLowerCase() === 'mod'
      && isDiskBackedFile(file)
      && file.size > LINE_PARSER_SMALL_MOD_MAX_BYTES;
  });
  const metadataFiles: LineParserWorkerFile[] = Array.from(files.keys())
    .filter((path) => !candidatePaths.has(path))
    // STL/MOD 等大二进制不属于线路语义 parser 的输入；仅发送路径元数据，
    // 让 Worker 仍能准确填充 filesByType，而不会把几何字节复制进解析线程。
    .map((path) => ({ path, bytes: new ArrayBuffer(0) }));
  const nativeDiskCandidates = isTauri() && projectId != null
    ? candidates.filter((candidate) => isDiskBackedFile(candidate.file))
    : [];
  const semanticPackCandidates = nativeDiskCandidates.filter((candidate) => isSemanticPackBackedFile(candidate.file));
  const diskCandidates = nativeDiskCandidates.filter((candidate) => !isSemanticPackBackedFile(candidate.file));
  // Array.includes() 逐项排除在大线路样本上会退化为 O(n²)；使用对象
  // identity Set 保持语义不变，同时避免输入准备阶段无意义的比较。
  const nativeDiskCandidateSet = new Set(nativeDiskCandidates);
  const regularCandidates = candidates.filter((candidate) => !nativeDiskCandidateSet.has(candidate));
  // 先按原始 Map 顺序暂存读取结果，最后再统一组装 Worker 输入；这样
  // semantic pack（一次 IPC）与普通 batch（多次 IPC）不会改变 parser 的
  // 文件遍历顺序，保持大小写兼容和旧样本结果一致。
  const resolved = new Map<string, ArrayBuffer>();
  const resolvedNormalized = new Map<string, ArrayBuffer>();
  const setResolved = (path: string, bytes: ArrayBuffer): void => {
    if (!resolved.has(path)) resolved.set(path, bytes);
    const key = path.replace(/\\/g, '/').toLowerCase();
    if (!resolvedNormalized.has(key)) resolvedNormalized.set(key, bytes);
  };
  const getResolved = (path: string): ArrayBuffer | undefined =>
    resolved.get(path) ?? resolvedNormalized.get(path.replace(/\\/g, '/').toLowerCase());
  let batches = 0;
  let semanticPackReads = 0;

  const result = (cancelled = false): LineParserInputResult => ({
    files: Array.from(candidates, (candidate) => {
      const bytes = getResolved(candidate.path);
      return bytes ? { path: candidate.path, bytes } : null;
    }).filter((file): file is LineParserWorkerFile => file !== null).concat(metadataFiles),
    bytes: Array.from(resolved.values()).reduce((sum, bytes) => sum + bytes.byteLength, 0),
    batches,
    requested: files.size,
    skippedLargeModFiles: skippedLargeMod.length,
    skippedLargeModBytes: skippedLargeMod.reduce((sum, [, file]) => sum + Math.max(0, file.size || 0), 0),
    semanticPackReads,
    ...(cancelled ? { cancelled: true } : {}),
  });

  if (!isCurrent()) return result(true);

  if (semanticPackCandidates.length > 0 && projectId != null) {
    if (!isCurrent()) return result(true);
    semanticPackReads += 1;
    const paths = semanticPackCandidates.map((candidate) => candidate.path);
    try {
      const bytesMap = await readLineSemanticPack(projectId, paths);
      if (!isCurrent()) return result(true);
      const normalizedBytesMap = buildBatchByteLookup(bytesMap);
      for (const candidate of semanticPackCandidates) {
        if (!isCurrent()) return result(true);
        const bytes = lookupBatchBytes(bytesMap, normalizedBytesMap, candidate.path);
        if (bytes != null) {
          setResolved(candidate.path, toTransferable(bytes));
        } else {
          // 索引缺项/损坏时仅回退该文件，不放弃其它 pack 命中。
          const fallback = await readRegularCandidates([candidate], isCurrent);
          for (const file of fallback) setResolved(file.path, file.bytes);
        }
      }
      if (!isCurrent()) return result(true);
    } catch (error) {
      // 只有单条 ENTRY_MISS 才允许逐条降级。pack/index 整体错误必须向上
      // 抛出，由打开流程使 semantic source cache 失效并重新解压重建；
      // 绝不能在其它条目完整时提交 partial graph/attributes。
      const kind = (error as { kind?: unknown } | null)?.kind;
      if (kind !== 'ENTRY_MISS') throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[LineParserInput] semantic pack 单条条目缺失，回退单文件读取:', message);
      const fallback = await readRegularCandidates(semanticPackCandidates, isCurrent);
      for (const file of fallback) setResolved(file.path, file.bytes);
      if (!isCurrent()) return result(true);
    }
  }

  if (diskCandidates.length > 0 && projectId != null) {
    for (const chunk of chunkCandidates(diskCandidates, maxFiles, maxBytes)) {
      if (!isCurrent()) return result(true);
      batches += 1;
      const paths = chunk.map((candidate) => candidate.path);
      let bytesMap: Map<string, Uint8Array | null>;
      try {
        bytesMap = await batchReadCachedFiles(projectId, paths);
      } catch (error) {
        console.warn('[LineParserInput] 批量读取失败，回退单文件读取:', error);
        const fallback = await readRegularCandidates(chunk, isCurrent);
        for (const file of fallback) setResolved(file.path, file.bytes);
        if (!isCurrent()) return result(true);
        continue;
      }
      if (!isCurrent()) return result(true);
      const normalizedBytesMap = buildBatchByteLookup(bytesMap);
      for (const candidate of chunk) {
        if (!isCurrent()) return result(true);
        const bytes = lookupBatchBytes(bytesMap, normalizedBytesMap, candidate.path);
        // null 表示缓存缺失；0 字节 Uint8Array 仍是有效的已命中条目，
        // 不能因为长度为 0 又触发一次 read_cached_entry IPC。
        if (bytes != null) {
          setResolved(candidate.path, toTransferable(bytes));
          continue;
        }
        // 缓存缺失/大小写变体响应时，保留兼容回退；单条失败不阻断其它文件。
        const fallback = await readRegularCandidates([candidate], isCurrent);
        for (const file of fallback) setResolved(file.path, file.bytes);
      }
    }
  }

  for (const chunk of chunkCandidates(regularCandidates, maxFiles, maxBytes)) {
    if (!isCurrent()) return result(true);
    const regular = await readRegularCandidates(chunk, isCurrent);
    for (const file of regular) setResolved(file.path, file.bytes);
    if (!isCurrent()) return result(true);
  }

  // 元数据条目不触发磁盘读取，仅用于保持 filesByType（尤其 STL/other）
  // 与既有 parser 统计一致。
  return result();
}
