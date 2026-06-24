import { writeCacheFile } from '../desktop/database.js';
import type { IfcEntry } from '../gim/types.js';

/** IFC 缓存结果 */
export interface IfcCacheResult {
  /** key = IfcEntry.path, value = local_cache_path */
  pathMap: Map<string, string>;
  /** 缓存失败的条目 */
  errors: Array<{
    entryPath: string;
    message: string;
  }>;
}

/**
 * 缓存 GIM 解压后的 IFC 文件到本地磁盘。
 * 以 ifcEntries 为准，逐个查找 files 中的 File 并写入缓存。
 *
 * @param projectId 数据库 gim_project.id
 * @param files GIM 解压后的文件集合
 * @param ifcEntries 发现的 IFC 文件条目
 */
export async function cacheIfcEntries(
  projectId: number,
  files: Map<string, File>,
  ifcEntries: IfcEntry[],
): Promise<IfcCacheResult> {
  const pathMap = new Map<string, string>();
  const errors: Array<{ entryPath: string; message: string }> = [];

  for (const entry of ifcEntries) {
    const file = files.get(entry.path);
    if (!file) {
      errors.push({ entryPath: entry.path, message: 'GIM 解压结果中找不到 IFC 文件' });
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const localPath = await writeCacheFile(projectId, entry.path, bytes);
      pathMap.set(entry.path, localPath);
    } catch (err) {
      errors.push({
        entryPath: entry.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { pathMap, errors };
}

/**
 * 旧函数：遍历 files 中所有 .ifc 文件。
 * @deprecated 请使用 cacheIfcEntries
 */
export async function cacheExtractedIfcFiles(
  projectId: number,
  files: Map<string, File>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const [entryPath, file] of files) {
    if (!entryPath.toLowerCase().endsWith('.ifc')) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const localPath = await writeCacheFile(projectId, entryPath, bytes);
    result.set(entryPath, localPath);
  }
  return result;
}
