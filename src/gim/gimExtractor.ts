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

/** GIM 头部解析结果 */
export interface GimHeaderInfo {
  /** 魔数类型（GIMPKGS=变电 / GIMPKGT=线路） */
  magic: string;
  /** 项目编号（头部第一个 \0 分隔的字段，若可解析） */
  projectId?: string;
  /** 项目名称（头部第二个 \0 分隔的字段，若可解析） */
  projectName?: string;
  /** 压缩数据起始偏移 */
  archiveOffset: number;
}

function hasGimPackageHeader(v: Uint8Array): boolean {
  if (v.length < GIM_PACKAGE_MAGIC.length) return false;
  return String.fromCharCode(...v.slice(0, GIM_PACKAGE_MAGIC.length)) === GIM_PACKAGE_MAGIC;
}

/** 在 ArrayBuffer 中搜索 7z 或 ZIP 签名的偏移量 */
function findArchiveOffset(buffer: ArrayBuffer): number {
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

/**
 * 解析 GIM 头部信息。
 *
 * GIM 文件头部格式（变电 GIMPKGS / 线路 GIMPKGT）：
 * - 偏移 0: 魔数（"GIMPKGS" 或 "GIMPKGT"，变长 6-7 字节）
 * - 魔数后: 头部文本区（含项目编号、项目名称等字段，以 \0 分隔）
 * - 零填充（\0）直到压缩数据起始位置
 * - 压缩数据（7z 或 ZIP）
 *
 * 头部文本区字段以 \0 分隔：
 * - 字段 1（紧随魔数后）：魔数后缀（如 "S" 或 "T" 已在魔数中，第一字段为项目编号）
 * - 字段 2：项目名称
 * - 其余字段：其他元数据
 *
 * 由于魔数与字段之间无明确分隔符，采用如下策略：
 * 1. 确定魔数长度（GIMPKGS=7, GIMPKGT=7，常见为 7）
 * 2. 从魔数后开始读取，直到第一个 \0 → 第一字段
 * 3. 跳过 \0，读取直到第二个 \0 → 第二字段（项目名称）
 * 4. 字段以 GBK/UTF-8 编码，尝试 UTF-8 解码
 *
 * @param buffer GIM 文件 ArrayBuffer
 * @returns 头部信息；非 GIM 文件或解析失败返回 null
 */
export function extractGimHeader(buffer: ArrayBuffer): GimHeaderInfo | null {
  const v = new Uint8Array(buffer);
  if (v.length < 8) return null;
  if (!hasGimPackageHeader(v)) return null;

  const offset = findArchiveOffset(buffer);
  if (offset <= GIM_PACKAGE_MAGIC.length) return null;

  // 确定魔数实际长度（GIMPKGS / GIMPKGT 为 7 字节，基础 GIMPKG 为 6 字节）
  let magicLen = GIM_PACKAGE_MAGIC.length; // 6
  if (v[6] === 0x53 /* S */ || v[6] === 0x54 /* T */) magicLen = 7;
  const magic = String.fromCharCode(...v.slice(0, magicLen));

  // 读取头部文本区（魔数后到压缩数据前），去掉尾部零填充
  const headerBytes = v.slice(magicLen, offset);
  // 找到连续非零区域：跳过开头 \0（通常紧跟魔数后就是字段）
  let start = 0;
  while (start < headerBytes.length && headerBytes[start] === 0) start++;
  if (start >= headerBytes.length) {
    return { magic, archiveOffset: offset };
  }

  // 按 \0 分割字段
  const fields: string[] = [];
  let fieldStart = start;
  for (let i = start; i < headerBytes.length; i++) {
    if (headerBytes[i] === 0) {
      if (i > fieldStart) {
        const fieldBytes = headerBytes.slice(fieldStart, i);
        try {
          fields.push(new TextDecoder('utf-8', { fatal: false }).decode(fieldBytes).trim());
        } catch {
          fields.push('');
        }
      }
      fieldStart = i + 1;
      // 连续 \0 视为字段区结束（零填充开始）
      let zeroRun = 0;
      while (fieldStart < headerBytes.length && headerBytes[fieldStart] === 0) {
        fieldStart++;
        zeroRun++;
      }
      if (zeroRun >= 4) break; // 4 个以上连续 \0 视为零填充开始
    }
  }

  const projectId = fields[0] || undefined;
  const projectName = fields[1] || undefined;

  return { magic, projectId, projectName, archiveOffset: offset };
}

/**
 * 根据 GIM 魔数返回工程类型名称（用于 F1System 根节点显示）。
 *
 * - GIMPKGS → "变电工程"（Substation）
 * - GIMPKGT → "线路工程"（Transmission，走独立 CBM 解析器）
 * - 其他 GIMPKG 变体 → "建筑工程"
 */
export function getProjectTypeName(magic: string): string {
  if (magic === 'GIMPKGS') return '变电工程';
  if (magic === 'GIMPKGT') return '线路工程';
  if (magic.startsWith('GIMPKG')) return '建筑工程';
  return '变电工程';
}

/** 将 libarchive.js 解压结果展平为 Map<path, File> */
function flattenExtractedFiles(obj: unknown, prefix = ''): Map<string, File> {
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
