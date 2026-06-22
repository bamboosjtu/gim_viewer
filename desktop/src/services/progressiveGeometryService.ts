/**
 * 渐进式 DEV GLB 几何管线（首次打开路径，2026-08-25）。
 *
 * 背景：原首次打开流程中 MOD 几何被完整解析两遍——
 * 1. autoLoadModAndStlGeometry 逐实例解析渲染（4787 实例 × XML 解析）
 * 2. cacheGlbFiles 再解析一遍序列化为 GLB 缓存
 * 两者串行执行导致首次打开耗时 10 分钟以上。
 *
 * 本管线把两步合一：按唯一 DEV 迭代，
 *   serializeDevToGlb（解析 1 遍）→ writeGlbFile（落盘供二次秒开）
 *   → 立即按 CBM 实例渲染到场景（渐进显示）→ 下一个 DEV。
 *
 * - IFC 优先：管线在 IFC 加载完成后以后台任务启动（调用方保证）
 * - DEV 粒度：同一 DEV 的多个 CBM 实例共享一次序列化，逐实例应用 CBM 矩阵
 * - 渐进反馈：每编译一个 DEV 通过 onProgress 上报，场景即时更新
 * - 中断安全：token 不匹配（项目切换）立即退出且不写版本文件，
 *   下次打开 geometry_cache_version_match=false 自动清理重编译
 * - 浏览器模式：无 projectId / 非 Tauri 时跳过落盘与版本文件，仅渐进渲染
 *
 * 关联文档：docs/architecture.md §关键设计、docs/dev-log.md
 */

import * as THREE from 'three';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { isTauri } from '@desktop/runtime.js';
import {
  collectCbmDeviceInstances,
  ensureGeometryLayers,
  parseCbmTransformMatrix,
  diagnoseGroupBBox,
  isGeometryTokenValid,
} from './modAutoLoadService.js';
import { applyProjectSourceToViewer } from './coordinateAlignmentService.js';

/** 渐进管线进度 */
export interface ProgressiveGeometryProgress {
  phase: 'compiling' | 'done';
  /** 已编译（序列化+落盘）的 DEV 数 */
  compiledDevs: number;
  /** 唯一 DEV 总数 */
  totalDevs: number;
  /** 已渲染的 CBM 实例数 */
  renderedInstances: number;
  /** 当前正在编译的 DEV 路径 */
  currentDevPath?: string;
}

/** 管线结果 */
export interface ProgressiveGeometryResult {
  compiledDevs: number;
  renderedInstances: number;
  /** 是否被 token 中断（项目切换） */
  interrupted: boolean;
  /** P1 评审：序列化或落盘失败、未获得确定性结果的 DEV 路径 */
  failedDevs: string[];
}

/** 依赖注入（测试可替换） */
export interface ProgressiveGeometryDependencies {
  serializeDevToGlb: (devPath: string, files: Map<string, File>) => Promise<Uint8Array | null>;
  loadDevGlb: (devPath: string, bytes: Uint8Array) => Promise<THREE.Group | null>;
  writeGlbFile: (projectId: number, entryPath: string, bytes: Uint8Array) => Promise<unknown>;
  writeGeometryCacheVersion: (projectId: number) => Promise<unknown>;
  writeGeometryCacheManifest: (projectId: number, sourceSha256: string, entries: Array<{ entry_path: string; size: number }>) => Promise<unknown>;
  applyPlacementTransformToSceneUnits: (group: THREE.Group, transformMatrix: number[] | null | undefined) => void;
  yieldToMain: () => Promise<void>;
}

function defaultDependencies(): ProgressiveGeometryDependencies {
  return {
    serializeDevToGlb: (devPath, files) => import('./glbCacheService.js').then((m) => m.serializeDevToGlb(devPath, files)),
    loadDevGlb: (devPath, bytes) => import('./glbCacheService.js').then((m) => m.loadDevGlb(devPath, bytes)),
    writeGlbFile: (projectId, entryPath, bytes) => import('@desktop/database.js').then((m) => m.writeGlbFile(projectId, entryPath, bytes)),
    writeGeometryCacheVersion: (projectId) => import('@desktop/database.js').then((m) => m.writeGeometryCacheVersion(projectId)),
    writeGeometryCacheManifest: (projectId, sourceSha256, entries) => import('@desktop/database.js').then((m) => m.writeGeometryCacheManifest(projectId, sourceSha256, entries)),
    applyPlacementTransformToSceneUnits: (group, matrix) =>
      import('../viewer/xmlModLoader.js').then((m) => m.applyPlacementTransformToSceneUnits(group, matrix)),
    yieldToMain: () => new Promise((r) => setTimeout(r, 0)),
  };
}

/** 归一化 devPath 为 DEV/ 前缀键（与 tryDevGlbFastPath 一致） */
function normalizeDevEntryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.toLowerCase().startsWith('dev/') ? normalized : `DEV/${normalized}`;
}

