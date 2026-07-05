/**
 * 变电工程 MOD/STL 几何自动加载服务。
 *
 * 在 IFC 加载完成后，遍历 CBM 树收集所有需要非 IFC 几何的节点，
 * 沿引用链 CBM → DEV → PHM → MOD/STL 发现几何源，去重后分批异步加载。
 *
 * 性能策略（防止卡死）：
 * - 仅加载 CBM 引用链可达的 MOD/STL，绝不遍历 MOD/ 目录全量加载
 * - DEV/PHM 文件解析结果跨节点缓存（同一 DEV 不重复 parse）
 * - MOD/STL 文件全局去重（loadedXmlModGroups / loadedStlGroups 索引）
 * - 分批加载：每批最多 CONCURRENCY 个文件，批次间 yield 主线程
 * - 进度回调，UI 可显示加载状态
 *
 * 文件来源：
 * - 首次打开：state.currentFiles（GIM 解压内存 Map）
 * - 缓存命中：从磁盘 SQLite 缓存读取 DEV/PHM/MOD/STL（readCachedIfc）
 */

import type * as THREE from 'three';
import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { DiscoveredModGeometry, DiscoveredStlGeometry } from './modGeometryDiscovery.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { parseDev } from '../gim/geometry/devParser.js';
import { parsePhm } from '../gim/geometry/phmParser.js';

/** 每批并发加载的文件数 */
const CONCURRENCY = 4;

/** 批次间 yield 间隔（毫秒），让浏览器有机会处理 UI 事件 */
const YIELD_MS = 16;

/** 自动加载进度 */
export interface AutoLoadProgress {
  phase: 'collecting' | 'discovering' | 'loading_mod' | 'loading_stl' | 'done';
  collectedDevPaths: number;
  discoveredMods: number;
  discoveredStls: number;
  loadedMods: number;
  loadedStls: number;
  totalMods: number;
  totalStls: number;
  currentPath?: string;
}

/**
 * 遍历 CBM 树，收集所有 devPath（去重）。
 * 仅收集满足条件的节点：有 devPath 且无 ifcFile（无 IFC 几何，需 MOD/STL 回退）。
 */
