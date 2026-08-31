/**
 * 原生解压 Tauri 桥接（acc-plan P0-2）。
 *
 * 调用 Rust `extract_gim_archive` 命令，以原生速度解压 7z/ZIP 归档，
 * 返回二进制 payload：[u32 LE manifest 长度][manifest JSON][可选条目数据 blob]。
 * Tauri 传入 project_id 时为磁盘优先 manifest-only；浏览器/兼容调用仍可携带 blob。
 *
 * 浏览器模式或原生解压失败时由调用方回退 libarchive.js WASM 路径。
 */

import { invokeTimed } from './invokeTimed.js';

export interface NativeExtractionResult {
  /** GIM 魔数（GIMPKGS/GIMPKGT） */
  magic: string;
  projectId?: string;
  projectName?: string;
  /** 展平后的文件 Map（与 extractGimFile 输出同构） */
  files: Map<string, File>;
  /** 已由 Rust 直接落盘的缓存路径（entryPath → 绝对路径），可跳过 JS 逐文件字节回传 */
  cachePaths: Map<string, string>;
  /** 原生解压对应的 SQLite project_id，用于按 entry_path 懒读。 */
  cacheProjectId?: number;
}

/** manifest 条目 */
interface ExtractManifestEntry {
  path: string;
  offset: number;
  size: number;
  cache_path?: string;
}

/** manifest 结构 */
interface ExtractManifest {
  magic: string;
  project_id?: string;
  project_name?: string;
  entries: ExtractManifestEntry[];
}

/**
 * 磁盘条目的最小 File 兼容实现。
 *
 * 原生解压在 project_id 场景只回传 manifest，Map 中的值不携带文件字节；
 * parser 调用 text()/arrayBuffer() 时才通过受限的 read_cached_entry IPC 读取
 * 当前条目。这样既保留现有 Map<string, File> 解析边界，也避免创建全量 File。
 */
class DiskBackedBlob {
  readonly size: number;
  readonly type: string;

  constructor(
    private readonly projectId: number,
    private readonly entryPath: string,
    size: number,
    private readonly start = 0,
    private readonly end = size,
    type = '',
  ) {
    this.size = Math.max(0, this.end - this.start);
    this.type = type;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    // 空切片不需要触发 IPC；这也让不存在/已清理的源条目仍保持标准
    // Blob.slice() 的空结果语义。
    if (this.size === 0) return new ArrayBuffer(0);
    const { readCachedEntry } = await import('./database.js');
    const bytes = await readCachedEntry(this.projectId, this.entryPath);
    if (bytes.byteLength < this.end) {
      throw new Error(`缓存条目长度不足: ${this.entryPath} (expected >= ${this.end}, actual ${bytes.byteLength})`);
    }
    const view = bytes.subarray(this.start, this.end);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer());
  }

  stream(): ReadableStream<Uint8Array> {
    const self = this;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(new Uint8Array(await self.arrayBuffer()));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  slice(start = 0, end = this.size, contentType = ''): Blob {
    const relativeStart = start < 0 ? Math.max(this.size + start, 0) : Math.min(start, this.size);
    const relativeEnd = end < 0 ? Math.max(this.size + end, 0) : Math.min(end, this.size);
    // Blob 规范：end 小于或等于 start 时返回空 Blob；不能交换边界，
    // 否则 `slice(8, 3)` 会意外暴露中间字节。
    const boundedStart = Math.min(relativeStart, relativeEnd);
    const boundedEnd = Math.max(relativeStart, relativeEnd);
    const empty = relativeEnd <= relativeStart;
    return new DiskBackedBlob(
      this.projectId,
      this.entryPath,
      this.end,
      this.start + (empty ? relativeStart : boundedStart),
      this.start + (empty ? relativeStart : boundedEnd),
      contentType,
    ) as unknown as Blob;
  }
}

class DiskBackedFile extends DiskBackedBlob {
  /** 供线路批量读取协调器识别 native manifest-only 文件。 */
  readonly __gimDiskBacked = true;
  readonly lastModified = 0;
  readonly name: string;
  readonly webkitRelativePath = '';

  constructor(projectId: number, entryPath: string, size: number, name: string) {
    super(projectId, entryPath, size);
    this.name = name;
  }
}

/** 判断条目是否由原生解压落盘并按需从缓存读取。 */
export function isDiskBackedFile(value: File | undefined): boolean {
  return Boolean(value && (value as File & { __gimDiskBacked?: boolean }).__gimDiskBacked === true);
}

