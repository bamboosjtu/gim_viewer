/**
 * 线路解析输入读取协调器。
 *
 * 首次 native 解压得到的 DiskBackedFile 不再逐个调用 text()；在 Tauri 中按
 * 文件数/总字节上限调用 batchReadCachedFiles。WASM/浏览器普通 File 仍走
 * File.arrayBuffer() 兼容路径。返回的 ArrayBuffer 会交给 Worker transferable。
 */

import { isTauri } from '@desktop/runtime.js';
import { batchReadCachedFiles } from '@desktop/database.js';
import { isDiskBackedFile } from '@desktop/gimExtract.js';
import type { LineParserWorkerFile } from './lineParserWorker.js';

const TEXT_EXTENSIONS = new Set(['cbm', 'dev', 'fam', 'phm', 'mod']);

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
}

interface Candidate {
  path: string;
  file: File;
}

function isLineTextPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
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

function lookupBatchBytes(
  result: Map<string, Uint8Array | null>,
  path: string,
): Uint8Array | null | undefined {
  const exact = result.get(path);
  if (exact !== undefined || result.has(path)) return exact;
  const key = path.replace(/\\/g, '/').toLowerCase();
  for (const [candidatePath, bytes] of result) {
    if (candidatePath.replace(/\\/g, '/').toLowerCase() === key) return bytes;
  }
  return undefined;
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
  const maxFiles = Math.max(1, options.maxFiles ?? 256);
  const maxBytes = Math.max(1, options.maxBytes ?? 8 * 1024 * 1024);
  const isCurrent = options.isCurrent ?? (() => true);
  const candidates = Array.from(files.entries())
    .filter(([path]) => isLineTextPath(path))
    .map(([path, file]) => ({ path, file }));
  const metadataFiles: LineParserWorkerFile[] = Array.from(files.keys())
    .filter((path) => !isLineTextPath(path))
    // STL/MOD 等大二进制不属于线路语义 parser 的输入；仅发送路径元数据，
    // 让 Worker 仍能准确填充 filesByType，而不会把几何字节复制进解析线程。
    .map((path) => ({ path, bytes: new ArrayBuffer(0) }));
  const diskCandidates = isTauri() && projectId != null
    ? candidates.filter((candidate) => isDiskBackedFile(candidate.file))
    : [];
  const regularCandidates = candidates.filter((candidate) => !diskCandidates.includes(candidate));
  const output: LineParserWorkerFile[] = [];
  let batches = 0;

  const result = (cancelled = false): LineParserInputResult => ({
    files: output,
    bytes: output.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    batches,
    requested: files.size,
    ...(cancelled ? { cancelled: true } : {}),
  });

  if (!isCurrent()) return result(true);

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
        output.push(...await readRegularCandidates(chunk, isCurrent));
        if (!isCurrent()) return result(true);
        continue;
      }
      if (!isCurrent()) return result(true);
      for (const candidate of chunk) {
        if (!isCurrent()) return result(true);
        const bytes = lookupBatchBytes(bytesMap, candidate.path);
        // null 表示缓存缺失；0 字节 Uint8Array 仍是有效的已命中条目，
        // 不能因为长度为 0 又触发一次 read_cached_entry IPC。
        if (bytes != null) {
          output.push({ path: candidate.path, bytes: toTransferable(bytes) });
          continue;
        }
        // 缓存缺失/大小写变体响应时，保留兼容回退；单条失败不阻断其它文件。
        const fallback = await readRegularCandidates([candidate], isCurrent);
        output.push(...fallback);
      }
    }
  }

  for (const chunk of chunkCandidates(regularCandidates, maxFiles, maxBytes)) {
    if (!isCurrent()) return result(true);
    output.push(...await readRegularCandidates(chunk, isCurrent));
    if (!isCurrent()) return result(true);
  }

  // 元数据条目不触发磁盘读取，仅用于保持 filesByType（尤其 STL/other）
  // 与既有 parser 统计一致。
  output.push(...metadataFiles);

  return result();
}
