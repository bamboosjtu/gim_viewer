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
 *   下次打开 geometry_cache_version_match=false 仅重建 geometry domain
 * - 浏览器模式：无 projectId / 非 Tauri 时跳过落盘与版本文件，仅渐进渲染
 *
 * 关联文档：docs/architecture.md §关键设计、docs/dev-log.md
 */

import * as THREE from 'three';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import type { GeometryCacheManifestEntry } from '@desktop/database.js';
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
import type { DevGlbFailureType, DevGlbFastPathProfile } from './modAutoLoadService.js';
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
  /** 无法产生可渲染 GLB、需要定向 raw fallback 的 DEV。 */
  rawFallbackDevs: string[];
  /** DEV 粒度几何诊断；冷路径与 warm geometry rebuild 共用该结构。 */
  devGlbProfile?: DevGlbFastPathProfile;
}

/** 依赖注入（测试可替换） */
export interface ProgressiveGeometryDependencies {
  serializeDevToGlb: (devPath: string, files: Map<string, File>) => Promise<Uint8Array | null>;
  loadDevGlb: (devPath: string, bytes: Uint8Array) => Promise<THREE.Group | null>;
  writeGlbFile: (projectId: number, entryPath: string, bytes: Uint8Array, sourceGimSha256?: string | null) => Promise<unknown>;
  writeGeometryCacheVersion: (projectId: number, sourceSha256?: string | null) => Promise<unknown>;
  writeGeometryCacheManifest: (projectId: number, sourceSha256: string, entries: GeometryCacheManifestEntry[]) => Promise<unknown>;
  applyPlacementTransformToSceneUnits: (group: THREE.Group, transformMatrix: number[] | null | undefined) => void;
  yieldToMain: () => Promise<void>;
}

function defaultDependencies(): ProgressiveGeometryDependencies {
  return {
    serializeDevToGlb: (devPath, files) => import('./glbCacheService.js').then((m) => m.serializeDevToGlb(devPath, files)),
    loadDevGlb: (devPath, bytes) => import('./glbCacheService.js').then((m) => m.loadDevGlb(devPath, bytes)),
    writeGlbFile: (projectId, entryPath, bytes, sourceGimSha256) => import('@desktop/database.js').then((m) => m.writeGlbFile(projectId, entryPath, bytes, sourceGimSha256)),
    writeGeometryCacheVersion: (projectId, sourceSha256) =>
      import('@desktop/database.js').then((m) => m.writeGeometryCacheVersion(projectId, sourceSha256)),
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
 * 将 strict geometry compiler 的异常映射到公开诊断枚举。
 *
 * `serializeDevToGlb` 会把底层 MOD/STL/DEV 错误包一层 DEV 上下文，
 * 因此不能只看最外层 message；同时沿着手动保留的 `cause` 链查找。
 * 这里不把任意异常当作 missing，避免“解析器崩溃”被误报成可通过补
 * 文件解决的问题；只有明确的路径缺失/ENOENT 才归类为 missing。
 */
export function classifyDevGlbFailure(error: unknown): DevGlbFailureType {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current instanceof Error) messages.push(current.message);
    else if (typeof current === 'string') messages.push(current);
    else if (typeof current === 'object' && current !== null) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === 'string') messages.push(message);
    }
    current = typeof current === 'object' && current !== null
      ? (current as { cause?: unknown }).cause
      : undefined;
  }

  const text = messages.join(' | ');
  if (/(?:ENOENT|\bmissing\b|not[\s-]?found|不存在|找不到|缺失)/i.test(text)) {
    return 'missing';
  }
  if (/(?:empty[\s-]?scene|空场景|无可渲染|均无法加载)/i.test(text)) {
    return 'empty-scene';
  }
  if (/(?:\binvalid\b|\btruncated\b|截断|无效|格式(?:错误|无效)|不支持)/i.test(text)) {
    return 'invalid';
  }
  return 'parse-exception';
}