const MAX_NATIVE_ENTRIES = 200_000;
const MAX_NATIVE_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_NATIVE_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_NATIVE_PATH_BYTES = 4096;
const UTF8_ENCODER = new TextEncoder();

function assertSafeEntryPath(path: string): void {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || UTF8_ENCODER.encode(normalized).byteLength > MAX_NATIVE_PATH_BYTES
    || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`原生解压条目路径不安全: ${path}`);
  }
}

/**
 * 解析二进制 payload 为文件 Map（纯函数，供单测直接调用）。
 *
 * @param buf invoke 返回的 ArrayBuffer
 * @throws 当长度不足、magic 不符或 JSON 解析失败时抛错
 */
export function parseExtractionPayload(
  buf: ArrayBuffer,
  options: { cacheProjectId?: number } = {},
): Omit<NativeExtractionResult, 'files'> & {
  files: Map<string, File>;
} {
  if (buf.byteLength < 8) throw new Error('payload 过短');
  const dv = new DataView(buf);
  const manifestLen = dv.getUint32(0, true);
  const base = 4 + manifestLen;
  if (base > buf.byteLength) throw new Error('manifest 长度越界');
  const manifest: ExtractManifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, manifestLen)));
  if (typeof manifest.magic !== 'string' || !manifest.magic.startsWith('GIMPKG')) {
    throw new Error('manifest GIM 魔数无效');
  }
  if (!Array.isArray(manifest.entries)) throw new Error('manifest 缺少 entries');
  if (manifest.entries.length > MAX_NATIVE_ENTRIES) throw new Error(`manifest 条目数超过 ${MAX_NATIVE_ENTRIES}`);

  const files = new Map<string, File>();
  const cachePaths = new Map<string, string>();
  const hasInlineBlob = buf.byteLength > base;
  let totalBytes = 0;
  for (const e of manifest.entries) {
    assertSafeEntryPath(e.path);
    if (!Number.isSafeInteger(e.offset) || !Number.isSafeInteger(e.size)
      || e.size > MAX_NATIVE_FILE_BYTES) throw new Error(`条目 ${e.path} 大小无效或超限`);
    if (e.offset < 0 || e.size < 0 || e.offset > Number.MAX_SAFE_INTEGER - e.size) {
      throw new Error(`条目 ${e.path} 数据越界`);
    }
    if (hasInlineBlob && e.offset + e.size > buf.byteLength - base) {
      throw new Error(`条目 ${e.path} 数据越界`);
    }
    if (!hasInlineBlob && e.size > 0 && (options.cacheProjectId == null || !e.cache_path)) {
      throw new Error(`条目 ${e.path} 缺少磁盘缓存路径`);
    }
    totalBytes += e.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_NATIVE_TOTAL_BYTES) {
      throw new Error(`原生解压总大小超过 ${MAX_NATIVE_TOTAL_BYTES}`);
    }
    const name = e.path.split('/').pop() || e.path;
    if (hasInlineBlob || options.cacheProjectId == null) {
      // 无 inline blob 且没有 project_id 时，只可能是零字节兼容 payload；
      // 不能把它误包装成需要 IPC 的 DiskBackedFile。
      const part = buf.slice(base + e.offset, base + e.offset + e.size);
      files.set(e.path, new File([part], name));
    } else {
      files.set(e.path, new DiskBackedFile(options.cacheProjectId!, e.path, e.size, name) as unknown as File);
    }
    if (e.cache_path) cachePaths.set(e.path, e.cache_path);
  }

  return {
    magic: manifest.magic,
    projectId: manifest.project_id,
    projectName: manifest.project_name,
    files,
    cachePaths,
    cacheProjectId: options.cacheProjectId,
  };
}

/**
 * 原生解压 .gim 文件（仅 Tauri 环境调用）。
 *
 * @param filePath .gim 文件在磁盘上的绝对路径
 * @throws 解压失败时抛错，调用方应回退 WASM 路径
 */
export async function extractGimArchiveNative(
  filePath: string,
  projectId?: number,
): Promise<NativeExtractionResult> {
  const buf = await invokeTimed<ArrayBuffer>('extract_gim_archive', { filePath, projectId });
  return parseExtractionPayload(buf, { cacheProjectId: projectId });
}
