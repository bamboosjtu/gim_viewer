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
import type { XmlModColor } from '../gim/geometry/ir.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { GeometryCacheManifest, GeometryCacheManifestEntry } from '@desktop/database.js';
import type { DiscoveredModGeometry, DiscoveredStlGeometry } from './modGeometryDiscovery.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { parseDev } from '../gim/geometry/devParser.js';
import { parsePhm } from '../gim/geometry/phmParser.js';
import { applyProjectSourceToViewer } from './coordinateAlignmentService.js';
import { PARSER_LIMITS } from '../gim/parserLimits.js';
import { getFileByPath } from '../gim/fileLookup.js';

/** 自动加载选项 */
export interface GeometryAutoLoadOptions {
  /** 调用方 token（用于防竞态：项目切换后递增，后台任务检测不匹配则停止） */
  token?: number;
  /** 工程加载代次（与 token 配合，防止同一 token 被错误复用）。 */
  generation?: number;
  /** 捕获的 project_id；未提供时使用调用瞬间的 state.currentProjectId。 */
  projectId?: number | null;
  /** 捕获的源 GIM SHA-256；防止同一 project_id 的旧任务跨源写入场景。 */
  sourceSha256?: string | null;
  /** 可直接复用的不可变工程会话快照。 */
  session?: ProjectLoadSession;
  /** 是否加载 .mod 文件（默认 true） */
  includeMod?: boolean;
  /** 是否加载 .stl 文件（默认 false，P0 不默认加载 STL） */
  includeStl?: boolean;
}

/** 每批并发加载的文件数 */
const CONCURRENCY = 4;

/** 批次间 yield 间隔（毫秒），让浏览器有机会处理 UI 事件 */
const YIELD_MS = 16;

/**
 * 异常 bbox 尺寸阈值（米）。
 *
 * DEV 粒度合并几何可合法包含全站系统（电缆沟/消防管网等，跨度 100m+），
 * 阈值需覆盖站点尺度（500m 覆盖特大型变电站）；
 * 单位错误类损坏（mm/m 混淆）通常为 km 级，仍可拦截。
 */
const BBOX_MAX_DIM_M = 500;

/**
 * 异常 bbox 位置阈值（米）：bbox 中心距原点超过此值视为平移失控。
 *
 * 尺寸检查拦截不了"几何正常但被错误平移到远处"的情况
 * （如放置矩阵 mm/m 混淆把设备平移到 100km 外）；
 * 场景经 projectSourceToViewer 对齐后正常几何中心应在站点尺度（≤1km）内。
 */
const BBOX_MAX_CENTER_M = 5000;

/**
 * 确保 MOD/STL 图层根节点存在（挂在 scene 下，与 IFC 平级）。
 * 首次调用时创建，后续调用返回已有实例。
 */
