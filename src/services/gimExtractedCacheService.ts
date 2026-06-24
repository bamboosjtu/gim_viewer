import { writeCacheFile } from '../desktop/database.js';

/**
 * 缓存 GIM 解压后的 IFC 文件到本地磁盘。
 * 只缓存 .ifc 文件，不缓存所有文件。
 *
 * @param projectId 数据库 gim_project.id
 * @param files GIM 解压后的文件集合
 * @returns Map<entry_path, local_cache_path>
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
