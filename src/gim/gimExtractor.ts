import { Archive } from 'libarchive.js';

// 初始化 libarchive.js Worker
Archive.init({ workerUrl: 'worker-bundle.js' });

/** 在 ArrayBuffer 中搜索 7z 或 ZIP 签名的偏移量 */
export function findArchiveOffset(buffer: ArrayBuffer): number {
  const v = new Uint8Array(buffer);
  if (v.length < 8) return 0;
  if (String.fromCharCode(...v.slice(0, 7)) !== 'GIMPKGS') return 0;
  // 搜索 7z 签名
  for (let i = 7; i < Math.min(v.length, 4096) - 5; i++) {
    if (v[i] === 0x37 && v[i + 1] === 0x7a && v[i + 2] === 0xbc && v[i + 3] === 0xaf && v[i + 4] === 0x27 && v[i + 5] === 0x1c) return i;
  }
  // 搜索 ZIP 签名
  for (let i = 7; i < Math.min(v.length, 4096) - 3; i++) {
    if (v[i] === 0x50 && v[i + 1] === 0x4b && v[i + 2] === 0x03 && v[i + 3] === 0x04) return i;
  }
  return 0;
}

/** 将 libarchive.js 解压结果展平为 Map<path, File> */
export function flattenExtractedFiles(obj: unknown, prefix = ''): Map<string, File> {
  const result = new Map<string, File>();
  if (!obj || typeof obj !== 'object') return result;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}/${key}` : key;
    if (value instanceof File) result.set(path, value);
    else if (value && typeof value === 'object') for (const [sp, sf] of flattenExtractedFiles(value, path)) result.set(sp, sf);
  }
  return result;
}

/** 解压 GIM 文件，返回展平后的文件 Map */
export async function extractGimFile(arrayBuffer: ArrayBuffer): Promise<Map<string, File>> {
  const offset = findArchiveOffset(arrayBuffer);
  const ab = offset > 0 ? arrayBuffer.slice(offset) : arrayBuffer;
  const blob = new Blob([ab]);
  const file = new File([blob], 'archive', { type: 'application/octet-stream' });
  const archive = await Archive.open(file);
  const extracted = await archive.extractFiles();
  await archive.close();
  return flattenExtractedFiles(extracted);
}