export function ensureGeometryLayers(state: AppState, scene: THREE.Scene): { modRoot: THREE.Group; stlRoot: THREE.Group } {
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
 * - 单轴跨度 > BBOX_MAX_DIM_M（单位错误类几何损坏，km 级）
 * - bbox 中心距原点 > BBOX_MAX_CENTER_M（平移失控，如放置矩阵 mm/m 混淆）
 *
 * @returns true 表示 bbox 正常，可以加入场景
 */
export function diagnoseGroupBBox(group: THREE.Group, sourcePath: string): boolean {
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const center = box.getCenter(new THREE.Vector3());
  const centerDist = center.length();

  const empty = box.isEmpty() || maxDim <= 0;
  const bad =
    !empty &&
    (!Number.isFinite(maxDim) ||
      maxDim > BBOX_MAX_DIM_M ||
      !Number.isFinite(centerDist) ||
      centerDist > BBOX_MAX_CENTER_M);

  if (empty || bad) {
    if (bad) {
      console.warn('[autoLoad] 异常几何 bbox，跳过（不加入场景）:', {
        sourcePath,
        center: center.toArray(),
        size: size.toArray(),
        maxDim,
        centerDist,
        thresholds: { maxDim: BBOX_MAX_DIM_M, center: BBOX_MAX_CENTER_M },
      });
    }
    // dispose GPU 资源，避免内存泄漏
    // 方案 B：merged geometry 是 unique 的（每 MOD Group 独立），可以安全 dispose
    // Material 是共享的（_sharedMaterialCache），不可在此处 dispose！
    //   否则会 corrupt 其他使用同一 Material 的 MOD Group
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        if ((material.userData as Record<string, unknown> | undefined)?.__gimOwnedInstanceMaterial === true) {
          material.dispose();
        }
      }
      // 共享 XML MOD 材质由 disposeSharedXmlModMaterials 统一释放
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
  /** 快速缓存阶段已检查的 DEV 任务数；用于区分“已处理”和“成功渲染”。 */
  processedMods?: number;
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
/**
 * 判断 CBM 节点能否作为全量几何发现的起点。
 *
 * demo-substation 的 PARTINDEX 是 F4 根 DEV 的 SUBDEVICE 在 CBM 中的
 * 语义别名：二者指向同一个 child DEV，但 PARTINDEX 本身没有
 * SUBDEVICE 的局部矩阵。根 DEV 的递归发现已经会用正确矩阵覆盖它。
 * 若 PARTINDEX 再作为独立 seed，会把同一部件以缺失局部矩阵的位置再渲染一次。
 */
export function isGeometryAutoLoadSeed(node: CbmNode): boolean {
  return !!node.devPath
    && node.entityName !== 'DEV_SUBDEVICE'
    && node.entityName !== 'PARTINDEX';
}

export function collectCbmDeviceInstances(root: CbmNode | null): CbmNode[] {
  const nodes: CbmNode[] = [];

  function walk(node: CbmNode, parentTransform: number[]) {
    const localTransform = parseCbmTransformMatrix(node.transformMatrix);
    const currentTransform = multiplyTransformMatrices(parentTransform, localTransform);

    // 自动全量加载仅从真正的设备根节点出发。DEV_SUBDEVICE 与 PARTINDEX
    // 都是 child DEV 的树节点/语义别名；discoverGeometriesFromNode 会沿
    // 根 DEV 的 SUBDEVICES 递归，并携带唯一正确的局部装配矩阵。
    if (isGeometryAutoLoadSeed(node)) {
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

export function parseCbmTransformMatrix(raw: string | undefined): number[] {
  if (!raw) return IDENTITY_MATRIX.slice();
  const values = raw.split(',').map((part) => Number(part.trim()));
  if (values.length !== 16 || values.some((value) => !Number.isFinite(value))) {
    return IDENTITY_MATRIX.slice();
  }
  return values;
}

function parseCachedPhmColor(raw: string | null | undefined): XmlModColor | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((part) => Number(part.trim()));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return undefined;
  const [r, g, b, a] = values;
  if ([r, g, b].some((value) => value < 0 || value > 255) || a < 0 || a > 255) return undefined;
  return { r, g, b, a };
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
  return loadXmlModFromFiles(geo.modPath, files, geo.phmColor, geo.phmColorMaxA);
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
  const { batchReadCachedFiles } = await import('@desktop/database.js');
  const result = new Map<string, File>();

  const phmRefs = new Set<string>();
  const devSeen = new Set<string>();
  let pendingDevPaths = uniqueDevPaths.map((dp) => normalizeDevEntryPath(dp));
  let devReadCount = 0;
  let traversalCount = 0;

  while (pendingDevPaths.length > 0) {
    traversalCount += pendingDevPaths.length;
    if (traversalCount > PARSER_LIMITS.maxGeometryQueue) {
      throw new Error(`缓存 DEV 引用队列超过安全上限 ${PARSER_LIMITS.maxGeometryQueue}`);
    }
    const batch = Array.from(new Set(pendingDevPaths)).filter((path) => !devSeen.has(path));
    pendingDevPaths = [];
    if (batch.length === 0) break;

    for (const path of batch) devSeen.add(path);
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] 缓存命中：批量读取 ${batch.length} 个 DEV 文件...`);
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
    if (devSeen.size > PARSER_LIMITS.maxGeometryQueue) {
      throw new Error(`缓存 DEV 实例数超过安全上限 ${PARSER_LIMITS.maxGeometryQueue}`);
    }
  }
  debugLog(DEBUG_IFC_LOAD, `[autoLoad] DEV 批量读取完成: ${devReadCount} 个有效，发现 ${phmRefs.size} 个 PHM 引用`);

  // ── 第二步：批量读取 PHM 文件（1 次 IPC） ──
  const modStlRefs = new Set<string>();
  const phmArr = Array.from(phmRefs);
  if (phmArr.length > 0) {
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] 批量读取 ${phmArr.length} 个 PHM 文件（1 次 IPC）...`);
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
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] PHM 批量读取完成: ${phmReadCount} 个，发现 ${modStlRefs.size} 个 MOD/STL 引用`);
  }

  // ── 第三步：批量读取 MOD/STL 文件（1 次 IPC） ──
  const modStlArr = Array.from(modStlRefs);
  if (modStlArr.length > 0) {
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] 批量读取 ${modStlArr.length} 个 MOD/STL 文件（1 次 IPC）...`);
    const msBytes = await batchReadCachedFiles(projectId, modStlArr);

    let msReadCount = 0;
    for (const [msPath, bytes] of msBytes) {
      if (!bytes || bytes.byteLength === 0) continue;
      result.set(msPath, bytesToFile(bytes, msPath));
      msReadCount++;
    }
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] MOD/STL 批量读取完成: ${msReadCount} 个`);
  }

  debugLog(DEBUG_IFC_LOAD, `[autoLoad] 磁盘缓存 Map 构建完成: ${result.size} 个文件（共 3 次 IPC）`);
  return result.size > 0 ? result : null;
}

/** 检查 token 是否仍然有效（防竞态：项目切换后递增 token，旧任务检测不匹配则停止） */
export function isGeometryTokenValid(state: AppState, token?: number): boolean {
  if (token === undefined) return true;
  return state.geometryLoadToken === token;
}

function isGeometryContextValid(
  state: AppState,
  token: number | undefined,
  generation: number | undefined,
  projectId: number | null | undefined,
  sourceSha256?: string | null,
): boolean {
  if (!isGeometryTokenValid(state, token)) return false;
  if (generation !== undefined && state.projectGeneration !== generation) return false;
  if (projectId !== undefined && state.currentProjectId !== projectId) return false;
  if (sourceSha256 !== undefined && state.currentSourceSha256 !== sourceSha256) return false;
  return true;
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

/**
 * 方案 C v3：DEV 粒度 GLB 快速路径。
 *
 * 先按 unique DEV 校验 manifest，再以二进制批次读取 GLB；同一 DEV 的 bytes
 * 只读一次，但每个 CBM placement 仍独立调用 loadDevGlb（当前 placement 会
 * 修改 BufferGeometry，暂不共享 Three geometry）。
 *
 * 数学等价性：两次 applyPlacementTransformToSceneUnits（各 ×0.001）
 * 等价于一次完整应用（CBM × DEV × PHM，×0.001），详见 18c §10.4。
 *
 * @returns loaded=true 表示 manifest 覆盖完整且所有 placement 已加载；
 * loaded=false 表示应整体回退到原始 MOD 粒度。
 */
export interface DevGlbFastPathProfile {
  cbmInstanceCount: number;
  uniqueDevCount: number;
  glbDevCount: number;
  emptyDevCount: number;
  glbBatchReadMs: number;
  glbReadBytes: number;
  glbParseCount: number;
  glbParseMs: number;
  /** 1 表示本次 fast path 不可用并触发原始 MOD fallback，成功时为 0。 */
  rawModFallbackCount: number;
  fallbackReason?: string;
}

export interface DevGlbFastPathResult {
  loaded: boolean;
  modCount: number;
  stlCount: number;
  profile: DevGlbFastPathProfile;
}

interface DevGlbFastPathDependencies {
  loadDevGlb: (devPath: string, bytes: Uint8Array) => Promise<THREE.Group | null>;
  applyPlacementTransformToSceneUnits: (group: THREE.Group, transformMatrix: number[] | null | undefined) => void;
  /** v3：仅读取 manifest 描述；缺省时由 bridge 动态提供。 */
  readGeometryCacheManifest?: (projectId: number) => Promise<GeometryCacheManifest>;
  /** v3：GIMR 二进制 envelope 批读；缺省时由 bridge 动态提供。 */
  batchReadGlbFiles?: (projectId: number, entryPaths: string[]) => Promise<Map<string, Uint8Array | null>>;
  /** 仅为旧测试/非 Tauri 调用保留的兼容单条读取。生产 fast path 使用 batch。 */
  readGlbFile?: (projectId: number, entryPath: string) => Promise<Uint8Array | null>;
}

const GLB_BATCH_MAX_FILES = 256;
const GLB_BATCH_MAX_BYTES = 64 * 1024 * 1024;

function disposeFastPathGroup(group: THREE.Group): void {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material ? [mesh.material] : [];
    for (const material of materials) material?.dispose?.();
  });
}

function validateCachedGlbBytes(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.byteLength < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, false) === 0x676c5446 // "glTF"
    && view.getUint32(4, true) === 2
    && view.getUint32(8, true) === bytes.byteLength;
}

/**
 * A syntactically valid GLB can still decode to an empty scene when its
 * payload was produced by a broken/partial exporter. Treat that as a parse
 * failure so the caller falls back to the raw MOD/STL source. A valid cache
 * generated by serializeDevToGlb always contains at least one positioned
 * mesh; bbox rejects (for example, a runaway placement) remain a per-instance
 * quality decision handled below.
 */
function hasRenderableGlbGeometry(group: THREE.Group): boolean {
  let found = false;
  group.traverse((object) => {
    if (found) return;
    const mesh = object as THREE.Mesh;
    const position = mesh.geometry?.getAttribute?.('position');
    if ((mesh as THREE.Mesh).isMesh && position && position.count > 0) found = true;
  });
  return found;
}

function emptyFastPathProfile(cbmInstanceCount: number, uniqueDevCount: number): DevGlbFastPathProfile {
  return {
    cbmInstanceCount,
    uniqueDevCount,
    glbDevCount: 0,
    emptyDevCount: 0,
    glbBatchReadMs: 0,
    glbReadBytes: 0,
    glbParseCount: 0,
    glbParseMs: 0,
    rawModFallbackCount: 0,
  };
}

export async function tryDevGlbFastPath(
  state: AppState,
  scene: THREE.Scene,
  deviceNodes: CbmNode[],
  showProgress: (p: AutoLoadProgress) => void,
  token?: number,
  dependencies?: DevGlbFastPathDependencies,
  context?: { generation?: number; projectId?: number | null; sourceSha256?: string | null; session?: ProjectLoadSession },
): Promise<DevGlbFastPathResult> {
  const uniqueKeys = new Set<string>();
  for (const seed of deviceNodes) if (seed.devPath) uniqueKeys.add(normalizeDevEntryPath(seed.devPath).toLowerCase());
  const profile = emptyFastPathProfile(deviceNodes.length, uniqueKeys.size);
  const fail = (reason: string, modCount = 0): DevGlbFastPathResult => ({
    loaded: false,
    modCount,
    stlCount: 0,
    profile: { ...profile, rawModFallbackCount: 1, fallbackReason: reason },
  });
  const success = (modCount: number): DevGlbFastPathResult => ({
    loaded: true,
    modCount,
    stlCount: 0,
    profile: { ...profile, rawModFallbackCount: 0 },
  });

  const capturedProjectId = context?.session?.projectId ?? context?.projectId ?? state.currentProjectId;
  const capturedGeneration = context?.session?.generation ?? context?.generation ?? state.projectGeneration;
  const capturedSourceSha256 = context?.session?.sourceSha256 ?? context?.sourceSha256 ?? state.currentSourceSha256;
  const session: ProjectLoadSession = context?.session ?? {
    generation: capturedGeneration,
    projectId: capturedProjectId,
    sourceSha256: capturedSourceSha256,
    geometryToken: token ?? state.geometryLoadToken,
  };
  const isCurrent = () => {
    const stateSessionCheck = typeof state.isCurrentSession === 'function'
      ? state.isCurrentSession(session)
      : isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256);
    return stateSessionCheck && (token === undefined || state.geometryLoadToken === token);
  };

  if (capturedProjectId == null || deviceNodes.length === 0 || uniqueKeys.size === 0) return fail('no-project-or-dev');

  // 1. 按 unique DEV 建立 placement 映射；同一 DEV 的不同 CBM 实例保留全部。
  const devOrder: string[] = [];
  const seedsByDev = new Map<string, CbmNode[]>();
  for (const seed of deviceNodes) {
    if (!seed.devPath) continue;
    const devPath = normalizeDevEntryPath(seed.devPath);
    const key = devPath.toLowerCase();
    const existing = seedsByDev.get(key);
    if (existing) existing.push(seed);
    else {
      seedsByDev.set(key, [seed]);
      devOrder.push(devPath);
    }
  }

  const useLegacyRead = Boolean(dependencies?.readGlbFile
    && !dependencies?.readGeometryCacheManifest
    && !dependencies?.batchReadGlbFiles);
  let manifestEntries = new Map<string, GeometryCacheManifestEntry>();
  if (useLegacyRead) {
    for (const devPath of devOrder) manifestEntries.set(devPath.toLowerCase(), {
      entry_path: devPath,
      status: 'glb',
      size: -1,
    });
  } else {
    const readManifest = dependencies?.readGeometryCacheManifest
      ?? (await import('@desktop/database.js')).readGeometryCacheManifest;
    let manifest: GeometryCacheManifest;
    try {
      manifest = await readManifest(capturedProjectId);
    } catch (err) {
      debugLog(DEBUG_IFC_LOAD, '[autoLoad] DEV GLB manifest 不可读，回退原始 MOD', err);
      return fail('manifest-read-failed');
    }
    if (!isCurrent()) return fail('session-invalid');
    if (capturedSourceSha256 && manifest.source_sha256 !== capturedSourceSha256) return fail('manifest-source-mismatch');
    if (!Array.isArray(manifest.entries) || manifest.entries.length > 200_000) return fail('manifest-invalid');
    for (const entry of manifest.entries) {
      if (!entry || typeof entry.entry_path !== 'string') return fail('manifest-entry-invalid');
      const key = normalizeDevEntryPath(entry.entry_path).toLowerCase();
      if (manifestEntries.has(key)
        || !/^dev\//i.test(entry.entry_path.replace(/\\/g, '/'))
        || (entry.status !== 'glb' && entry.status !== 'empty')
        || (entry.status === 'empty' && entry.size !== 0)
        || (entry.status === 'glb' && (!Number.isSafeInteger(entry.size) || entry.size <= 0))) {
        return fail(`manifest-entry-invalid:${entry.entry_path}`);
      }
      manifestEntries.set(key, entry);
    }
  }

  for (const devPath of devOrder) {
    if (!manifestEntries.has(devPath.toLowerCase())) return fail(`manifest-missing:${devPath}`);
  }
  const selectedEntries = devOrder.map((devPath) => manifestEntries.get(devPath.toLowerCase())!);
  profile.glbDevCount = selectedEntries.filter((entry) => entry.status === 'glb').length;
  profile.emptyDevCount = selectedEntries.filter((entry) => entry.status === 'empty').length;

  // 2. 先读取全部 unique DEV GLB bytes，再进入 placement parse；空 DEV 不读取。
  const glbBytesByDev = new Map<string, Uint8Array | null>();
  const glbPaths = selectedEntries.filter((entry) => entry.status === 'glb').map((entry) => entry.entry_path);
  const batchStarted = performance.now();
  try {
    if (useLegacyRead) {
      const readGlbFile = dependencies!.readGlbFile!;
      for (const devPath of glbPaths) {
        const bytes = await readGlbFile(capturedProjectId, devPath);
        if (!isCurrent()) return fail('session-invalid');
        glbBytesByDev.set(devPath.toLowerCase(), bytes);
      }
    } else {
      const batchReadGlbFiles = dependencies?.batchReadGlbFiles
        ?? (await import('@desktop/database.js')).batchReadGlbFiles;
      for (let start = 0; start < glbPaths.length;) {
        const batch: string[] = [];
        let expectedBytes = 0;
        while (start < glbPaths.length && batch.length < GLB_BATCH_MAX_FILES) {
          const batchPath = normalizeDevEntryPath(glbPaths[start]);
          const entry = manifestEntries.get(batchPath.toLowerCase())!;
          const nextSize = Math.max(0, entry.size);
          if (batch.length > 0 && expectedBytes + nextSize > GLB_BATCH_MAX_BYTES) break;
          batch.push(glbPaths[start]);
          expectedBytes += nextSize;
          start++;
        }
        if (batch.length === 0) {
          // 单个大 GLB 独占一个批次；Rust 侧仍有 512 MiB 单文件上限。
          batch.push(glbPaths[start]);
          start++;
        }
        const bytesMap = await batchReadGlbFiles(capturedProjectId, batch);
        if (!isCurrent()) return fail('session-invalid');
        const normalizedResults = new Map<string, Uint8Array | null>();
        for (const [path, bytes] of bytesMap) normalizedResults.set(normalizeDevEntryPath(path).toLowerCase(), bytes);
        for (const path of batch) {
          const key = normalizeDevEntryPath(path).toLowerCase();
          glbBytesByDev.set(key, normalizedResults.get(key) ?? null);
        }
      }
    }
  } catch (err) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] DEV GLB 批量读取失败，回退原始 MOD', err);
    return fail('glb-batch-read-failed');
  }
  profile.glbBatchReadMs = Math.max(0, performance.now() - batchStarted);

  for (const entry of selectedEntries) {
    if (entry.status !== 'glb') continue;
    // The batch response map is keyed by the canonical slash-separated path;
    // manifests produced by older/exporter variants may still use backslashes.
    // Normalize here as well as during manifest lookup so a valid cache is not
    // mistaken for a missing GLB on a path-separator-only variation.
    const bytes = glbBytesByDev.get(normalizeDevEntryPath(entry.entry_path).toLowerCase());
    if (!useLegacyRead && (!bytes || bytes.byteLength !== entry.size || !validateCachedGlbBytes(bytes))) {
      return fail(`glb-invalid:${entry.entry_path}`);
    }
    if (bytes) profile.glbReadBytes += bytes.byteLength;
  }
  if (!isCurrent()) return fail('session-invalid');

  const loadDevGlb = dependencies?.loadDevGlb
    ?? (await import('./glbCacheService.js')).loadDevGlb;
  const applyPlacementTransformToSceneUnits = dependencies?.applyPlacementTransformToSceneUnits
    ?? (await import('../viewer/xmlModLoader.js')).applyPlacementTransformToSceneUnits;
  const { modRoot } = ensureGeometryLayers(state, scene);
  const addedGroups: Array<{ instanceKey: string; group: THREE.Group }> = [];
  const totalSeeds = deviceNodes.length;
  let loadedCount = 0;
  let processedCount = 0;
  showProgress({ phase: 'loading_mod', collectedDevPaths: deviceNodes.length, discoveredMods: totalSeeds, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: totalSeeds, totalStls: 0 });

  const cleanupAndFail = (reason: string): DevGlbFastPathResult => {
    for (const { instanceKey, group } of addedGroups) {
      modRoot.remove(group);
      state.loadedXmlModGroups.delete(instanceKey);
      disposeFastPathGroup(group);
    }
    return fail(reason);
  };

  for (const devPath of devOrder) {
    const entry = manifestEntries.get(devPath.toLowerCase())!;
    const bytes = entry.status === 'glb' ? glbBytesByDev.get(devPath.toLowerCase())! : null;
    for (const seed of seedsByDev.get(devPath.toLowerCase()) ?? []) {
      if (!isCurrent()) return cleanupAndFail('session-invalid');
      const instanceKey = `dev:${devPath}#${seed.path}`;
      if (state.loadedXmlModGroups.has(instanceKey)) {
        loadedCount++;
        processedCount++;
        showProgress({ phase: 'loading_mod', collectedDevPaths: deviceNodes.length, discoveredMods: totalSeeds, discoveredStls: 0, loadedMods: loadedCount, loadedStls: 0, totalMods: totalSeeds, totalStls: 0, processedMods: processedCount });
        continue;
      }
      let loadedGroup: THREE.Group | null = null;
      try {
        if (entry.status === 'empty') {
          // 合法 empty DEV：不读、不 parse、不触发原始 MOD fallback。
          continue;
        }
        if (!bytes) return cleanupAndFail(`glb-invalid:${devPath}`);
        const parseStarted = performance.now();
        profile.glbParseCount++;
        try {
          loadedGroup = await loadDevGlb(devPath, bytes);
        } finally {
          profile.glbParseMs += Math.max(0, performance.now() - parseStarted);
        }
        if (!loadedGroup) return cleanupAndFail(`glb-parse-failed:${devPath}`);
        if (!isCurrent()) {
          disposeFastPathGroup(loadedGroup);
          return cleanupAndFail('session-invalid');
        }

        if (!hasRenderableGlbGeometry(loadedGroup)) {
          disposeFastPathGroup(loadedGroup);
          loadedGroup = null;
          return cleanupAndFail(`glb-parse-failed:${devPath}`);
        }

        const cbmTransform = parseCbmTransformMatrix(seed.transformMatrix);
        applyPlacementTransformToSceneUnits(loadedGroup, cbmTransform);
        applyProjectSourceToViewer(loadedGroup, state.projectSourceToViewerMatrix);
        // A valid GLB can still contain a placement whose transformed bounds
        // are outside the scene safety envelope (the raw MOD path makes the
        // same per-placement decision).  This is a geometry-quality issue,
        // not cache corruption: do not discard otherwise valid DEV cache data
        // and do not trigger an expensive raw-MOD fallback for the whole
        // project.  `diagnoseGroupBBox` owns disposal for rejected groups.
        if (!diagnoseGroupBBox(loadedGroup, devPath)) {
          loadedGroup = null;
          continue;
        }

        loadedGroup.userData.devPath = devPath;
        modRoot.add(loadedGroup);
        state.loadedXmlModGroups.set(instanceKey, loadedGroup);
        addedGroups.push({ instanceKey, group: loadedGroup });
        loadedGroup = null; // ownership transferred to scene/cleanup list
        loadedCount++;
      } catch (err) {
        if (loadedGroup) disposeFastPathGroup(loadedGroup);
        console.error(`[autoLoad] DEV GLB 加载失败: ${devPath}`, err);
        return cleanupAndFail(`glb-parse-failed:${devPath}`);
      } finally {
        processedCount++;
        showProgress({ phase: 'loading_mod', collectedDevPaths: deviceNodes.length, discoveredMods: totalSeeds, discoveredStls: 0, loadedMods: loadedCount, loadedStls: 0, totalMods: totalSeeds, totalStls: 0, processedMods: processedCount });
      }
    }
  }

  if (!isCurrent()) return cleanupAndFail('session-invalid');
  debugLog(DEBUG_IFC_LOAD, `[autoLoad] DEV GLB 快速路径完成: ${loadedCount} 个 CBM placement，${profile.glbDevCount} 个 GLB DEV，${profile.emptyDevCount} 个 empty DEV`);
  showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: totalSeeds, discoveredStls: 0, loadedMods: loadedCount, loadedStls: 0, totalMods: totalSeeds, totalStls: 0, processedMods: processedCount });
  return success(loadedCount);
}

