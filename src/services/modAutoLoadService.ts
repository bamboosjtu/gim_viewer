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
 *
 * 设计决策：收集所有有 devPath 的节点，不论是否有 IFC。
 * 原因：IFC 可能不包含该设备的完整几何（或 GUID 不匹配），
 * MOD/STL 作为补充/回退几何源。仅依赖 IFC 会导致变压器等
 * 关键设备缺失显示。
 *
 * 性能：devPath 去重（相同 DEV 文件只处理一次）。
 */
function collectUniqueDevPaths(root: CbmNode | null): Map<string, CbmNode> {
  const devNodes = new Map<string, CbmNode>(); // devPath → 代表节点

  function walk(node: CbmNode) {
    // 收集所有有 devPath 的节点，不论是否有 IFC
    if (node.devPath && !devNodes.has(node.devPath)) {
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
  const { batchReadCachedFiles } = await import('../desktop/database.js');
  const result = new Map<string, File>();

  // ── 第一步：批量读取所有 DEV 文件（1 次 IPC） ──
  const devEntryPaths = uniqueDevPaths.map((dp) => `DEV/${dp}`);
  console.log(`[autoLoad] 缓存命中：批量读取 ${devEntryPaths.length} 个 DEV 文件（1 次 IPC）...`);
  const devBytes = await batchReadCachedFiles(projectId, devEntryPaths);

  const phmRefs = new Set<string>();
  let devReadCount = 0;
  for (const [entryPath, bytes] of devBytes) {
    if (!bytes || bytes.byteLength === 0) continue;
    const file = bytesToFile(bytes, entryPath);
    result.set(entryPath, file);
    devReadCount++;

    // 解析 DEV 收集 PHM 引用
    try {
      const devText = new TextDecoder().decode(bytes);
      const devDoc = parseDev(devText, entryPath);
      for (const solid of devDoc.solidModels) {
        const phmName = solid.solidModelPath;
        if (phmName.toLowerCase().endsWith('.phm')) {
          phmRefs.add(`PHM/${phmName}`);
        }
      }
    } catch {
      // 解析失败跳过
    }
  }
  console.log(`[autoLoad] DEV 批量读取完成: ${devReadCount} 个有效，发现 ${phmRefs.size} 个 PHM 引用`);

  // ── 第二步：批量读取 PHM 文件（1 次 IPC） ──
  const modStlRefs = new Set<string>();
  const phmArr = Array.from(phmRefs);
  if (phmArr.length > 0) {
    console.log(`[autoLoad] 批量读取 ${phmArr.length} 个 PHM 文件（1 次 IPC）...`);
    const phmBytes = await batchReadCachedFiles(projectId, phmArr);

    let phmReadCount = 0;
    for (const [phmPath, bytes] of phmBytes) {
      if (!bytes || bytes.byteLength === 0) continue;
      const file = bytesToFile(bytes, phmPath);
      result.set(phmPath, file);
      phmReadCount++;

      // 解析 PHM 收集 MOD/STL 引用
      try {
        const phmText = new TextDecoder().decode(bytes);
        const phmDoc = parsePhm(phmText, phmPath);
        for (const solid of phmDoc.solidModels) {
          modStlRefs.add(`MOD/${solid.solidModelPath}`);
        }
      } catch {
        // 解析失败跳过
      }
    }
    console.log(`[autoLoad] PHM 批量读取完成: ${phmReadCount} 个，发现 ${modStlRefs.size} 个 MOD/STL 引用`);
  }

  // ── 第三步：批量读取 MOD/STL 文件（1 次 IPC） ──
  const modStlArr = Array.from(modStlRefs);
  if (modStlArr.length > 0) {
    console.log(`[autoLoad] 批量读取 ${modStlArr.length} 个 MOD/STL 文件（1 次 IPC）...`);
    const msBytes = await batchReadCachedFiles(projectId, modStlArr);

    let msReadCount = 0;
    for (const [msPath, bytes] of msBytes) {
      if (!bytes || bytes.byteLength === 0) continue;
      result.set(msPath, bytesToFile(bytes, msPath));
      msReadCount++;
    }
    console.log(`[autoLoad] MOD/STL 批量读取完成: ${msReadCount} 个`);
  }

  console.log(`[autoLoad] 磁盘缓存 Map 构建完成: ${result.size} 个文件（共 3 次 IPC）`);
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
  // 注意：uniqueDevPaths 可能很大（数千），必须节流 showProgress + 频繁 yield
  showProgress({ phase: 'discovering', collectedDevPaths: uniqueDevPaths.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });

  const { discoverGeometriesFromNode } = await import('./modGeometryDiscovery.js');

  // 全局去重集合：key = modPath/stlPath
  const modMap = new Map<string, DiscoveredModGeometry>();
  const stlMap = new Map<string, DiscoveredStlGeometry>();

  console.log(`[autoLoad] 开始发现几何源（${uniqueDevPaths.length} 个 devPath）...`);

  let discoveredCount = 0;
  const PROGRESS_INTERVAL = 50;  // 每 50 个 devPath 更新一次进度 UI
  const YIELD_INTERVAL = 5;      // 每 5 个 devPath yield 主线程
  const LOG_INTERVAL = 100;      // 每 100 个 devPath 输出 console.log

  for (const devPath of uniqueDevPaths) {
    const node = devNodes.get(devPath)!;

    // 节流：不要每轮都更新 DOM（showProgress → showLoading → textContent）
    if (discoveredCount % PROGRESS_INTERVAL === 0) {
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
    }

    // 里程碑日志：让用户知道发现正在推进
    if (discoveredCount > 0 && discoveredCount % LOG_INTERVAL === 0) {
      console.log(`[autoLoad] 发现进度: ${discoveredCount}/${uniqueDevPaths.length} devPaths, MOD=${modMap.size}, STL=${stlMap.size}`);
    }

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

    // 频繁 yield 主线程，确保 UI 不卡死
    if (discoveredCount % YIELD_INTERVAL === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const modGeos = Array.from(modMap.values());
  const stlGeos = Array.from(stlMap.values());

  console.log(`[autoLoad] 发现完成: ${modGeos.length} 个 MOD + ${stlGeos.length} 个 STL（去重后，共扫描 ${discoveredCount} 个 devPath）`);
  debugLog(DEBUG_IFC_LOAD, `[autoLoad] 发现 ${modGeos.length} 个 MOD + ${stlGeos.length} 个 STL（去重后）`);

  // ── Phase 3: 分批加载 MOD ──
  const { applyExternalTransforms } = await import('../viewer/xmlModLoader.js');
  let loadedMods = 0;

  if (modGeos.length > 0) {
    console.log(`[autoLoad] 开始加载 ${modGeos.length} 个 MOD 文件...`);
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
    console.log(`[autoLoad] MOD 加载完成: ${loadedMods}/${modGeos.length}`);
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] MOD 加载完成: ${loadedMods}/${modGeos.length}`);
  }

  // ── Phase 4: 分批加载 STL ──
  let loadedStls = 0;

  if (stlGeos.length > 0) {
    console.log(`[autoLoad] 开始加载 ${stlGeos.length} 个 STL 文件...`);
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
    console.log(`[autoLoad] STL 加载完成: ${loadedStls}/${stlGeos.length}`);
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] STL 加载完成: ${loadedStls}/${stlGeos.length}`);
  }

  // ── Phase 5: 完成 ──
  console.log(`[autoLoad] 全部几何加载完成: MOD=${loadedMods}, STL=${loadedStls}`);
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
