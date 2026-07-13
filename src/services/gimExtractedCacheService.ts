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

/** 几何文件缓存结果（DEV/PHM/MOD） */
export interface GeometryCacheResult {
  /** 已缓存的 entry_path 数量 */
  cachedCount: number;
  /** 缓存失败的条目 */
  errors: Array<{
    entryPath: string;
    message: string;
  }>;
}

/**
 * 判断 entry_path 是否为几何发现需要的文件（DEV/PHM/MOD）。
 * 用于缓存命中场景下从磁盘读取这些文件以回放 xml-mod 几何。
 */
function isGeometryFile(entryPath: string): boolean {
  const lower = entryPath.toLowerCase();
  const isGeometryDir = lower.startsWith('dev/') || lower.startsWith('phm/') || lower.startsWith('mod/');
  const isGeometryExt = lower.endsWith('.dev') || lower.endsWith('.phm') || lower.endsWith('.mod');
  return isGeometryDir && isGeometryExt;
}

/**
 * 判断 entry_path 是否为 STD/SLD 拓扑与单线图文件。
 * - CBM/project.sch：SCH 入口
 * - CBM/*.std：STD 拓扑定义（XML）
 * - CBM/*.sld：SLD 电气单线图（SVG）
 *
 * 用于缓存命中场景下从磁盘读取这些文件以重新解析 STD/SLD。
 */
function isStdSldFile(entryPath: string): boolean {
  const lower = entryPath.toLowerCase();
  if (lower === 'cbm/project.sch') return true;
  if (!lower.startsWith('cbm/')) return false;
  return lower.endsWith('.std') || lower.endsWith('.sld');
}

/**
 * 缓存 GIM 解压后的几何文件（DEV/PHM/MOD）到本地磁盘。
 *
 * 与 cacheIfcEntries 的差异：
 * - cacheIfcEntries 以 ifcEntries 为准，仅缓存 IFC 文件
 * - 本函数遍历 files Map，缓存所有 DEV/PHM/MOD 文件
 * - 用于缓存命中场景下从磁盘读取这些文件以回放 xml-mod 几何
 *
 * @param projectId 数据库 gim_project.id
 * @param files GIM 解压后的文件集合
 */
export async function cacheGeometryFiles(
  projectId: number,
  files: Map<string, File>,
): Promise<GeometryCacheResult> {
  const errors: Array<{ entryPath: string; message: string }> = [];
  let cachedCount = 0;

  for (const [entryPath, file] of files) {
    if (!isGeometryFile(entryPath) && !isStdSldFile(entryPath)) continue;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await writeCacheFile(projectId, entryPath, bytes);
      cachedCount++;
    } catch (err) {
      errors.push({
        entryPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { cachedCount, errors };
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
