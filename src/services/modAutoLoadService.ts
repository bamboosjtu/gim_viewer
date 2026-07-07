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

import * as THREE from 'three';
import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { DiscoveredModGeometry, DiscoveredStlGeometry } from './modGeometryDiscovery.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { parseDev } from '../gim/geometry/devParser.js';
import { parsePhm } from '../gim/geometry/phmParser.js';
import { applyProjectSourceToViewer } from './coordinateAlignmentService.js';

/** 自动加载选项 */
export interface GeometryAutoLoadOptions {
  /** 调用方 token（用于防竞态：项目切换后递增，后台任务检测不匹配则停止） */
  token?: number;
  /** 是否加载 .mod 文件（默认 true） */
  includeMod?: boolean;
  /** 是否加载 .stl 文件（默认 false，P0 不默认加载 STL） */
  includeStl?: boolean;
}

/** 每批并发加载的文件数 */
const CONCURRENCY = 4;

/** 批次间 yield 间隔（毫秒），让浏览器有机会处理 UI 事件 */
const YIELD_MS = 16;

/** 异常 bbox 阈值（米）：单个 MOD/STL 源任一轴超过此值视为几何异常 */
const BBOX_MAX_DIM_M = 50;

/**
 * 确保 MOD/STL 图层根节点存在（挂在 scene 下，与 IFC 平级）。
 * 首次调用时创建，后续调用返回已有实例。
 */
function ensureGeometryLayers(state: AppState, scene: THREE.Scene): { modRoot: THREE.Group; stlRoot: THREE.Group } {
  if (!state.modRootGroup) {
    state.modRootGroup = new THREE.Group();
    state.modRootGroup.name = '__GIM_MOD_LAYER__';
    state.modRootGroup.visible = true;
    scene.add(state.modRootGroup);
  }
  if (!state.stlRootGroup) {
    state.stlRootGroup = new THREE.Group();
    state.stlRootGroup.name = '__GIM_STL_LAYER__';
    state.stlRootGroup.visible = true;
    scene.add(state.stlRootGroup);
  }
  return { modRoot: state.modRootGroup, stlRoot: state.stlRootGroup };
}

/**
 * 诊断 MOD/STL Group 的 bbox 是否异常。
 *
 * 过滤条件：
 * - 空包围盒（通常是当前尚未支持的 primitive，静默跳过）
 * - 无限/NaN 尺寸
 * - 单轴跨度 > BBOX_MAX_DIM_M（异常矩阵或几何错误导致飘移）
 *
 * @returns true 表示 bbox 正常，可以加入场景
 */
function diagnoseGroupBBox(group: THREE.Group, sourcePath: string): boolean {
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  const empty = box.isEmpty() || maxDim <= 0;
  const bad = !empty && (!Number.isFinite(maxDim) || maxDim > BBOX_MAX_DIM_M);

  if (empty || bad) {
    if (bad) {
      console.warn('[autoLoad] 异常几何 bbox，跳过（不加入场景）:', {
        sourcePath,
        center: box.getCenter(new THREE.Vector3()).toArray(),
        size: size.toArray(),
        maxDim,
        threshold: BBOX_MAX_DIM_M,
      });
    }
    // dispose GPU 资源，避免内存泄漏
    // 方案 B：merged geometry 是 unique 的（每 MOD Group 独立），可以安全 dispose
    // Material 是共享的（_sharedMaterialCache），不可在此处 dispose！
    //   否则会 corrupt 其他使用同一 Material 的 MOD Group
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      // 不 dispose material — 共享资源由 disposeSharedXmlModMaterials 统一释放
    });
  }

  return !(empty || bad);
}

/**
 * 输出 Group 的 bbox 诊断日志（仅 debug 模式）。
 *
 * 用于在应用 projectSourceToViewer 前后对比 MOD/STL 的位置，
 * 辅助估算 sourceToViewer offset。
 *
 * @param stage 'raw' = 应用 projectSourceToViewer 前（GIM 工程坐标）
 *              'transformed' = 应用后（viewer 坐标）
 */
