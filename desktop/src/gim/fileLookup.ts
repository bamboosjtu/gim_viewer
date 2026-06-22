/**
 * GIM 解压文件集合的路径查找工具。
 *
 * GIM 导出器对顶层目录和文件名大小写没有统一约定（例如 `CBM/`、
 * `Cbm/`、`cbm/` 会混用），而引用值通常使用固定的大写目录。所有由
 * 引用值驱动的读取都应经过本模块，避免在某个导出器上出现“索引存在但
 * 文件读不到”的隐性降级。
 */

export interface FilePathEntry {
  /** 文件在解压 Map 中的实际键（保留原始大小写，供展示和缓存写入使用） */
  path: string;
  file: File;
}

interface FilePathIndex {
  size: number;
  byLowerPath: Map<string, FilePathEntry>;
}

/** Map 通常在一次打开流程内保持不变；按 Map 身份缓存索引，避免递归查找反复 O(n) 扫描。 */
const indexCache = new WeakMap<Map<string, File>, FilePathIndex>();

/** 统一分隔符并去掉引用值中常见的 `./` 前缀。 */
export function normalizeFilePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function getIndex(files: Map<string, File>): Map<string, FilePathEntry> {
  const cached = indexCache.get(files);
  if (cached && cached.size === files.size) return cached.byLowerPath;

  const byLowerPath = new Map<string, FilePathEntry>();
  for (const [path, file] of files) {
    const normalized = normalizeFilePath(path);
    const key = normalized.toLowerCase();
    // 重名时保留归档中的第一项；精确键命中仍优先，行为确定且不因大小写
    // 变体顺序改变已经建立的引用。
    if (!byLowerPath.has(key)) byLowerPath.set(key, { path, file });
  }
  indexCache.set(files, { size: files.size, byLowerPath });
  return byLowerPath;
}

/** 按路径读取文件，路径分隔符和大小写均不敏感。 */
export function getFileByPath(files: Map<string, File>, path: string): File | undefined {
  const exact = files.get(path) ?? files.get(normalizeFilePath(path));
  if (exact) return exact;
  return getIndex(files).get(normalizeFilePath(path).toLowerCase())?.file;
}

/** 按路径读取文件及其实际 Map 键。 */
export function findFileByPath(files: Map<string, File>, path: string): FilePathEntry | undefined {
  const exact = files.get(path);
  if (exact) return { path, file: exact };
  const normalized = normalizeFilePath(path);
  const normalizedExact = files.get(normalized);
  if (normalizedExact) return { path: normalized, file: normalizedExact };
  return getIndex(files).get(normalized.toLowerCase());
}

/** 判断路径是否存在，路径分隔符和大小写均不敏感。 */
export function hasFileByPath(files: Map<string, File>, path: string): boolean {
  return findFileByPath(files, path) !== undefined;
}

