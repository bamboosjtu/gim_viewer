/** Source file hydration and individual MOD/STL loading. */
import * as THREE from 'three';
import type { DiscoveredModGeometry, DiscoveredStlGeometry } from './modGeometryDiscovery.js';
import { getFileByPath } from '../gim/fileLookup.js';
import { decodeGimText } from '../shared/textDecode.js';
import { readCachedEntry } from '@desktop/database.js';

/** One immutable key set per session, shared by discovery and source evidence.
 * Reads remain lazy; verification must not rebuild an archive index per DEV. */
export function createLazyGeometrySourceFiles(projectId:number|null,paths:Iterable<string>,sizes:ReadonlyMap<string,number>,current:()=>boolean):Map<string,File>{
  const files=new Map<string,File>();
  for(const path of paths)if(/\.(dev|phm|mod|stl|gl)$/i.test(path)){
    const read=async()=>{
      if(projectId==null||!current())throw Error('Device source unavailable');
      return new Uint8Array(await readCachedEntry(projectId,path)).buffer;
    };
    files.set(path,{name:path.split('/').pop()!,size:sizes.get(path)??0,arrayBuffer:read,
      text:async()=>decodeGimText(await read()).text} as File);
  }
  return files;
}

/**
 * 从文件集合加载单个 MOD 文件。
 *
 * @returns THREE.Group；加载失败返回 null
 */
export async function loadModFile(
  geo: DiscoveredModGeometry,
  files: Map<string, File>,
  outline?: { placementMatrix?: number[]; deferSmallPartFallback?: boolean },
): Promise<THREE.Group | null> {
  const { loadXmlModFromFiles } = await import('../viewer/xmlModLoader.js');
  // Raw fallback is a browsing representation, never exact L2 CSG. A caller
  // assembling an entire DEV may defer its all-small silhouette; standalone
  // MOD callers retain their local fallback.
  return loadXmlModFromFiles(geo.modPath, files, geo.phmColor, geo.phmColorMaxA, {
    lod: 0,
    outline: {
      placementMatrix: outline?.placementMatrix ?? geo.placementTransformMatrix,
      deferSmallPartFallback: outline?.deferSmallPartFallback ?? false
    },
  });
}

/**
 * 从文件集合加载单个 STL 文件。
 *
 * @returns THREE.Group；加载失败返回 null
 */
export async function loadStlFile(
  geo: DiscoveredStlGeometry,
  files: Map<string, File>,
): Promise<THREE.Group | null> {
  const file = getFileByPath(files, geo.stlPath);
  if (!file) {
    console.warn(`[autoLoad] STL 文件不存在: ${geo.stlPath}`);
    return null;
  }
  const buffer = await file.arrayBuffer();
  const { parseStlBinary } = await import('../viewer/stlLoader.js');
  const group = parseStlBinary(buffer, geo.stlPath);
  if (!group) return null;
  const { applyPhmColorOverride } = await import('../viewer/xmlModGeometry.js');
  applyPhmColorOverride(group, geo.phmColor, geo.phmColorMaxA);
  return group;
}

/**
 * 把 Uint8Array 转换为 File 对象（用于构建兼容 discovery API 的 Map）。
 */
export function bytesToFile(bytes: Uint8Array, path: string): File {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new File([ab], path, { type: 'application/octet-stream' });
}

export function normalizeDevEntryPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

/**
 * 规范化缓存中 PHM 指向的 MOD/STL 路径。
 *
 * PHM 导出器既可能写入裸文件名，也可能写入 `MOD/`、`STL/` 前缀；
 * 不能无条件拼接 `MOD/`，否则会生成 `MOD/MOD/foo.mod`，导致 geometry
 * cache rebuild 时误报文件缺失。保留首个路径的 casing，实际查找由
 * getFileByPath/batch bridge 以大小写不敏感方式完成。
 */

/**
 * 缓存命中场景：从磁盘 SQLite 缓存构建 DEV/PHM/MOD/STL 文件 Map。
 *
 * 沿引用链逐层读取：
 * 1. 读取所有唯一 DEV 文件 → 解析 DEV 收集 PHM 引用
 * 2. 读取所有唯一 PHM 文件 → 解析 PHM 收集 MOD/STL 引用
 * 3. 读取所有唯一 MOD/STL 文件
 *
 * @param projectId 数据库 gim_project.id
 * @param uniqueDevPaths CBM 树中收集的唯一 devPath 列表（不含 "DEV/" 前缀）
 * @returns 包含全部 DEV/PHM/MOD/STL 文件的 Map
 */
export async function buildFileMapFromDiskCache(
  projectId: number,
  uniqueDevPaths: string[],
  inventory: Iterable<string>,
): Promise<Map<string, File> | null> {
  const { batchReadCachedFiles } = await import('@desktop/database.js');
  const { hydrateSubstationGeometryGraph } = await import('../gim/geometry/substationSourceGraph.js');
  const files = await hydrateSubstationGeometryGraph(uniqueDevPaths, async (paths) => {
    const bytes = await batchReadCachedFiles(projectId, paths);
    return new Map([...bytes].filter(([, value]) => value && value.byteLength > 0)
      .map(([path, value]) => [path, bytesToFile(value!, path)]));
  }, inventory);
  return files.size ? files : null;
}