function collectUniqueDevPaths(root: CbmNode | null): Map<string, CbmNode> {
  const devNodes = new Map<string, CbmNode>(); // devPath → 代表节点

  function walk(node: CbmNode) {
    // 仅收集无 IFC 但有 devPath 的节点（需要 MOD/STL 几何回退）
    if (node.devPath && !node.ifcFile && !node.ifcGuid && !devNodes.has(node.devPath)) {
      devNodes.set(node.devPath, node);
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  if (root) walk(root);
  return devNodes;
}

/**
 * 从文件集合加载单个 MOD 文件。
 *
 * @returns THREE.Group；加载失败返回 null
 */
async function loadModFile(
  geo: DiscoveredModGeometry,
  files: Map<string, File>,
): Promise<THREE.Group | null> {
  const { loadXmlModFromFiles } = await import('../viewer/xmlModLoader.js');
  return loadXmlModFromFiles(geo.modPath, files);
}

/**
 * 从文件集合加载单个 STL 文件。
 *
 * @returns THREE.Group；加载失败返回 null
 */
async function loadStlFile(
  geo: DiscoveredStlGeometry,
  files: Map<string, File>,
): Promise<THREE.Group | null> {
  const file = files.get(geo.stlPath);
  if (!file) {
    console.warn(`[autoLoad] STL 文件不存在: ${geo.stlPath}`);
    return null;
  }
  const buffer = await file.arrayBuffer();
  const { parseStlBinary } = await import('../viewer/stlLoader.js');
  return parseStlBinary(buffer, geo.stlPath);
}

/**
 * 把 Uint8Array 转换为 File 对象（用于构建兼容 discovery API 的 Map）。
 */
function bytesToFile(bytes: Uint8Array, path: string): File {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new File([ab], path, { type: 'application/octet-stream' });
}

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
 * @param devNodes devPath → CbmNode 映射（用于 readCachedIfc 需要的 entry_path 格式）
 * @returns 包含全部 DEV/PHM/MOD/STL 文件的 Map
 */
async function buildFileMapFromDiskCache(
  projectId: number,
  uniqueDevPaths: string[],
): Promise<Map<string, File> | null> {
  const { readCachedIfc } = await import('../desktop/database.js');
  const result = new Map<string, File>();

  // 第一步：读 DEV + 解析收集 PHM 引用
  const phmRefs = new Set<string>();
  for (const devPath of uniqueDevPaths) {
    const entryPath = `DEV/${devPath}`;
    if (result.has(entryPath)) continue;
    try {
      const bytes = await readCachedIfc(projectId, entryPath);
      const file = bytesToFile(bytes, entryPath);
      result.set(entryPath, file);

      // 解析 DEV 收集 PHM 引用
      const devText = new TextDecoder().decode(bytes);
      const devDoc = parseDev(devText, entryPath);
      for (const solid of devDoc.solidModels) {
        const phmName = solid.solidModelPath;
        if (phmName.toLowerCase().endsWith('.phm')) {
          phmRefs.add(`PHM/${phmName}`);
        }
      }
    } catch (err) {
      console.warn(`[autoLoad] 磁盘 DEV 读取失败: ${entryPath}`, err);
    }
  }

  // 第二步：读 PHM + 解析收集 MOD/STL 引用
  const modStlRefs = new Set<string>();
  for (const phmPath of phmRefs) {
    if (result.has(phmPath)) continue;
    try {
      const bytes = await readCachedIfc(projectId, phmPath);
      const file = bytesToFile(bytes, phmPath);
      result.set(phmPath, file);

      // 解析 PHM 收集 MOD/STL 引用
      const phmText = new TextDecoder().decode(bytes);
      const phmDoc = parsePhm(phmText, phmPath);
      for (const solid of phmDoc.solidModels) {
        modStlRefs.add(`MOD/${solid.solidModelPath}`);
      }
    } catch (err) {
      console.warn(`[autoLoad] 磁盘 PHM 读取失败: ${phmPath}`, err);
    }
  }

  // 第三步：读 MOD/STL 文件（仅加载引用到的）
  for (const modStlPath of modStlRefs) {
    if (result.has(modStlPath)) continue;
    try {
      const bytes = await readCachedIfc(projectId, modStlPath);
      const file = bytesToFile(bytes, modStlPath);
      result.set(modStlPath, file);
    } catch (err) {
      console.warn(`[autoLoad] 磁盘 MOD/STL 读取失败: ${modStlPath}`, err);
    }
  }

  return result.size > 0 ? result : null;
}

/**
 * 主入口：自动发现并加载变电工程中所有非 IFC 的 MOD/STL 几何。
 *
 * 调用时机：IFC 加载完成后（ViewerRuntime 已存在，scene 已可用）。
 *
 * @param state 全局 AppState（currentFiles 必须非空；currentCbmTree 必须非空）
 * @param scene THREE.Scene（来自 ctx.world.scene.three）
 * @param showProgress 进度回调（传入当前进度快照）
 * @returns 加载计数
 */
export async function autoLoadModAndStlGeometry(
  state: AppState,
  scene: THREE.Scene,
  showProgress: (p: AutoLoadProgress) => void,
): Promise<{ modCount: number; stlCount: number }> {
  let files = state.currentFiles;
  const cbmTree = state.currentCbmTree;

  if (!cbmTree) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] 跳过：currentCbmTree 为空');
    return { modCount: 0, stlCount: 0 };
  }

  // ── Phase 1: 收集 devPath ──
  showProgress({ phase: 'collecting', collectedDevPaths: 0, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
  const devNodes = collectUniqueDevPaths(cbmTree);
  const uniqueDevPaths = Array.from(devNodes.keys());

  debugLog(DEBUG_IFC_LOAD, `[autoLoad] 收集到 ${uniqueDevPaths.length} 个唯一 devPath（来自 CBM 树）`);

  if (uniqueDevPaths.length === 0) {
    showProgress({ phase: 'done', collectedDevPaths: 0, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
    return { modCount: 0, stlCount: 0 };
  }

  // ── Phase 1.5: 缓存命中场景 → 从磁盘构建文件 Map ──
  const isCacheHit = !files;
  if (isCacheHit && state.currentProjectId != null) {
    showProgress({ phase: 'collecting', collectedDevPaths: uniqueDevPaths.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0, currentPath: '从磁盘缓存读取...' });
    files = await buildFileMapFromDiskCache(state.currentProjectId, uniqueDevPaths);
    if (!files || files.size === 0) {
      debugLog(DEBUG_IFC_LOAD, '[autoLoad] 磁盘缓存文件 Map 为空，跳过 MOD/STL 加载');
      showProgress({ phase: 'done', collectedDevPaths: uniqueDevPaths.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
      return { modCount: 0, stlCount: 0 };
    }
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] 从磁盘缓存构建了 ${files.size} 个文件`);
  }

  if (!files) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] 跳过：无文件来源（currentFiles=null 且 projectId=null）');
    return { modCount: 0, stlCount: 0 };
  }

  // ── Phase 2: 发现几何源（遍历 DEV → PHM → MOD/STL） ──
  showProgress({ phase: 'discovering', collectedDevPaths: uniqueDevPaths.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });

  const { discoverGeometriesFromNode } = await import('./modGeometryDiscovery.js');

  // 全局去重集合：key = modPath/stlPath
  // 多个 DEV/PHM 链可能引用同一 MOD/STL 文件，去重避免重复加载
  const modMap = new Map<string, DiscoveredModGeometry>(); // modPath → 首次发现记录
  const stlMap = new Map<string, DiscoveredStlGeometry>();  // stlPath → 首次发现记录

  let discoveredCount = 0;
  for (const devPath of uniqueDevPaths) {
    const node = devNodes.get(devPath)!;
    showProgress({
      phase: 'discovering',
      collectedDevPaths: uniqueDevPaths.length,
      discoveredMods: modMap.size,
      discoveredStls: stlMap.size,
      loadedMods: 0,
      loadedStls: 0,
      totalMods: 0,
      totalStls: 0,
      currentPath: devPath,
    });

    try {
      const result = await discoverGeometriesFromNode(node, files);
      for (const modGeo of result.mods) {
        if (!modMap.has(modGeo.modPath)) {
          modMap.set(modGeo.modPath, modGeo);
        }
      }
      for (const stlGeo of result.stls) {
        if (!stlMap.has(stlGeo.stlPath)) {
          stlMap.set(stlGeo.stlPath, stlGeo);
        }
      }
    } catch (err) {
      console.warn(`[autoLoad] DEV 解析失败: ${devPath}`, err);
    }

    discoveredCount++;
    // 每 10 个 devPath yield 一次，避免长时间阻塞 UI
    if (discoveredCount % 10 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const modGeos = Array.from(modMap.values());
  const stlGeos = Array.from(stlMap.values());

  debugLog(DEBUG_IFC_LOAD, `[autoLoad] 发现 ${modGeos.length} 个 MOD + ${stlGeos.length} 个 STL（去重后）`);

  // ── Phase 3: 分批加载 MOD ──
  const { applyExternalTransforms } = await import('../viewer/xmlModLoader.js');
  let loadedMods = 0;

  if (modGeos.length > 0) {
    for (let i = 0; i < modGeos.length; i += CONCURRENCY) {
      const batch = modGeos.slice(i, i + CONCURRENCY);
      showProgress({
        phase: 'loading_mod',
        collectedDevPaths: uniqueDevPaths.length,
        discoveredMods: modGeos.length,
        discoveredStls: stlGeos.length,
        loadedMods,
        loadedStls: 0,
        totalMods: modGeos.length,
        totalStls: stlGeos.length,
        currentPath: batch[0].modPath,
      });

      for (const geo of batch) {
        // 已加载则跳过（state.loadedXmlModGroups 记录去重）
        if (state.loadedXmlModGroups.has(geo.modPath)) {
          loadedMods++;
          continue;
        }

        try {
          const group = await loadModFile(geo, files);
          if (group) {
            applyExternalTransforms(group, geo.devTransformMatrix, geo.phmTransformMatrix);
            scene.add(group);
            state.loadedXmlModGroups.set(geo.modPath, group);
            loadedMods++;
          }
        } catch (err) {
          console.error(`[autoLoad] MOD 加载失败: ${geo.modPath}`, err);
        }
      }

      // 批次间 yield 主线程，防止 UI 冻结
      if (i + CONCURRENCY < modGeos.length) {
        await new Promise((r) => setTimeout(r, YIELD_MS));
      }
    }
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] MOD 加载完成: ${loadedMods}/${modGeos.length}`);
  }

  // ── Phase 4: 分批加载 STL ──
  let loadedStls = 0;

  if (stlGeos.length > 0) {
    for (let i = 0; i < stlGeos.length; i += CONCURRENCY) {
      const batch = stlGeos.slice(i, i + CONCURRENCY);
      showProgress({
        phase: 'loading_stl',
        collectedDevPaths: uniqueDevPaths.length,
        discoveredMods: modGeos.length,
        discoveredStls: stlGeos.length,
        loadedMods,
        loadedStls,
        totalMods: modGeos.length,
        totalStls: stlGeos.length,
        currentPath: batch[0].stlPath,
      });

      for (const geo of batch) {
        // 已加载则跳过
        if (state.loadedStlGroups.has(geo.stlPath)) {
          loadedStls++;
          continue;
        }

        try {
          const group = await loadStlFile(geo, files);
          if (group) {
            applyExternalTransforms(group, geo.devTransformMatrix, geo.phmTransformMatrix);
            scene.add(group);
            state.loadedStlGroups.set(geo.stlPath, group);
            loadedStls++;
          }
        } catch (err) {
          console.error(`[autoLoad] STL 加载失败: ${geo.stlPath}`, err);
        }
      }

      // 批次间 yield
      if (i + CONCURRENCY < stlGeos.length) {
        await new Promise((r) => setTimeout(r, YIELD_MS));
      }
    }
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] STL 加载完成: ${loadedStls}/${stlGeos.length}`);
  }

  // ── Phase 5: 完成 ──
  showProgress({
    phase: 'done',
    collectedDevPaths: uniqueDevPaths.length,
    discoveredMods: modGeos.length,
    discoveredStls: stlGeos.length,
    loadedMods,
    loadedStls,
    totalMods: modGeos.length,
    totalStls: stlGeos.length,
  });

  // 首次自动加载后，若之前未 fit 过相机则尝试 fit
  // （相机 fit 可能已在 IFC 加载阶段执行过，这里做兜底）
  if ((loadedMods > 0 || loadedStls > 0) && !state.hasFittedCamera) {
    try {
      // fitCameraToScene 需要 ViewerContext，这里通过 runtime 获取
      // 但 autoLoad 在 IFC 流程之后调用，runtime 必定已存在
      // 为避免循环依赖，延迟到 IFC 加载流程的 fitCameraToScene 后执行
      // 这里只标记，不实际 fit（fit 由 openGimService 在 autoLoad 完成后统一调用）
    } catch {
      // ignore
    }
  }

  return { modCount: loadedMods, stlCount: loadedStls };
}