function emptyDevGlbProfile(cbmInstanceCount: number, uniqueDevCount: number): DevGlbFastPathProfile {
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
    partialRawFallbackCount: 0,
    partialRawFallbackInstanceCount: 0,
    successfulGlbDevCount: 0,
    successfulGlbInstanceCount: 0,
    fullProjectRawFallbackCount: 0,
    failureType: {},
    failedDevCount: 0,
    failedDevPaths: [],
    partialRawFallbackMs: 0,
    partialRawFallbackReadMs: 0,
    partialRawFallbackParseMs: 0,
    partialRawFallbackRows: 0,
  };
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
    /**
     * Optional geometry source override used when the semantic/source cache is
     * valid but the DEV GLB cache alone must be rebuilt.  Keeping this map out
     * of AppState is intentional: a warm rebuild must not turn the lazy cache
     * hit back into a project-wide in-memory file source.
     */
    files?: Map<string, File>;
  } = {},
  dependencies?: Partial<ProgressiveGeometryDependencies>,
): Promise<ProgressiveGeometryResult> {
  const deps = { ...defaultDependencies(), ...dependencies };
  const token = options.token;
  const files = options.files ?? state.currentFiles;
  const tree = state.currentCbmTree;

  const interrupted: ProgressiveGeometryResult = {
    compiledDevs: 0,
    renderedInstances: 0,
    interrupted: true,
    failedDevs: [],
    rawFallbackDevs: [],
  };

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
    return { compiledDevs: 0, renderedInstances: 0, interrupted: false, failedDevs: [], rawFallbackDevs: [] };
  }

  // ── 1. 收集 CBM 设备实例并按唯一 DEV 分组（保持树遍历顺序）──
  const seeds = collectCbmDeviceInstances(tree);
  if (seeds.length === 0) {
    debugLog(DEBUG_IFC_LOAD, '[progressive] 无 CBM 设备实例，管线结束');
    return { compiledDevs: 0, renderedInstances: 0, interrupted: false, failedDevs: [], rawFallbackDevs: [] };
  }

  const devOrder: string[] = [];
  const seedsByDev = new Map<string, CbmNode[]>();
  for (const seed of seeds) {
    if (!seed.devPath) continue;
    const devPath = normalizeDevEntryPath(seed.devPath);
    // GIM samples mix DEV/dev casing.  Treat paths case-insensitively for
    // cache identity while retaining the first spelling for IPC/file lookup.
    const key = devPath.toLowerCase();
    const arr = seedsByDev.get(key);
    if (arr) arr.push(seed);
    else {
      seedsByDev.set(key, [seed]);
      devOrder.push(devPath);
    }
  }

  debugLog(DEBUG_IFC_LOAD, `[progressive] ${seeds.length} 个 CBM 实例 → ${devOrder.length} 个唯一 DEV，开始渐进编译`);

  const { modRoot } = ensureGeometryLayers(state, scene);
  const totalDevs = devOrder.length;
  const devGlbProfile = emptyDevGlbProfile(seeds.length, totalDevs);
  let compiledDevs = 0;
  let renderedInstances = 0;
  // P1 评审：结果追踪——只有全部 DEV 都有确定性结果（GLB 落盘成功 或 确认空几何）
  // 才写版本标记；任何失败都保持版本戳过期，下次打开自动重建
  const failedDevs: string[] = [];
  const rawFallbackDevs: string[] = [];
  const failedDevKeys = new Set<string>();
  const rawFallbackDevKeys = new Set<string>();
  const failureTypes: Record<string, DevGlbFailureType> = {};
  const glbDevKeys = new Set<string>();
  const emptyDevKeys = new Set<string>();
  let glbParseCount = 0;
  let glbParseMs = 0;
  const glbEntries: GeometryCacheManifestEntry[] = [];

  const markFailedDev = (devPath: string, needsRawFallback = false): void => {
    const key = devPath.toLowerCase();
    if (!failedDevKeys.has(key)) {
      failedDevKeys.add(key);
      failedDevs.push(devPath);
    }
    if (needsRawFallback && !rawFallbackDevKeys.has(key)) {
      rawFallbackDevKeys.add(key);
      rawFallbackDevs.push(devPath);
    }
  };
  const markGeometryFailure = (devPath: string, type: DevGlbFailureType): void => {
    const key = devPath.toLowerCase();
    if (!failureTypes[key]) failureTypes[key] = type;
    markFailedDev(devPath, true);
  };
  // A write failure makes the persisted cache incomplete, but the freshly
  // compiled bytes are still valid for this run.  Keep it out of
  // failedDevKeys so the current project renders the DEV and does not perform
  // an unnecessary raw fallback.
  const markCacheIncompleteDev = (devPath: string): void => {
    const key = devPath.toLowerCase();
    if (failedDevs.some((path) => path.toLowerCase() === key)) return;
    failedDevs.push(devPath);
  };

  const snapshotProfile = (): DevGlbFastPathProfile => {
    const failedPaths = rawFallbackDevs.slice();
    const failedInstances = failedPaths.reduce(
      (sum, path) => sum + (seedsByDev.get(path.toLowerCase())?.length ?? 0),
      0,
    );
    const failureType: Record<string, DevGlbFailureType> = {};
    for (const path of failedPaths) {
      const type = failureTypes[path.toLowerCase()];
      if (type) failureType[path] = type;
    }
    return {
      ...devGlbProfile,
      glbDevCount: glbDevKeys.size,
      emptyDevCount: emptyDevKeys.size,
      glbParseCount,
      glbParseMs,
      rawModFallbackCount: failedPaths.length,
      partialRawFallbackCount: failedPaths.length,
      partialRawFallbackInstanceCount: failedInstances,
      successfulGlbDevCount: devOrder.filter((path) =>
        glbDevKeys.has(path.toLowerCase()) && !rawFallbackDevKeys.has(path.toLowerCase()),
      ).length,
      successfulGlbInstanceCount: renderedInstances,
      fullProjectRawFallbackCount: 0,
      failureType,
      failedDevCount: failedPaths.length,
      failedDevPaths: failedPaths,
    };
  };

  const resultSnapshot = (wasInterrupted: boolean): ProgressiveGeometryResult => ({
    compiledDevs,
    renderedInstances,
    interrupted: wasInterrupted,
    failedDevs: failedDevs.slice(),
    rawFallbackDevs: rawFallbackDevs.slice(),
    devGlbProfile: snapshotProfile(),
  });

  const report = (currentDevPath?: string) =>
    onProgress({ phase: 'compiling', compiledDevs, totalDevs, renderedInstances, currentDevPath });

  report();

  // ── 2. 逐 DEV：序列化 → 落盘 → 逐实例渲染 ──
  for (const devPath of devOrder) {
    if (!isSessionValid()) {
      debugLog(DEBUG_IFC_LOAD, `[progressive] token 不匹配，中断（已编译 ${compiledDevs}/${totalDevs}）`);
      return resultSnapshot(true);
    }

    report(devPath);

    // 2.1 序列化（MOD/STL 只在此解析一次）
    let glbBytes: Uint8Array | null = null;
    let serializeFailed = false;
    try {
      glbBytes = await deps.serializeDevToGlb(devPath, files);
    } catch (err) {
      serializeFailed = true;
      markGeometryFailure(devPath, classifyDevGlbFailure(err));
      console.warn(`[progressive] DEV 序列化失败（计入失败清单，不写版本标记）: ${devPath}`, err);
    }
    if (!glbBytes || glbBytes.byteLength === 0) {
      if (!serializeFailed) {
        // 无几何引用或空几何：tombstone（确定性结果）。v3 manifest
        // 必须显式记录 empty，warm fast path 才能区分合法空结果与缓存缺失。
        if (capturedProjectId != null && isTauri()) {
          glbEntries.push({ entry_path: devPath, status: 'empty', size: 0 });
        }
        emptyDevKeys.add(devPath.toLowerCase());
        compiledDevs++;
        continue;
      }
      compiledDevs++; // 进度计数继续，但该 DEV 未获得确定性结果
      continue;
    }
    glbDevKeys.add(devPath.toLowerCase());

    // 2.2 落盘（仅 Tauri 且有 projectId；落盘前再次校验 token 防止写入错误项目）
    const persistable = capturedProjectId != null && isTauri();
    if (persistable) {
      if (!isSessionValid()) {
        debugLog(DEBUG_IFC_LOAD, `[progressive] 落盘前 token 失效，中断: ${devPath}`);
        return resultSnapshot(true);
      }
      try {
        await deps.writeGlbFile(capturedProjectId, devPath, glbBytes, session.sourceSha256);
        glbEntries.push({ entry_path: devPath, status: 'glb', size: glbBytes.byteLength });
        if (!isSessionValid()) {
          return resultSnapshot(true);
        }
      } catch (err) {
        markCacheIncompleteDev(devPath); // 渲染本次照常，但缓存完整性受损 → 不写版本标记
        console.warn(`[progressive] GLB 落盘失败（本次显示不受影响，版本标记将跳过）: ${devPath}`, err);
      }
    }

    // 2.3 逐 CBM 实例渲染。一个 DEV 是一个失败隔离域：若任一
    // placement 的 GLB 解码失败，移除该 DEV 已加入的 placement，跳过其余
    // placement，并让上层只对该 DEV 做 raw fallback。
    const devKey = devPath.toLowerCase();
    const devSeeds = seedsByDev.get(devKey)!;
    const devGroups: Array<{ instanceKey: string; group: THREE.Group }> = [];
    const disposeGroup = (group: THREE.Group): void => {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const materials = Array.isArray(mesh.material)
          ? mesh.material
          : mesh.material ? [mesh.material] : [];
        for (const material of materials) material?.dispose?.();
      });
    };
    const disposeDevGroups = (): void => {
      for (const { instanceKey, group } of devGroups) {
        modRoot.remove(group);
        state.loadedXmlModGroups.delete(instanceKey);
        disposeGroup(group);
        renderedInstances = Math.max(0, renderedInstances - 1);
      }
      devGroups.length = 0;
    };
    const hasRenderableGeometry = (group: THREE.Group): boolean => {
      let found = false;
      group.traverse((object) => {
        if (found) return;
        const mesh = object as THREE.Mesh;
        const position = mesh.geometry?.getAttribute?.('position');
        if ((mesh as THREE.Mesh).isMesh && position && position.count > 0) found = true;
      });
      return found;
    };
    for (const seed of devSeeds) {
      if (failedDevKeys.has(devKey)) continue;
      const instanceKey = `dev:${devPath}#${seed.path}`;
      if (state.loadedXmlModGroups.has(instanceKey)) continue;
      try {
        const parseStarted = performance.now();
        glbParseCount++;
        let group: THREE.Group | null = null;
        try {
          group = await deps.loadDevGlb(devPath, glbBytes);
        } finally {
          glbParseMs += Math.max(0, performance.now() - parseStarted);
        }
        if (!isSessionValid()) {
          if (group) disposeGroup(group);
          return resultSnapshot(true);
        }
        if (!group || !hasRenderableGeometry(group)) {
          if (group) disposeGroup(group);
          markGeometryFailure(devPath, group ? 'empty-scene' : 'parse-exception');
          disposeDevGroups();
          continue;
        }

        // 应用 CBM 累积矩阵（含 mm→m，与 tryDevGlbFastPath 数学一致）
        const cbmTransform = parseCbmTransformMatrix(seed.transformMatrix);
        deps.applyPlacementTransformToSceneUnits(group, cbmTransform);

        // 应用项目级坐标转换（Z-up → Y-up）
        applyProjectSourceToViewer(group, state.projectSourceToViewerMatrix);

        // bbox 守卫（空/NaN/超大跨度跳过，与现有路径一致）
        if (!diagnoseGroupBBox(group, devPath)) {
          disposeGroup(group);
          continue;
        }

        group.userData.devPath = devPath;
        modRoot.add(group);
        state.loadedXmlModGroups.set(instanceKey, group);
        devGroups.push({ instanceKey, group });
        renderedInstances++;
      } catch (err) {
        console.warn(`[progressive] DEV GLB 实例渲染失败: ${devPath} #${seed.path}`, err);
        markGeometryFailure(devPath, classifyDevGlbFailure(err));
        disposeDevGroups();
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
    return resultSnapshot(true);
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
        // The manifest is the completeness contract for the warm path. A
        // successful DEV must contribute exactly one case-insensitive entry;
        // otherwise a coding/data anomaly could publish a cache that silently
        // omits a placement source while still carrying a current version.
        const manifestKeys = new Set(glbEntries.map((entry) => normalizeDevEntryPath(entry.entry_path).toLowerCase()));
        if (glbEntries.length !== totalDevs || manifestKeys.size !== totalDevs) {
          throw new Error(
            `GLB manifest 覆盖不完整: ${manifestKeys.size}/${totalDevs} unique DEV`,
          );
        }
        await deps.writeGeometryCacheManifest(capturedProjectId, session.sourceSha256, glbEntries);
        if (!isSessionValid()) {
          return resultSnapshot(true);
        }
        await deps.writeGeometryCacheVersion(capturedProjectId!, session.sourceSha256);
        debugLog(DEBUG_IFC_LOAD, `[progressive] GLB 缓存版本标记已写入 (projectId=${capturedProjectId})`);
      } catch (err) {
        console.warn('[progressive] 写入 GLB 缓存版本标记失败:', err);
      }
    }
  }

  debugLog(DEBUG_IFC_LOAD, `[progressive] 管线完成: ${compiledDevs}/${totalDevs} DEV 编译，${renderedInstances} 实例渲染，${failedDevs.length} 失败`);
  onProgress({ phase: 'done', compiledDevs, totalDevs, renderedInstances });
  return resultSnapshot(false);
}
