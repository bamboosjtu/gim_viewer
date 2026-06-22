/**
 * 原生解压 Tauri 桥接（acc-plan P0-2）。
 *
 * 调用 Rust `extract_gim_archive` 命令，以原生速度解压 7z/ZIP 归档，
 * 返回二进制 payload：[u32 LE manifest 长度][manifest JSON][条目数据 blob]。
 *
 * 浏览器模式或原生解压失败时由调用方回退 libarchive.js WASM 路径。
 */

import { invoke } from '@tauri-apps/api/core';

export interface NativeExtractionResult {
  /** GIM 魔数（GIMPKGS/GIMPKGT） */
  magic: string;
  projectId?: string;
  projectName?: string;
  /** 展平后的文件 Map（与 extractGimFile 输出同构） */
  files: Map<string, File>;
  /** 已由 Rust 直接落盘的缓存路径（entryPath → 绝对路径），可跳过 JS 逐文件字节回传 */
  cachePaths: Map<string, string>;
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
export function parseExtractionPayload(buf: ArrayBuffer): Omit<NativeExtractionResult, 'files'> & {
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
  let totalBytes = 0;
  for (const e of manifest.entries) {
    assertSafeEntryPath(e.path);
    if (!Number.isSafeInteger(e.offset) || !Number.isSafeInteger(e.size)
      || e.size > MAX_NATIVE_FILE_BYTES) throw new Error(`条目 ${e.path} 大小无效或超限`);
    if (e.offset < 0 || e.size < 0 || e.offset > Number.MAX_SAFE_INTEGER - e.size
      || e.offset + e.size > buf.byteLength - base) throw new Error(`条目 ${e.path} 数据越界`);
    totalBytes += e.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_NATIVE_TOTAL_BYTES) {
      throw new Error(`原生解压总大小超过 ${MAX_NATIVE_TOTAL_BYTES}`);
    }
    const part = buf.slice(base + e.offset, base + e.offset + e.size);
    const name = e.path.split('/').pop() || e.path;
    files.set(e.path, new File([part], name));
    if (e.cache_path) cachePaths.set(e.path, e.cache_path);
  }

  return {
    magic: manifest.magic,
    projectId: manifest.project_id,
    projectName: manifest.project_name,
    files,
    cachePaths,
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
  const buf = await invoke<ArrayBuffer>('extract_gim_archive', { filePath, projectId });
  return parseExtractionPayload(buf);
}
