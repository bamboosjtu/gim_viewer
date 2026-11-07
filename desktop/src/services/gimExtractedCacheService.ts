import { writeCacheFile } from '@desktop/database.js';
import type { IfcEntry } from '../gim/types.js';
import { getFileByPath } from '../gim/fileLookup.js';

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

/** WASM 回退的完整来源缓存结果。 */
export interface ExtractedCacheResult {
  pathMap: Map<string, string>;
  /** 已缓存的 entry_path 数量 */
  cachedCount: number;
  /** 缓存失败的条目 */
  errors: Array<{
    entryPath: string;
    message: string;
  }>;
}

/**
 * WASM 回退必须持久化整个归档清单。只缓存已知扩展名会让未登记条目
 * 没有 source cache，随后 SQLite 核心索引的完整性校验无法通过。
 * 已缓存的 IFC 不重复写；失败条目由发布阶段明确拒绝，不标记完整。
 */
export async function cacheExtractedFiles(
  projectId: number,
  files: Map<string, File>,
  alreadyCached: ReadonlyMap<string,string> = new Map(),
): Promise<ExtractedCacheResult> {
  const errors: Array<{ entryPath: string; message: string }> = [];
  let cachedCount = 0;
  const pathMap = new Map<string,string>();

  for (const [entryPath, file] of files) {
    if (alreadyCached.has(entryPath)) continue;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const localPath = await writeCacheFile(projectId, entryPath, bytes);
      pathMap.set(entryPath,localPath);
      cachedCount++;
    } catch (err) {
      errors.push({
        entryPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { cachedCount, errors, pathMap };
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
    const file = getFileByPath(files, entry.path);
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