function logGroupBBox(group: THREE.Group, sourcePath: string, stage: 'raw' | 'transformed'): void {
  if (!DEBUG_IFC_LOAD) return;
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) {
    debugLog(DEBUG_IFC_LOAD, `[CoordAlign] ${stage} bbox 为空: ${sourcePath}`);
    return;
  }
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  debugLog(DEBUG_IFC_LOAD, `[CoordAlign] ${stage} bbox: ${sourcePath}`, {
    center: [center.x, center.y, center.z],
    size: [size.x, size.y, size.z],
  });
}

/**
 * MOD Entity.TransformMatrix 表达图元在 MOD 文件内的局部位置；
 * CBM/DEV/SUBDEVICE/PHM 累积矩阵表达该 MOD 实例在工程中的放置位置。
 *
 * 应用顺序：Entity local → placement → projectSourceToViewer。
 */
function prepareModGroupForScene(
  group: THREE.Group,
  sourcePath: string,
  applyPlacementTransform: (group: THREE.Group, transformMatrix: number[] | null | undefined) => void,
  placementTransformMatrix: number[] | null | undefined,
  projectSourceToViewerMatrix: THREE.Matrix4 | null,
): boolean {
  // Entity local transform 已在 loadXmlModFromFiles 中烘焙
  applyPlacementTransform(group, placementTransformMatrix);
  // 输出 raw bbox（应用 projectSourceToViewer 前）
  logGroupBBox(group, sourcePath, 'raw');
  // 应用项目级坐标转换（translation-only MVP）
  applyProjectSourceToViewer(group, projectSourceToViewerMatrix);
  // 输出 transformed bbox（应用后）
  logGroupBBox(group, sourcePath, 'transformed');
  return diagnoseGroupBBox(group, sourcePath);
}

function prepareStlGroupForScene(
  group: THREE.Group,
  sourcePath: string,
  applyPlacementTransform: (group: THREE.Group, transformMatrix: number[] | null | undefined) => void,
  placementTransformMatrix: number[] | null | undefined,
  projectSourceToViewerMatrix: THREE.Matrix4 | null,
): boolean {
  // 顺序：Entity local(无) → 累积装配矩阵 → projectSourceToViewer
  applyPlacementTransform(group, placementTransformMatrix);
  // 输出 raw bbox（应用 projectSourceToViewer 前，已含 DEV/PHM 变换）
  logGroupBBox(group, sourcePath, 'raw');
  // 应用项目级坐标转换
  applyProjectSourceToViewer(group, projectSourceToViewerMatrix);
  // 输出 transformed bbox（应用后）
  logGroupBBox(group, sourcePath, 'transformed');
  return diagnoseGroupBBox(group, sourcePath);
}

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
 * 注意：同一个 devPath 可能挂在多个 CBM 节点下，且父级 CBM transform 不同。
 * 几何发现必须按 CBM 实例处理；仅磁盘读文件阶段才按 devPath 去重。
 */