export async function autoLoadModAndStlGeometry(
  state: AppState,
  scene: THREE.Scene,
  showProgress: (p: AutoLoadProgress) => void,
  options: GeometryAutoLoadOptions = {},
): Promise<{ modCount: number; stlCount: number; devGlbProfile?: DevGlbFastPathProfile }> {
  const includeMod = options.includeMod ?? true;
  const includeStl = options.includeStl ?? false;
  const token = options.token;
  const session = options.session ?? state.captureProjectSession();
  const capturedGeneration = options.generation ?? session.generation;
  const capturedProjectId = options.projectId ?? session.projectId;
  const capturedSourceSha256 = options.sourceSha256 ?? session.sourceSha256;
  let devGlbProfile: DevGlbFastPathProfile | undefined;
  const resultWithProfile = (modCount: number, stlCount: number) => ({
    modCount,
    stlCount,
    ...(devGlbProfile ? { devGlbProfile } : {}),
  });

  let files = state.currentFiles;
  const cbmTree = state.currentCbmTree;

  // 早期 token 校验：项目已切换则立即退出
  if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] token 不匹配，停止加载（项目已切换）');
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

  // ── Phase 1.2 (方案 C v2): DEV 粒度 GLB 快速路径 ──
  // 如果所有 seed 的 DEV.glb 缓存全部命中，直接加载 DEV.glb，跳过 XML 解析
  const devGlbResult = await tryDevGlbFastPath(state, scene, deviceNodes, showProgress, token, undefined, {
    generation: capturedGeneration,
    projectId: capturedProjectId,
    sourceSha256: capturedSourceSha256,
    session,
  });
  devGlbProfile = devGlbResult.profile;
  if (devGlbResult.loaded) {
    return { modCount: devGlbResult.modCount, stlCount: devGlbResult.stlCount, devGlbProfile };
  }

  // ── Phase 1.5: 缓存命中场景 → SQLite 查询 + 仅批量读 MOD/STL ──
  // 设计动机：demo-substation 有 4179 个 DEV → 3921 个无 SOLIDMODEL，
  // 逐文件读取是巨大浪费。SQLite 已索引引用链，一次查询即可得到全部 MOD/STL 路径。
  const isCacheHit = !files;
  if (isCacheHit && capturedProjectId != null) {
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] SQLite 查询可到达几何: includeMod=${includeMod} includeStl=${includeStl}`);
    try {
      const { getReachableGeometry, batchReadCachedFiles } = await import('@desktop/database.js');
      const reachable = await getReachableGeometry(capturedProjectId, { includeMod, includeStl });
      if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) return resultWithProfile(0, 0);

      if (reachable.length === 0) {
        debugLog(DEBUG_IFC_LOAD, '[autoLoad] 无可到达的 MOD/STL 几何源（SQLite 查询为空）');
        showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
        return resultWithProfile(0, 0);
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
      debugLog(DEBUG_IFC_LOAD, `[autoLoad] SQLite 查询完成: ${reachable.length} 个几何源 → ${logExtras.join(' + ')}`);

      // 方案 C v2：DEV 粒度 GLB 由 tryDevGlbFastPath 处理；
      // 此处为回退路径，直接批量读取 MOD/STL 原始字节
      const modArr = Array.from(modPaths);
      const stlArr = Array.from(stlPaths);
      const allGeomPaths = Array.from(new Set([...modArr, ...stlArr]));

      if (allGeomPaths.length > 0) {
        debugLog(DEBUG_IFC_LOAD, `[autoLoad] 批量读取 ${allGeomPaths.length} 个 MOD/STL 原始字节（1 次 IPC）...`);
        const bytesMap = await batchReadCachedFiles(capturedProjectId, allGeomPaths);
        if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) return resultWithProfile(0, 0);
        files = new Map();
        let hitCount = 0;
        for (const [path, bytes] of bytesMap) {
          if (bytes && bytes.byteLength > 0) {
            files.set(path, bytesToFile(bytes, path));
            hitCount++;
          }
        }
        debugLog(DEBUG_IFC_LOAD, `[autoLoad] 原始字节读取完成: ${hitCount}/${allGeomPaths.length} 命中`);
      }

      if (!files || files.size === 0) {
        debugLog(DEBUG_IFC_LOAD, '[autoLoad] 无有效 MOD/STL 文件，跳过加载');
        showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
        return resultWithProfile(0, 0);
      }

      debugLog(DEBUG_IFC_LOAD, `[autoLoad] 磁盘读取完成: ${files.size} 个文件（${isCacheHit ? '缓存命中' : '首次打开'}）`);

      // 缓存命中时跳过 Phase 2 的 DEV→PHM→MOD 发现循环，
      // 直接用 SQLite 返回的结果加载几何
      const modGeos: DiscoveredModGeometry[] = [];
      const stlGeos: DiscoveredStlGeometry[] = [];

      for (const r of reachable) {
        if (modGeos.length + stlGeos.length >= PARSER_LIMITS.maxGeometryInstances) {
          throw new Error(`可达几何实例数超过安全上限 ${PARSER_LIMITS.maxGeometryInstances}`);
        }
        const lower = r.geometry_path.toLowerCase();
        const devTM = r.dev_transform_matrix
          ? r.dev_transform_matrix.split(',').map(Number)
          : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const phmTM = r.phm_transform_matrix
          ? r.phm_transform_matrix.split(',').map(Number)
          : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const phmColor = parseCachedPhmColor(r.phm_color);
        const phmColorMaxA = r.phm_color_max_a ?? phmColor?.a ?? 0;

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
            phmColor,
            phmColorMaxA,
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
            phmColor,
            phmColorMaxA,
            devPath: '',
            phmPath: '',
          });
        }
      }

      // 跳过 Phase 2，直接进入加载阶段
      debugLog(DEBUG_IFC_LOAD, `[autoLoad] DB 直通加载: ${modGeos.length} MOD + ${stlGeos.length} STL`);

      const { applyPlacementTransformToSceneUnits } = await import('../viewer/xmlModLoader.js');
      const { modRoot, stlRoot } = ensureGeometryLayers(state, scene);
      let loadedMods = 0;
      let loadedStls = 0;
      let skippedBadBBox = 0;

      // 加载 MOD（方案 C：优先 GLB，回退 XML）
      if (modGeos.length > 0) {
        debugLog(DEBUG_IFC_LOAD, `[autoLoad] 开始加载 ${modGeos.length} 个 MOD...`);
        for (let i = 0; i < modGeos.length; i += CONCURRENCY) {
          if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) { debugLog(DEBUG_IFC_LOAD, '[autoLoad] 工程上下文不匹配，停止 DB MOD 加载'); return resultWithProfile(loadedMods, 0); }
          const batch = modGeos.slice(i, i + CONCURRENCY);
          showProgress({ phase: 'loading_mod', collectedDevPaths: deviceNodes.length, discoveredMods: modGeos.length, discoveredStls: stlGeos.length, loadedMods, loadedStls, totalMods: modGeos.length, totalStls: stlGeos.length, currentPath: batch[0].modPath });
          for (const geo of batch) {
            if (state.loadedXmlModGroups.has(geo.instanceKey)) { loadedMods++; continue; }
            try {
              const group = await loadModFile(geo, files ?? new Map());
              if (group) {
                if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
                  group.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
                  return resultWithProfile(loadedMods, 0);
                }
                if (!prepareModGroupForScene(group, geo.modPath, applyPlacementTransformToSceneUnits, geo.placementTransformMatrix, state.projectSourceToViewerMatrix)) { skippedBadBBox++; loadedMods++; continue; }
                group.userData.devPath = geo.devPath;
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
        debugLog(DEBUG_IFC_LOAD, `[autoLoad] MOD 加载完成: ${loadedMods}/${modGeos.length}（跳过异常 bbox: ${skippedBadBBox}）`);
      }

      // 加载 STL（仅 includeStl=true 时进入，stlGeos 已在 discovery 阶段过滤）
      if (stlGeos.length > 0) {
        debugLog(DEBUG_IFC_LOAD, `[autoLoad] 开始加载 ${stlGeos.length} 个 STL...`);
        for (let i = 0; i < stlGeos.length; i += CONCURRENCY) {
          if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) { debugLog(DEBUG_IFC_LOAD, '[autoLoad] 工程上下文不匹配，停止 DB STL 加载'); return resultWithProfile(loadedMods, loadedStls); }
          const batch = stlGeos.slice(i, i + CONCURRENCY);
          showProgress({ phase: 'loading_stl', collectedDevPaths: deviceNodes.length, discoveredMods: modGeos.length, discoveredStls: stlGeos.length, loadedMods, loadedStls, totalMods: modGeos.length, totalStls: stlGeos.length, currentPath: batch[0].stlPath });
          for (const geo of batch) {
            if (state.loadedStlGroups.has(geo.instanceKey)) { loadedStls++; continue; }
            try {
              const group = await loadStlFile(geo, files ?? new Map());
              if (group) {
                if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
                  group.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
                  return resultWithProfile(loadedMods, loadedStls);
                }
                if (!prepareStlGroupForScene(group, geo.stlPath, applyPlacementTransformToSceneUnits, geo.placementTransformMatrix, state.projectSourceToViewerMatrix)) { skippedBadBBox++; loadedStls++; continue; }
                group.userData.devPath = geo.devPath;
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
        debugLog(DEBUG_IFC_LOAD, `[autoLoad] STL 加载完成: ${loadedStls}/${stlGeos.length}`);
      }

      debugLog(DEBUG_IFC_LOAD, `[autoLoad] 全部几何加载完成 (DB直通): MOD=${loadedMods}, STL=${loadedStls}, 跳过异常bbox=${skippedBadBBox}`);
      showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: modGeos.length, discoveredStls: stlGeos.length, loadedMods, loadedStls, totalMods: modGeos.length, totalStls: stlGeos.length });
      return { modCount: loadedMods, stlCount: loadedStls, devGlbProfile };
    } catch (err) {
      console.warn('[autoLoad] SQLite 几何查询失败，回退到文件扫描:', err);
      // 回退：尝试 buildFileMapFromDiskCache（已有进度日志）
      if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256) || capturedProjectId == null) {
        return resultWithProfile(0, 0);
      }
      files = await buildFileMapFromDiskCache(capturedProjectId, uniqueDevPaths);
      if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) return resultWithProfile(0, 0);
      if (!files || files.size === 0) {
        showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
        return resultWithProfile(0, 0);
      }
    }
  }

  if (!files) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] 跳过：无文件来源（currentFiles=null 且 projectId=null）');
    return resultWithProfile(0, 0);
  }

  // ── Phase 2: 发现几何源（遍历 CBM 实例 → DEV → PHM → MOD/STL） ──
  // 注意：deviceNodes 可能很大（数千），必须节流 showProgress + 频繁 yield
  showProgress({ phase: 'discovering', collectedDevPaths: deviceNodes.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });

  const { discoverGeometriesFromNode } = await import('./modGeometryDiscovery.js');

  // 全局去重集合：key = instanceKey。同一 MOD/STL 文件可有多个 placement 实例。
  const modMap = new Map<string, DiscoveredModGeometry>();
  const stlMap = new Map<string, DiscoveredStlGeometry>();

  debugLog(DEBUG_IFC_LOAD, `[autoLoad] 开始发现几何源（${deviceNodes.length} 个 CBM 设备实例）...`);

  let discoveredCount = 0;
  const PROGRESS_INTERVAL = 50;  // 每 50 个 CBM 设备实例更新一次进度 UI
  const YIELD_INTERVAL = 5;      // 每 5 个 CBM 设备实例 yield 主线程
  const LOG_INTERVAL = 100;      // 每 100 个 CBM 设备实例输出 debugLog

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
      debugLog(DEBUG_IFC_LOAD, `[autoLoad] 发现进度: ${discoveredCount}/${deviceNodes.length} CBM instances, MOD=${modMap.size}, STL=${stlMap.size}`);
      // 批次间检查 token，项目切换时提前退出
      if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
        debugLog(DEBUG_IFC_LOAD, '[autoLoad] token 不匹配，停止发现（项目已切换）');
        return resultWithProfile(0, 0);
      }
    }

    try {
      const result = await discoverGeometriesFromNode(node, files);
      if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) return resultWithProfile(0, 0);
      for (const modGeo of result.mods) {
        if (modMap.size >= PARSER_LIMITS.maxGeometryInstances && !modMap.has(modGeo.instanceKey)) {
          throw new Error(`MOD 几何实例数超过安全上限 ${PARSER_LIMITS.maxGeometryInstances}`);
        }
        if (!modMap.has(modGeo.instanceKey)) {
          modMap.set(modGeo.instanceKey, modGeo);
        }
      }
      if (includeStl) {
        for (const stlGeo of result.stls) {
          if (stlMap.size >= PARSER_LIMITS.maxGeometryInstances && !stlMap.has(stlGeo.instanceKey)) {
            throw new Error(`STL 几何实例数超过安全上限 ${PARSER_LIMITS.maxGeometryInstances}`);
          }
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

  debugLog(DEBUG_IFC_LOAD, `[autoLoad] 发现完成: ${modGeos.length} 个 MOD + ${stlGeos.length} 个 STL（实例去重后，共扫描 ${discoveredCount} 个 CBM 实例）`);

  // ── Phase 3: 分批加载 MOD ──
  const { applyPlacementTransformToSceneUnits } = await import('../viewer/xmlModLoader.js');
  const { modRoot, stlRoot } = ensureGeometryLayers(state, scene);
  let loadedMods = 0;
  let skippedBadBBox = 0;

  if (modGeos.length > 0) {
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] 开始加载 ${modGeos.length} 个 MOD 文件...`);
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
      if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
        debugLog(DEBUG_IFC_LOAD, '[autoLoad] token 不匹配，停止 MOD 加载');
        return resultWithProfile(loadedMods, 0);
      }

      for (const geo of batch) {
        if (state.loadedXmlModGroups.has(geo.instanceKey)) { loadedMods++; continue; }

        try {
          const group = await loadModFile(geo, files);
          if (group) {
            if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
              group.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
              return resultWithProfile(loadedMods, 0);
            }
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
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] MOD 加载完成: ${loadedMods}/${modGeos.length}（跳过异常 bbox: ${skippedBadBBox}）`);
  }

  // ── Phase 4: 分批加载 STL ──
  let loadedStls = 0;

  if (stlGeos.length > 0) {
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] 开始加载 ${stlGeos.length} 个 STL 文件...`);
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
      if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
        debugLog(DEBUG_IFC_LOAD, '[autoLoad] token 不匹配，停止 STL 加载');
        return resultWithProfile(loadedMods, loadedStls);
      }

      for (const geo of batch) {
        if (state.loadedStlGroups.has(geo.instanceKey)) { loadedStls++; continue; }

        try {
          const group = await loadStlFile(geo, files);
          if (group) {
            if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
              group.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
              return resultWithProfile(loadedMods, loadedStls);
            }
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
    debugLog(DEBUG_IFC_LOAD, `[autoLoad] STL 加载完成: ${loadedStls}/${stlGeos.length}`);
  }

  // ── Phase 5: 完成 ──
  debugLog(DEBUG_IFC_LOAD, `[autoLoad] 全部几何加载完成: MOD=${loadedMods}, STL=${loadedStls}, 跳过异常bbox=${skippedBadBBox}`);
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

  return { modCount: loadedMods, stlCount: loadedStls, devGlbProfile };
}