/**
 * 渐进式 DEV GLB 管线主入口。
 *
 * @param state 全局 AppState（currentFiles 与 currentCbmTree 必须非空，即首次打开场景）
 * @param scene THREE.Scene
 * @param onProgress 进度回调（每编译一个 DEV 上报一次）
 * @param options.token 防竞态 token（项目切换后递增）
 * @param dependencies 依赖注入（测试用）
 */
export async function runProgressiveDevGlbPipeline(
  state: AppState,
  scene: THREE.Scene,
  onProgress: (p: ProgressiveGeometryProgress) => void,
  options: {
    token?: number;
    generation?: number;
    projectId?: number | null;
    sourceSha256?: string | null;
    session?: ProjectLoadSession;
  } = {},
  dependencies?: Partial<ProgressiveGeometryDependencies>,
): Promise<ProgressiveGeometryResult> {
  const deps = { ...defaultDependencies(), ...dependencies };
  const token = options.token;
  const files = state.currentFiles;
  const tree = state.currentCbmTree;

  const interrupted: ProgressiveGeometryResult = { compiledDevs: 0, renderedInstances: 0, interrupted: true, failedDevs: [] };

  if (!isGeometryTokenValid(state, token)) return interrupted;

  const capturedGeneration = options.generation ?? options.session?.generation ?? state.projectGeneration;
  const capturedProjectId = options.projectId ?? options.session?.projectId ?? state.currentProjectId;
  const session: ProjectLoadSession = options.session ?? {
    generation: capturedGeneration,
    projectId: capturedProjectId,
    sourceSha256: options.sourceSha256 ?? state.currentSourceSha256,
    geometryToken: token ?? state.geometryLoadToken,
  };
  const isSessionValid = () => state.isCurrentSession(session)
    && (token === undefined || state.geometryLoadToken === token);

  // P1 评审：固定捕获当前 projectId——后续异步操作一律使用此快照，
  // 不再读取可变的 state.currentProjectId（快速切换项目时旧任务不得写新项目）
  // capturedProjectId 已由入口快照固定

  if (!files || !tree) {
    debugLog(DEBUG_IFC_LOAD, '[progressive] 跳过：currentFiles 或 currentCbmTree 为空（非首次打开场景）');
    return { compiledDevs: 0, renderedInstances: 0, interrupted: false, failedDevs: [] };
  }

  // ── 1. 收集 CBM 设备实例并按唯一 DEV 分组（保持树遍历顺序）──
  const seeds = collectCbmDeviceInstances(tree);
  if (seeds.length === 0) {
    debugLog(DEBUG_IFC_LOAD, '[progressive] 无 CBM 设备实例，管线结束');
    return { compiledDevs: 0, renderedInstances: 0, interrupted: false, failedDevs: [] };
  }

  const devOrder: string[] = [];
  const seedsByDev = new Map<string, CbmNode[]>();
  for (const seed of seeds) {
    if (!seed.devPath) continue;
    const devPath = normalizeDevEntryPath(seed.devPath);
    const arr = seedsByDev.get(devPath);
    if (arr) arr.push(seed);
    else {
      seedsByDev.set(devPath, [seed]);
      devOrder.push(devPath);
    }
  }

  debugLog(DEBUG_IFC_LOAD, `[progressive] ${seeds.length} 个 CBM 实例 → ${devOrder.length} 个唯一 DEV，开始渐进编译`);

  const { modRoot } = ensureGeometryLayers(state, scene);
  const totalDevs = devOrder.length;
  let compiledDevs = 0;
  let renderedInstances = 0;
  // P1 评审：结果追踪——只有全部 DEV 都有确定性结果（GLB 落盘成功 或 确认空几何）
  // 才写版本标记；任何失败都保持版本戳过期，下次打开自动重建
  const failedDevs: string[] = [];
  const glbEntries: Array<{ entry_path: string; size: number }> = [];

  const report = (currentDevPath?: string) =>
    onProgress({ phase: 'compiling', compiledDevs, totalDevs, renderedInstances, currentDevPath });

  report();

  // ── 2. 逐 DEV：序列化 → 落盘 → 逐实例渲染 ──
  for (const devPath of devOrder) {
    if (!isSessionValid()) {
      debugLog(DEBUG_IFC_LOAD, `[progressive] token 不匹配，中断（已编译 ${compiledDevs}/${totalDevs}）`);
      return { ...interrupted, compiledDevs, renderedInstances, failedDevs };
    }

    report(devPath);

    // 2.1 序列化（MOD/STL 只在此解析一次）
    let glbBytes: Uint8Array | null = null;
    let serializeFailed = false;
    try {
      glbBytes = await deps.serializeDevToGlb(devPath, files);
    } catch (err) {
      serializeFailed = true;
      failedDevs.push(devPath);
      console.warn(`[progressive] DEV 序列化失败（计入失败清单，不写版本标记）: ${devPath}`, err);
    }
    if (!glbBytes || glbBytes.byteLength === 0) {
      if (!serializeFailed) {
        // 无几何引用或空几何：tombstone（确定性结果），与 tryDevGlbFastPath 的 miss 语义一致
        compiledDevs++;
        continue;
      }
      compiledDevs++; // 进度计数继续，但该 DEV 未获得确定性结果
      continue;
    }

    // 2.2 落盘（仅 Tauri 且有 projectId；落盘前再次校验 token 防止写入错误项目）
    const persistable = capturedProjectId != null && isTauri();
    if (persistable) {
      if (!isSessionValid()) {
        debugLog(DEBUG_IFC_LOAD, `[progressive] 落盘前 token 失效，中断: ${devPath}`);
        return { ...interrupted, compiledDevs, renderedInstances, failedDevs };
      }
      try {
        await deps.writeGlbFile(capturedProjectId, devPath, glbBytes);
        glbEntries.push({ entry_path: devPath, size: glbBytes.byteLength });
        if (!isSessionValid()) {
          return { ...interrupted, compiledDevs, renderedInstances, failedDevs };
        }
      } catch (err) {
        failedDevs.push(devPath); // 渲染本次照常，但缓存完整性受损 → 不写版本标记
        console.warn(`[progressive] GLB 落盘失败（本次显示不受影响，版本标记将跳过）: ${devPath}`, err);
      }
    }

    // 2.3 逐 CBM 实例渲染
    const devSeeds = seedsByDev.get(devPath)!;
    for (const seed of devSeeds) {
      const instanceKey = `dev:${devPath}#${seed.path}`;
      if (state.loadedXmlModGroups.has(instanceKey)) continue;
      try {
        const group = await deps.loadDevGlb(devPath, glbBytes);
        if (!isSessionValid()) {
          group?.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
          return { ...interrupted, compiledDevs, renderedInstances, failedDevs };
        }
        if (!group) continue;

        // 应用 CBM 累积矩阵（含 mm→m，与 tryDevGlbFastPath 数学一致）
        const cbmTransform = parseCbmTransformMatrix(seed.transformMatrix);
        deps.applyPlacementTransformToSceneUnits(group, cbmTransform);

        // 应用项目级坐标转换（Z-up → Y-up）
        applyProjectSourceToViewer(group, state.projectSourceToViewerMatrix);

        // bbox 守卫（空/NaN/超大跨度跳过，与现有路径一致）
        if (!diagnoseGroupBBox(group, devPath)) continue;

        group.userData.devPath = devPath;
        modRoot.add(group);
        state.loadedXmlModGroups.set(instanceKey, group);
        renderedInstances++;
      } catch (err) {
        console.warn(`[progressive] DEV GLB 实例渲染失败: ${devPath} #${seed.path}`, err);
      }
    }

    compiledDevs++;
    report();

    // 批次间让出主线程，保证 IFC 交互与渲染不卡顿
    await deps.yieldToMain();
  }

  // ── 3. 写版本标记（P1 评审：仅当全部 DEV 均有确定性结果时提交；
  // 存在序列化/落盘失败的 DEV 时保持版本戳过期，下次打开自动重建，
  // 避免「完成」标记掩盖缺失的 GLB 导致二次打开静默丢几何）──
  if (!isSessionValid()) {
    debugLog(DEBUG_IFC_LOAD, '[progressive] 完成前 token 失效，不写版本标记');
    return { ...interrupted, compiledDevs, renderedInstances, failedDevs };
  }
  if (capturedProjectId != null && isTauri()) {
    if (failedDevs.length > 0) {
      console.warn(
        `[progressive] ${failedDevs.length} 个 DEV 无确定性结果，跳过 GLB 缓存版本标记（下次打开将重建）:`,
        failedDevs,
      );
    } else {
      try {
        if (!session.sourceSha256) {
          throw new Error('缺少当前源 GIM SHA-256，拒绝提交 GLB 缓存');
        }
        await deps.writeGeometryCacheManifest(capturedProjectId, session.sourceSha256, glbEntries);
        if (!isSessionValid()) {
          return { ...interrupted, compiledDevs, renderedInstances, failedDevs };
        }
        await deps.writeGeometryCacheVersion(capturedProjectId!);
        debugLog(DEBUG_IFC_LOAD, `[progressive] GLB 缓存版本标记已写入 (projectId=${capturedProjectId})`);
      } catch (err) {
        console.warn('[progressive] 写入 GLB 缓存版本标记失败:', err);
      }
    }
  }

  debugLog(DEBUG_IFC_LOAD, `[progressive] 管线完成: ${compiledDevs}/${totalDevs} DEV 编译，${renderedInstances} 实例渲染，${failedDevs.length} 失败`);
  onProgress({ phase: 'done', compiledDevs, totalDevs, renderedInstances });
  return { compiledDevs, renderedInstances, interrupted: false, failedDevs };
}
