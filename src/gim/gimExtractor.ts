let archiveInitialized = false;

async function getArchive() {
  const mod = await import('libarchive.js');
  if (!archiveInitialized) {
    mod.Archive.init({ workerUrl: 'worker-bundle.js' });
    archiveInitialized = true;
  }
  return mod.Archive;
}

const GIM_PACKAGE_MAGIC = 'GIMPKG';
const ARCHIVE_SIGNATURE_SEARCH_LIMIT = 1024 * 1024;

function hasGimPackageHeader(v: Uint8Array): boolean {
  if (v.length < GIM_PACKAGE_MAGIC.length) return false;
  return String.fromCharCode(...v.slice(0, GIM_PACKAGE_MAGIC.length)) === GIM_PACKAGE_MAGIC;
}

/** 在 ArrayBuffer 中搜索 7z 或 ZIP 签名的偏移量 */
export function findArchiveOffset(buffer: ArrayBuffer): number {
  const v = new Uint8Array(buffer);
  if (v.length < 8) return 0;
  if (!hasGimPackageHeader(v)) return 0;
  const limit = Math.min(v.length, ARCHIVE_SIGNATURE_SEARCH_LIMIT);
  // 搜索 7z 签名
  for (let i = GIM_PACKAGE_MAGIC.length; i < limit - 5; i++) {
    if (v[i] === 0x37 && v[i + 1] === 0x7a && v[i + 2] === 0xbc && v[i + 3] === 0xaf && v[i + 4] === 0x27 && v[i + 5] === 0x1c) return i;
  }
  // 搜索 ZIP 签名
  for (let i = GIM_PACKAGE_MAGIC.length; i < limit - 3; i++) {
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
  const Archive = await getArchive();
  const archive = await Archive.open(file);
  const extracted = await archive.extractFiles();
  await archive.close();
  return flattenExtractedFiles(extracted);
}