function collectCbmDeviceInstances(root: CbmNode | null): CbmNode[] {
  const nodes: CbmNode[] = [];

  function walk(node: CbmNode, parentTransform: number[]) {
    const localTransform = parseCbmTransformMatrix(node.transformMatrix);
    const currentTransform = multiplyTransformMatrices(parentTransform, localTransform);

    // DEV_SUBDEVICE 是层级树展示/点击定位用的虚拟节点。
    // 自动全量加载从真实 CBM 设备节点出发即可；discoverGeometriesFromNode
    // 会沿 DEV SUBDEVICES 递归覆盖子设备。若虚拟节点也作为 seed，
    // 同一子 DEV 会被按两条路径发现，重复实例或缺祖先矩阵的实例会污染场景。
    if (node.devPath && node.entityName !== 'DEV_SUBDEVICE') {
      nodes.push({
        ...node,
        transformMatrix: matrixToTransformString(currentTransform),
      });
    }

    for (const child of node.children) {
      walk(child, currentTransform);
    }
  }

  if (root) walk(root, IDENTITY_MATRIX);
  return nodes;
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function parseCbmTransformMatrix(raw: string | undefined): number[] {
  if (!raw) return IDENTITY_MATRIX.slice();
  const values = raw.split(',').map((part) => Number(part.trim()));
  if (values.length !== 16 || values.some((value) => !Number.isFinite(value))) {
    return IDENTITY_MATRIX.slice();
  }
  return values;
}

function multiplyTransformMatrices(a: number[], b: number[]): number[] {
  const am = new THREE.Matrix4().fromArray(a.length === 16 ? a : IDENTITY_MATRIX);
  const bm = new THREE.Matrix4().fromArray(b.length === 16 ? b : IDENTITY_MATRIX);
  return am.multiply(bm).toArray();
}

function matrixToTransformString(matrix: number[]): string {
  return matrix.map((value) => Number.isFinite(value) ? Number(value.toFixed(10)).toString() : '0').join(',');
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

function normalizeDevEntryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.toLowerCase().startsWith('dev/') ? normalized : `DEV/${normalized}`;
}

function normalizePhmEntryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.toLowerCase().startsWith('phm/') ? normalized : `PHM/${normalized}`;
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
 * @returns 包含全部 DEV/PHM/MOD/STL 文件的 Map
 */
async function buildFileMapFromDiskCache(
  projectId: number,
  uniqueDevPaths: string[],
): Promise<Map<string, File> | null> {
  const { batchReadCachedFiles } = await import('../desktop/database.js');
  const result = new Map<string, File>();

  const phmRefs = new Set<string>();
  const devSeen = new Set<string>();
  let pendingDevPaths = uniqueDevPaths.map((dp) => normalizeDevEntryPath(dp));
  let devReadCount = 0;

  while (pendingDevPaths.length > 0) {
    const batch = Array.from(new Set(pendingDevPaths)).filter((path) => !devSeen.has(path));
    pendingDevPaths = [];
    if (batch.length === 0) break;

    for (const path of batch) devSeen.add(path);
    console.log(`[autoLoad] 缓存命中：批量读取 ${batch.length} 个 DEV 文件...`);
    const devBytes = await batchReadCachedFiles(projectId, batch);

    for (const [entryPath, bytes] of devBytes) {
      if (!bytes || bytes.byteLength === 0) continue;
      const file = bytesToFile(bytes, entryPath);
      result.set(entryPath, file);
      devReadCount++;

      try {
        const devText = new TextDecoder().decode(bytes);
        const devDoc = parseDev(devText, entryPath);
        for (const solid of devDoc.solidModels) {
          const solidPath = solid.solidModelPath;
          const lower = solidPath.toLowerCase();
          if (lower.endsWith('.phm')) {
            phmRefs.add(normalizePhmEntryPath(solidPath));
          } else if (lower.endsWith('.dev')) {
            const childDev = normalizeDevEntryPath(solidPath);
            if (!devSeen.has(childDev)) pendingDevPaths.push(childDev);
          }
        }
        for (const sub of devDoc.subDevices) {
          const childDev = normalizeDevEntryPath(sub.devPath);
          if (!devSeen.has(childDev)) pendingDevPaths.push(childDev);
        }
      } catch {
        // 解析失败跳过
      }
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

/** 检查 token 是否仍然有效（防竞态：项目切换后递增 token，旧任务检测不匹配则停止） */
function isTokenValid(state: AppState, token?: number): boolean {
  if (token === undefined) return true;
  return state.geometryLoadToken === token;
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
  options: GeometryAutoLoadOptions = {},
): Promise<{ modCount: number; stlCount: number }> {
  const includeMod = options.includeMod ?? true;
  const includeStl = options.includeStl ?? false;
  const token = options.token;

  let files = state.currentFiles;
  const cbmTree = state.currentCbmTree;

  // 早期 token 校验：项目已切换则立即退出
  if (!isTokenValid(state, token)) {
    console.log('[autoLoad] token 不匹配，停止加载（项目已切换）');
    return { modCount: 0, stlCount: 0 };
  }

  if (!cbmTree) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] 跳过：currentCbmTree 为空');
    return { modCount: 0, stlCount: 0 };
  }

  // ── Phase 1: 收集 devPath ──
  showProgress({ phase: 'collecting', collectedDevPaths: 0, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
  const deviceNodes = collectCbmDeviceInstances(cbmTree);
  const uniqueDevPaths = Array.from(new Set(deviceNodes.map((node) => node.devPath).filter((path): path is string => !!path)));

  debugLog(DEBUG_IFC_LOAD, `[autoLoad] 收集到 ${deviceNodes.length} 个 CBM 设备实例，${uniqueDevPaths.length} 个唯一 devPath`);

  if (deviceNodes.length === 0) {
    showProgress({ phase: 'done', collectedDevPaths: 0, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
    return { modCount: 0, stlCount: 0 };
  }

  // ── Phase 1.5: 缓存命中场景 → SQLite 查询 + 仅批量读 MOD/STL ──
  // 设计动机：demo-substation 有 4179 个 DEV → 3921 个无 SOLIDMODEL，
  // 逐文件读取是巨大浪费。SQLite 已索引引用链，一次查询即可得到全部 MOD/STL 路径。
  const isCacheHit = !files;
  if (isCacheHit && state.currentProjectId != null) {
    console.log(`[autoLoad] SQLite 查询可到达几何: includeMod=${includeMod} includeStl=${includeStl}`);
    try {
      const { getReachableGeometry, batchReadCachedFiles } = await import('../desktop/database.js');
      const reachable = await getReachableGeometry(state.currentProjectId, { includeMod, includeStl });

      if (reachable.length === 0) {
        console.log('[autoLoad] 无可到达的 MOD/STL 几何源（SQLite 查询为空）');
        showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
        return { modCount: 0, stlCount: 0 };
      }

      // 分离 MOD / STL 并收集唯一路径
      const modPaths = new Set<string>();
      const stlPaths = new Set<string>();
      for (const r of reachable) {
        const lower = r.geometry_path.toLowerCase();
        if (lower.endsWith('.mod')) modPaths.add(r.geometry_path);
        else if (lower.endsWith('.stl')) stlPaths.add(r.geometry_path);
      }

      const logExtras: string[] = [`${modPaths.size} MOD`];
      if (includeStl) logExtras.push(`${stlPaths.size} STL`);
      console.log(`[autoLoad] SQLite 查询完成: ${reachable.length} 个几何源 → ${logExtras.join(' + ')}`);

      // 批量读取 MOD 文件（1 次 IPC）
      const modArr = Array.from(modPaths);
      if (modArr.length > 0) {
        console.log(`[autoLoad] 批量读取 ${modArr.length} 个 MOD 文件（1 次 IPC）...`);
        const modBytes = await batchReadCachedFiles(state.currentProjectId, modArr);
        files = new Map(); // 复用 files 变量，仅含 MOD
        for (const [path, bytes] of modBytes) {
          if (bytes && bytes.byteLength > 0) {
            files.set(path, bytesToFile(bytes, path));
          }
        }
      }

      // 批量读取 STL 文件（1 次 IPC）
      const stlArr = Array.from(stlPaths);
      if (stlArr.length > 0) {
        console.log(`[autoLoad] 批量读取 ${stlArr.length} 个 STL 文件（1 次 IPC）...`);
        const stlBytes = await batchReadCachedFiles(state.currentProjectId, stlArr);
        if (!files) files = new Map();
        for (const [path, bytes] of stlBytes) {
          if (bytes && bytes.byteLength > 0) {
            files.set(path, bytesToFile(bytes, path));
          }
        }
      }

      if (!files || files.size === 0) {
        console.log('[autoLoad] 无有效 MOD/STL 文件（磁盘缓存可能缺失），跳过加载');
        showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
        return { modCount: 0, stlCount: 0 };
      }

      console.log(`[autoLoad] 从磁盘读取了 ${files.size} 个 MOD/STL 文件（${isCacheHit ? '缓存命中' : '首次打开'}）`);

      // 缓存命中时跳过 Phase 2 的 DEV→PHM→MOD 发现循环，
      // 直接用 SQLite 返回的结果加载几何
      const modGeos: DiscoveredModGeometry[] = [];
      const stlGeos: DiscoveredStlGeometry[] = [];

      for (const r of reachable) {
        const lower = r.geometry_path.toLowerCase();
        const devTM = r.dev_transform_matrix
          ? r.dev_transform_matrix.split(',').map(Number)
          : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const phmTM = r.phm_transform_matrix
          ? r.phm_transform_matrix.split(',').map(Number)
          : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

        if (lower.endsWith('.mod')) {
          const placementTM = r.placement_transform_matrix
            ? r.placement_transform_matrix.split(',').map(Number)
            : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
          modGeos.push({
            modPath: r.geometry_path,
            instanceKey: r.instance_key,
            placementTransformMatrix: placementTM,
            devTransformMatrix: devTM,
            phmTransformMatrix: phmTM,
            devPath: '',
            phmPath: '',
          });
        } else if (lower.endsWith('.stl')) {
          const placementTM = r.placement_transform_matrix
            ? r.placement_transform_matrix.split(',').map(Number)
            : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
          stlGeos.push({
            stlPath: r.geometry_path,
            instanceKey: r.instance_key,
            placementTransformMatrix: placementTM,
            devTransformMatrix: devTM,
            phmTransformMatrix: phmTM,
            devPath: '',
            phmPath: '',
          });
        }
      }

      // 跳过 Phase 2，直接进入加载阶段
      console.log(`[autoLoad] DB 直通加载: ${modGeos.length} MOD + ${stlGeos.length} STL`);

      const { applyPlacementTransformToSceneUnits } = await import('../viewer/xmlModLoader.js');
      const { modRoot, stlRoot } = ensureGeometryLayers(state, scene);
      let loadedMods = 0;
      let loadedStls = 0;
      let skippedBadBBox = 0;

      // 加载 MOD
      if (modGeos.length > 0) {
        console.log(`[autoLoad] 开始加载 ${modGeos.length} 个 MOD...`);
        for (let i = 0; i < modGeos.length; i += CONCURRENCY) {
          if (!isTokenValid(state, token)) { console.log('[autoLoad] token 不匹配，停止 DB MOD 加载'); return { modCount: loadedMods, stlCount: 0 }; }
          const batch = modGeos.slice(i, i + CONCURRENCY);
          showProgress({ phase: 'loading_mod', collectedDevPaths: deviceNodes.length, discoveredMods: modGeos.length, discoveredStls: stlGeos.length, loadedMods, loadedStls, totalMods: modGeos.length, totalStls: stlGeos.length, currentPath: batch[0].modPath });
          for (const geo of batch) {
            if (state.loadedXmlModGroups.has(geo.instanceKey)) { loadedMods++; continue; }
            try {
              const group = await loadModFile(geo, files!);
              if (group) {
                if (!prepareModGroupForScene(group, geo.modPath, applyPlacementTransformToSceneUnits, geo.placementTransformMatrix, state.projectSourceToViewerMatrix)) { skippedBadBBox++; loadedMods++; continue; }
                modRoot.add(group);
                state.loadedXmlModGroups.set(geo.instanceKey, group);
                loadedMods++;
              } else {
                // MOD 解析失败（loadModFile 返回 null），也算已处理
                loadedMods++;
              }
            } catch (err) {
              console.error(`[autoLoad] MOD 加载失败: ${geo.modPath}`, err);
              loadedMods++;
            }
          }
          if (i + CONCURRENCY < modGeos.length) await new Promise((r) => setTimeout(r, YIELD_MS));
        }
        console.log(`[autoLoad] MOD 加载完成: ${loadedMods}/${modGeos.length}（跳过异常 bbox: ${skippedBadBBox}）`);
      }

      // 加载 STL（仅 includeStl=true 时进入，stlGeos 已在 discovery 阶段过滤）
      if (stlGeos.length > 0) {
        console.log(`[autoLoad] 开始加载 ${stlGeos.length} 个 STL...`);
        for (let i = 0; i < stlGeos.length; i += CONCURRENCY) {
          if (!isTokenValid(state, token)) { console.log('[autoLoad] token 不匹配，停止 DB STL 加载'); return { modCount: loadedMods, stlCount: loadedStls }; }
          const batch = stlGeos.slice(i, i + CONCURRENCY);
          showProgress({ phase: 'loading_stl', collectedDevPaths: deviceNodes.length, discoveredMods: modGeos.length, discoveredStls: stlGeos.length, loadedMods, loadedStls, totalMods: modGeos.length, totalStls: stlGeos.length, currentPath: batch[0].stlPath });
          for (const geo of batch) {
            if (state.loadedStlGroups.has(geo.instanceKey)) { loadedStls++; continue; }
            try {
              const group = await loadStlFile(geo, files!);
              if (group) {
                if (!prepareStlGroupForScene(group, geo.stlPath, applyPlacementTransformToSceneUnits, geo.placementTransformMatrix, state.projectSourceToViewerMatrix)) { skippedBadBBox++; loadedStls++; continue; }
                stlRoot.add(group);
                state.loadedStlGroups.set(geo.instanceKey, group);
                loadedStls++;
              } else {
                loadedStls++;
              }
            } catch (err) {
              console.error(`[autoLoad] STL 加载失败: ${geo.stlPath}`, err);
              loadedStls++;
            }
          }
          if (i + CONCURRENCY < stlGeos.length) await new Promise((r) => setTimeout(r, YIELD_MS));
        }
        console.log(`[autoLoad] STL 加载完成: ${loadedStls}/${stlGeos.length}`);
      }

      console.log(`[autoLoad] 全部几何加载完成 (DB直通): MOD=${loadedMods}, STL=${loadedStls}, 跳过异常bbox=${skippedBadBBox}`);
      showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: modGeos.length, discoveredStls: stlGeos.length, loadedMods, loadedStls, totalMods: modGeos.length, totalStls: stlGeos.length });
      return { modCount: loadedMods, stlCount: loadedStls };
    } catch (err) {
      console.warn('[autoLoad] SQLite 几何查询失败，回退到文件扫描:', err);
      // 回退：尝试 buildFileMapFromDiskCache（已有进度日志）
      files = await buildFileMapFromDiskCache(state.currentProjectId, uniqueDevPaths);
      if (!files || files.size === 0) {
        showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
        return { modCount: 0, stlCount: 0 };
      }
    }
  }

  if (!files) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] 跳过：无文件来源（currentFiles=null 且 projectId=null）');
    return { modCount: 0, stlCount: 0 };
  }

  // ── Phase 2: 发现几何源（遍历 CBM 实例 → DEV → PHM → MOD/STL） ──
  // 注意：deviceNodes 可能很大（数千），必须节流 showProgress + 频繁 yield
  showProgress({ phase: 'discovering', collectedDevPaths: deviceNodes.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });

  const { discoverGeometriesFromNode } = await import('./modGeometryDiscovery.js');

  // 全局去重集合：key = instanceKey。同一 MOD/STL 文件可有多个 placement 实例。
  const modMap = new Map<string, DiscoveredModGeometry>();
  const stlMap = new Map<string, DiscoveredStlGeometry>();

  console.log(`[autoLoad] 开始发现几何源（${deviceNodes.length} 个 CBM 设备实例）...`);

  let discoveredCount = 0;
  const PROGRESS_INTERVAL = 50;  // 每 50 个 CBM 设备实例更新一次进度 UI
  const YIELD_INTERVAL = 5;      // 每 5 个 CBM 设备实例 yield 主线程
  const LOG_INTERVAL = 100;      // 每 100 个 CBM 设备实例输出 console.log

  for (const node of deviceNodes) {
    const devPath = node.devPath || '';

    // 节流：不要每轮都更新 DOM（showProgress → showLoading → textContent）
    if (discoveredCount % PROGRESS_INTERVAL === 0) {
      showProgress({
        phase: 'discovering',
        collectedDevPaths: deviceNodes.length,
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
      console.log(`[autoLoad] 发现进度: ${discoveredCount}/${deviceNodes.length} CBM instances, MOD=${modMap.size}, STL=${stlMap.size}`);
      // 批次间检查 token，项目切换时提前退出
      if (!isTokenValid(state, token)) {
        console.log('[autoLoad] token 不匹配，停止发现（项目已切换）');
        return { modCount: 0, stlCount: 0 };
      }
    }

    try {
      const result = await discoverGeometriesFromNode(node, files);
      for (const modGeo of result.mods) {
        if (!modMap.has(modGeo.instanceKey)) {
          modMap.set(modGeo.instanceKey, modGeo);
        }
      }
      if (includeStl) {
        for (const stlGeo of result.stls) {
          if (!stlMap.has(stlGeo.instanceKey)) {
            stlMap.set(stlGeo.instanceKey, stlGeo);
          }
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

  console.log(`[autoLoad] 发现完成: ${modGeos.length} 个 MOD + ${stlGeos.length} 个 STL（实例去重后，共扫描 ${discoveredCount} 个 CBM 实例）`);
  debugLog(DEBUG_IFC_LOAD, `[autoLoad] 发现 ${modGeos.length} 个 MOD + ${stlGeos.length} 个 STL（实例去重后）`);

  // ── Phase 3: 分批加载 MOD ──
  const { applyPlacementTransformToSceneUnits } = await import('../viewer/xmlModLoader.js');
  const { modRoot, stlRoot } = ensureGeometryLayers(state, scene);
  let loadedMods = 0;
  let skippedBadBBox = 0;

  if (modGeos.length > 0) {
    console.log(`[autoLoad] 开始加载 ${modGeos.length} 个 MOD 文件...`);
    for (let i = 0; i < modGeos.length; i += CONCURRENCY) {
      const batch = modGeos.slice(i, i + CONCURRENCY);
      showProgress({
        phase: 'loading_mod',
        collectedDevPaths: deviceNodes.length,
        discoveredMods: modGeos.length,
        discoveredStls: stlGeos.length,
        loadedMods,
        loadedStls: 0,
        totalMods: modGeos.length,
        totalStls: stlGeos.length,
        currentPath: batch[0].modPath,
      });

      // 每批前检查 token
      if (!isTokenValid(state, token)) {
        console.log('[autoLoad] token 不匹配，停止 MOD 加载');
        return { modCount: loadedMods, stlCount: 0 };
      }

      for (const geo of batch) {
        if (state.loadedXmlModGroups.has(geo.instanceKey)) { loadedMods++; continue; }

        try {
          const group = await loadModFile(geo, files);
          if (group) {
            if (!prepareModGroupForScene(group, geo.modPath, applyPlacementTransformToSceneUnits, geo.placementTransformMatrix, state.projectSourceToViewerMatrix)) { skippedBadBBox++; loadedMods++; continue; }
            modRoot.add(group);
            state.loadedXmlModGroups.set(geo.instanceKey, group);
            loadedMods++;
          } else {
            loadedMods++;
          }
        } catch (err) {
          console.error(`[autoLoad] MOD 加载失败: ${geo.modPath}`, err);
          loadedMods++;
        }
      }

      if (i + CONCURRENCY < modGeos.length) {
        await new Promise((r) => setTimeout(r, YIELD_MS));
      }
    }
    console.log(`[autoLoad] MOD 加载完成: ${loadedMods}/${modGeos.length}（跳过异常 bbox: ${skippedBadBBox}）`);
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
        collectedDevPaths: deviceNodes.length,
        discoveredMods: modGeos.length,
        discoveredStls: stlGeos.length,
        loadedMods,
        loadedStls,
        totalMods: modGeos.length,
        totalStls: stlGeos.length,
        currentPath: batch[0].stlPath,
      });

      // 每批前检查 token
      if (!isTokenValid(state, token)) {
        console.log('[autoLoad] token 不匹配，停止 STL 加载');
        return { modCount: loadedMods, stlCount: loadedStls };
      }

      for (const geo of batch) {
        if (state.loadedStlGroups.has(geo.instanceKey)) { loadedStls++; continue; }

        try {
          const group = await loadStlFile(geo, files);
          if (group) {
            if (!prepareStlGroupForScene(group, geo.stlPath, applyPlacementTransformToSceneUnits, geo.placementTransformMatrix, state.projectSourceToViewerMatrix)) { skippedBadBBox++; loadedStls++; continue; }
            stlRoot.add(group);
            state.loadedStlGroups.set(geo.instanceKey, group);
            loadedStls++;
          } else {
            loadedStls++;
          }
        } catch (err) {
          console.error(`[autoLoad] STL 加载失败: ${geo.stlPath}`, err);
          loadedStls++;
        }
      }

      if (i + CONCURRENCY < stlGeos.length) {
        await new Promise((r) => setTimeout(r, YIELD_MS));
      }
    }
    console.log(`[autoLoad] STL 加载完成: ${loadedStls}/${stlGeos.length}`);
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] STL 加载完成: ${loadedStls}/${stlGeos.length}`);
  }

  // ── Phase 5: 完成 ──
  console.log(`[autoLoad] 全部几何加载完成: MOD=${loadedMods}, STL=${loadedStls}, 跳过异常bbox=${skippedBadBBox}`);
  showProgress({
    phase: 'done',
    collectedDevPaths: deviceNodes.length,
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
