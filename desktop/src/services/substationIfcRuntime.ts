import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { loadPresentation } from './presentationPort.js';
import { setSubstationViewerInteractive } from './substationLoadingState.js';
/** Sequential IFC loading, early geometry, cache profiles and background gates. */
import { setConnectionStatus, setIfcStatus as publishIfcStatus } from './presentation/shell_statusBar.js';
import type { IfcEntry, CbmNode } from '../gim/types.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import { getFileByPath } from '../gim/fileLookup.js';
import { isTauri } from '@desktop/runtime.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { SubstationBackgroundCoordinator, type SubstationBackgroundGate } from './substationBackgroundRuntime.js';
import { perfCurrentSession, perfBegin, perfMark, perfMarkProductMoment, perfRecordIfcLoadProfile } from '../utils/perfTimings.js';
import { startSubstationResourceMonitor } from './substationResourceTelemetry.js';
import { showLoading, hideLoading } from './gimOpenCore.js';
import { prioritizeIfcEntries } from './ifcLoadOrder.js';
import { resolveIfcModelId } from '../gim/modelIdentity.js';
import { autoLoadModStlPostIfc } from './substationDevRuntime.js';

import { renderSubstationCoreUi, showLoadingBeforeInteractive } from './substationPresentation.js';
import { sampleSubstationMemory } from './substationRuntimeTelemetry.js';
import {stationViewPolicy} from './stationViewPolicy.js';
import {observeFirstGeometry} from './geometryPresentationService.js';

/**
 * 获取 IFC 文件内容。
 * 1. 优先从完整解压流程的 currentFiles 读取
 * 2. 缓存命中时从 cachedIfcPaths + readCachedIfc 读取
 * 3. 找不到返回 null（调用方跳过）
 */

export async function getIfcBufferForEntry(
  entry: IfcEntry,
  state: AppState,
  session: ProjectLoadSession = state.captureProjectSession(),
): Promise<Uint8Array | null> {
  if (!state.isCurrentSession(session)) return null;
  // 1. 完整解压流程
  if (state.currentFiles) {
    const file = getFileByPath(state.currentFiles, entry.path);
    if (file) {
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用 GIM 解压内存文件:', {
        name: entry.name,
        path: entry.path,
      });
      const bytes = new Uint8Array(await file.arrayBuffer());
      return state.isCurrentSession(session) ? bytes : null;
    }
  }

  // 2. Tauri 缓存命中
  const cachedEntryPath = findCachedPath(state.cachedIfcPaths, entry.path);
  if (isTauri() && cachedEntryPath) {
    const projectId = session.projectId;
    if (projectId != null) {
      const cachePath = state.cachedIfcPaths.get(cachedEntryPath)!;
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] 使用本地 IFC 缓存:', {
        name: entry.name,
        path: entry.path,
        cachePath,
      });
      const { readCachedIfc } = await import('@desktop/database.js');
      const bytes = await readCachedIfc(projectId, cachedEntryPath);
      if (!state.isCurrentSession(session)) return null;

      // 可疑缓存定位日志：MVP 阶段用于排查缓存 IFC 是否被截断/损坏
      // IFC 文件应以 "ISO-103021;;" 文本头开头（HEX: 49 53 4F 2D 31 30 33 32 31 3B）
      // byteLength === 0 或 head 不符 → 缓存损坏，返回 null 让上层回退/报错
      const byteLength = bytes?.byteLength ?? 0;
      const head = bytes
        ? Array.from(bytes.slice(0, 32))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')
        : '';
      debugLog(DEBUG_IFC_LOAD, '[IFC Buffer] cached IFC bytes', {
        name: entry.name,
        path: entry.path,
        byteLength,
        head,
      });
      if (byteLength === 0) {
        // 缓存损坏：始终输出（非 debug），便于用户定位
        console.warn(`[IFC Buffer] 缓存 IFC 字节为空，缓存损坏: ${entry.path}`);
        return null;
      }
      // IFC 文件头 ASCII "ISO-103021;;" 前 4 字节应为 49 53 4F 2D（"ISO-"）
      // 不强制校验（部分 IFC 可能含 BOM 或前导空白），仅 warn 提示可疑
      if (
        bytes.length >= 4 &&
        !(bytes[0] === 0x49 && bytes[1] === 0x53 && bytes[2] === 0x4f && bytes[3] === 0x2d)
      ) {
        console.warn(`[IFC Buffer] 缓存 IFC 文件头非 'ISO-' 前缀，可能损坏: ${entry.path}`, { head });
      }
      return bytes;
    }
  }

  // 3. 找不到：始终输出（非 debug），便于定位
  console.warn('[IFC Buffer] 找不到 IFC 文件内容或缓存:', entry);
  return null;
}

/** cachedIfcPaths 保留磁盘/SQLite 的原始 entry_path；查找时仍按 GIM 引用规则忽略大小写和分隔符。 */
export function findCachedPath(paths: Map<string, string>, requestedPath: string): string | undefined {
  if (paths.has(requestedPath)) return requestedPath;
  const normalized = requestedPath.replace(/\\/g, '/').toLowerCase();
  for (const path of paths.keys()) {
    if (path.replace(/\\/g, '/').toLowerCase() === normalized) return path;
  }
  return undefined;
}

/**
 * 自动加载全部 IFC 文件 + MOD/STL 几何（无需弹窗选择）。
 *
 * 用于 GIM 文件打开流程：GIM 被视为一个整体，
 * 打开后直接显示所有 IFC + MOD + STL，无需用户手动选择。
 *
 * - 内部创建 ViewerRuntime（调用方无需预先持有 ctx）
 * - 同时适用于首次打开（currentFiles 非空）和缓存命中（currentFiles=null）
 *
 * @param state 全局 AppState（currentIfcEntries / currentFiles / cachedIfcPaths 必须就绪）
 * @param entries 要加载的 IFC 条目列表（全部，而非用户选择子集）
 * @param showMessage 消息回调（更新 loading 文案）
 */

export async function loadAllIfcFiles(
  state: AppState,
  entries: IfcEntry[],
  showMessage: (text: string) => void,
  options: {
    session?: ProjectLoadSession;
    ifcSourceSizes?: ReadonlyMap<string, number>;
    geometryCacheValid?: boolean;
    geometryCacheManifestValid?: boolean;
    geometryCacheVersionFileMatch?: boolean;
    /** Start optional spatial semantic only after first interactive. */
    startSpatialSemantic?: () => void | Promise<unknown>;
    /** Start STD/SLD parsing or cache restore only after first interactive. */
    startStdSld?: () => void | Promise<unknown>;
    /** Start cold cache persistence only after first interactive. */
    startCachePersistence?: () => void | Promise<unknown>;
    /** Schedule optional spatial work through the substation coordinator. */
    scheduleSpatialSemantic?: (coordinator: SubstationBackgroundCoordinator, readinessGate: SubstationBackgroundGate) => void;
    /** Schedule STD/SLD through the substation coordinator. */
    scheduleStdSld?: (coordinator: SubstationBackgroundCoordinator) => void;
    /** Schedule cold persistence through the substation coordinator. */
    scheduleCachePersistence?: (coordinator: SubstationBackgroundCoordinator, readinessGate: SubstationBackgroundGate) => void;
  } = {},
): Promise<void> {
  const openingPolicy = 'bim-lod' as const;
  const session = options.session ?? state.captureProjectSession();
  const perfSession = perfCurrentSession();
  const isCurrent = () => state.isCurrentSession(session);
  if (!isCurrent()) return;
  const background = new SubstationBackgroundCoordinator({
    session: perfSession,
    isCurrent,
    onCheckpoint: unit => perfMark('DEV safe checkpoint', { ...unit }, perfSession),
    onEvent: (event) => {
      // One compact span per lifecycle transition is enough for queue wait /
      // cancellation diagnostics; do not trace individual placements here.
      perfMark(`变电 background task · ${event.task} · ${event.state}`, {
        priority: event.priority,
        heavy: event.heavy,
        ...(event.queueWaitMs != null ? { queueWaitMs: event.queueWaitMs } : {}),
        ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
        ...(event.error ? { error: event.error } : {}),
      }, perfSession);
    },
  });
  // Keep explicit IFC precision requests on the same session-owned priority
  // lane as the background DEV/Spatial work.  The queue remains an optional
  // state capability so browser-only and legacy loader paths keep working.
  state.substationFineQueue = background;
  let devGeometryQueued = false;
  background.registerRemainingIfc();
  state.beginIfcBackgroundLoading();
  // 调试入口：从 localStorage 读取手动坐标偏移（GIM_COORD_OFFSET="dx,dy,dz"）
  // 仅作为调试功能，不写入数据库，不作为最终算法。
  // resetGimState 会清空 projectSourceToViewerMatrix，因此每次打开项目时重新解析。
  try {
    const { loadManualCoordOffsetFromLocalStorage } = await import('./coordinateAlignmentService.js');
    if (!isCurrent()) return;
    loadManualCoordOffsetFromLocalStorage(state);
  } catch {
    // 忽略：coordinateAlignmentService 不可用时不影响主流程
  }

  if (entries.length === 0) {
    // 无 IFC 但仍触发 MOD/STL 自动加载（纯 xml-mod 工程）
    await autoLoadModStlPostIfc(state, showMessage, undefined, {
      session,
      geometryCacheValid: options.geometryCacheValid,
      geometryCacheManifestValid: options.geometryCacheManifestValid,
      geometryCacheVersionFileMatch: options.geometryCacheVersionFileMatch,
    });
    return;
  }

  showLoading('正在加载 3D 引擎...');
  const endEngine = perfBegin('3D 引擎创建', undefined, perfSession);
  const { getViewerRuntimeWithUI } = await import('./viewerUIBinding.js');
  if (!isCurrent()) return;
  const runtime = await getViewerRuntimeWithUI(state, showMessage);
  if (!isCurrent()) return;
  const { ctx, modelCallbacks } = runtime;
  startSubstationResourceMonitor(state, ctx);
  // Connection previews are additive and session-owned.  They are fed by the
  // IFC conversion worker's source-type batches and disappear as soon as the
  // authoritative Fragments model for that IFC is ready.
  const { IfcConnectionPreviewRuntime } = await import('../viewer/ifcConnectionPreviewRuntime.js');
  const connectionPreview = new IfcConnectionPreviewRuntime(
    ctx,
    session,
    isCurrent,
  );
  state.substationConnectionPreview = connectionPreview;
  void import('./connectionOwnershipService.js').then(({ prepareConnectionOwnership }) => {
    if (isCurrent()) return prepareConnectionOwnership(state, session);
  }).catch(error => { if (isCurrent()) console.warn('[Connection source evidence]', error); });
  void Promise.resolve(state.selectionVisibility?.sync().catch(error => console.warn('[Selection visibility]', error))).catch(reportBackgroundError);
  const connectionFirstBatches = new Set<string>();
  const connectionCompletions = new Set<string>();
  const updateConnectionStatus = (): void => {
    const d = connectionPreview.diagnostics;
    if (d.objects === 0 && d.batches === 0 && d.partialModels === 0) {
      setConnectionStatus('');
      return;
    }
    const completed = d.readyModels > 0 ? ` · ${d.readyModels} 个来源三维就绪` : ' · 增量加载中';
    const partial = d.partialModels > 0 ? ` · 部分 ${d.partialModels}` : '';
    setConnectionStatus(`连接构件 ${d.objects} 个${completed}${partial}`);
  };
  if (state.projectSourceToViewerMatrix) connectionPreview.setTransform?.(state.projectSourceToViewerMatrix);
  state.stationOverview = () => {
    if (!state.isCurrentSession(session) || state.currentProjectType === 'transmission_line') return;
    state.cameraNavigationVersion++;
    void Promise.resolve(import('../viewer/camera.js').then(({ fitCameraToStationOverview }) => {
      if (state.isCurrentSession(session)) fitCameraToStationOverview(ctx, state, { force: true,...stationViewPolicy(state) });
    })).catch(reportBackgroundError);
  };
  endEngine();

  // DEV templates are local, independent of the first IFC's coordinate anchor.
  // Start their bounded worker pool now; the LOD owner delays scene commit.
  if (state.currentProjectType === 'substation' && typeof Worker !== 'undefined') {
    const { startDeviceLod } = await import('./devLodRuntime.js');
    if (!isCurrent()) return;
    void startDeviceLod(state, ctx, session, (text, detail) => {
      if (isCurrent()) void Promise.resolve(loadPresentation('shell_statusBar').then(({ setDeviceStatus }) => {
        if (isCurrent()) setDeviceStatus(text, detail);
      })).catch(reportBackgroundError);
    }).catch(error => { if (isCurrent()) console.warn('[DEV startup]', error); });
  }

  showLoading('正在加载 IFC 模型...');
  const failed: Array<{ name: string; message: string }> = [];
  let interactiveInitialized = false;
  setSubstationViewerInteractive(false);
  let interactiveSignaled = false;
  let resolveInteractive!: () => void;
  let rejectInteractive!: (reason?: unknown) => void;
  const interactiveReady = new Promise<void>((resolve, reject) => {
    resolveInteractive = resolve;
    rejectInteractive = reject;
  });
  const signalInteractive = (): void => {
    if (interactiveSignaled) return;
    interactiveSignaled = true;
    resolveInteractive();
  };

  const syncCoordinateAnchor = async (label: string): Promise<void> => {
    if (!isCurrent() || state.projectSourceToViewerMatrix) return;
    const endCoordinate = perfBegin(label, undefined, perfSession);
    try {
      const { syncProjectSourceToViewerFromFragments } = await import('./coordinateAlignmentService.js');
      if (!isCurrent()) return;
      await syncProjectSourceToViewerFromFragments(state, ctx.fragments, { session });
      if (!isCurrent()) return;
      if (state.projectSourceToViewerMatrix) connectionPreview.setTransform?.(state.projectSourceToViewerMatrix);
      endCoordinate(undefined, {
        hasMatrix: state.projectSourceToViewerMatrix != null,
      });
    } catch (err) {
      endCoordinate('（失败）', { error: err instanceof Error ? err.message : String(err) });
      if (isCurrent()) {
        console.warn('[CoordAlign] IFC 基准坐标同步失败，MOD/STL 将使用原始坐标或手工 offset:', err);
      }
    }
  };

  /**
   * 变电默认视角为整站远景全景：首个 IFC 就绪时先给一个概览，等其余 IFC
   * 与设备目录补齐后再校正一次；用户一旦手动操作相机就不再自动改。
   */
  const trackCameraInteraction = (): void => {
    const canvas = (ctx.world.renderer as unknown as { domElement?: HTMLCanvasElement })?.domElement;
    const marked = canvas as (HTMLCanvasElement & { __gimCameraTracking?: boolean }) | undefined;
    if (!canvas || marked?.__gimCameraTracking) return;
    if (marked) marked.__gimCameraTracking = true;
    const mark = (): void => { state.viewerUserInteracted = true; };
    for (const eventName of ['pointerdown', 'wheel', 'touchstart'] as const) {
      canvas.addEventListener(eventName, mark, { passive: true });
    }
  };
  const scheduleStationOverviewRefit = (): void => {
    // 首个 IFC 只覆盖建筑的一部分；全站 IFC/设备是陆续进入场景的。在冷/暖
    // 加载窗口内补做几次全景（用户一旦操作相机或选择对象就停止），避免默认
    // 视角停在“只看得到一栋建筑”的近景。
    for (const delay of [1500, 5000, 12000]) {
      window.setTimeout(() => {
        if (!isCurrent() || state.viewerUserInteracted || state.selectionRequest?.target) return;
        void Promise.resolve(import('../viewer/camera.js').then(({ fitCameraToStationOverview }) => {
          if (!isCurrent() || state.viewerUserInteracted || state.selectionRequest?.target) return;
          fitCameraToStationOverview(ctx, state, { force: true,...stationViewPolicy(state) });
        })).catch(reportBackgroundError);
      }, delay);
    }
  };

  const initializeInteractiveAfterFirstIfc = async (
    entry: IfcEntry,
    loadSource: 'lod-cache' | 'ifc' | 'unknown',
  ): Promise<void> => {
    if (interactiveInitialized || !isCurrent()) return;
    await syncCoordinateAnchor('变电 coordinate alignment（首个 IFC）');
    if (!isCurrent()) return;

    await renderSubstationCoreUi(state, (text) => showLoadingBeforeInteractive(text), session, perfSession, '变电 navigation/UI（首个 IFC）');
    if (!isCurrent()) return;

    const { fitCameraToStationOverview } = await import('../viewer/camera.js');
    if (!isCurrent()) return;
    // 变电默认打开为整站远景全景，不再恢复上次相机；层级树展开状态仍恢复。
    const { restoreTreeState } = await import('./viewStateStore.js');
    restoreTreeState(state);
    if (!isCurrent()) return;
    if (!state.selectionRequest?.target && !state.viewerUserInteracted) {
      trackCameraInteraction();
      fitCameraToStationOverview(ctx, state, stationViewPolicy(state));
      scheduleStationOverviewRefit();
    }
    interactiveInitialized = true;
    perfMark('首个 IFC 就绪', {
      name: entry.name,
      source: loadSource,
      cacheHit: loadSource === 'lod-cache',
    }, perfSession);
    const firstMeta = {
      kind: 'ifc',
      name: entry.name,
      source: loadSource,
      cacheHit: loadSource === 'lod-cache',
      coordinateAnchor: state.projectSourceToViewerMatrix != null,
      loadedModels: state.loadedModels.size,
    };
    perfMarkProductMoment('firstUsableGeometryReady', firstMeta, perfSession);
    const runtimeId=state.ifcRuntimeModelIds.get(entry.modelId)??entry.modelId;
    const object=ctx.fragments.list.get(runtimeId)?.object;
    const startPostInteractiveTask = (
      label: string,
      starter?: () => void | Promise<unknown>,
      scheduler?: (coordinator: SubstationBackgroundCoordinator, gate: SubstationBackgroundGate) => void,
    ): void => {
      if (!starter && !scheduler) return;
      try {
        // All three starters are deliberately invoked only after the
        // interactive product moment.  They are independent background
        // tasks; one synchronous registration failure must not suppress the
        // other tasks or the sequential IFC tail.
        if (scheduler) scheduler(background, 'allIfcReady');
        else void Promise.resolve(starter?.()).catch(reportBackgroundError);
      } catch (err) {
        console.warn(`[GIM] 启动${label}失败，继续 IFC 后台加载:`, err);
      }
    };
    if(object)void observeFirstGeometry(state,ctx,object,session,()=>{
      if(!isCurrent())return;setSubstationViewerInteractive(true);hideLoading();
      perfMark('变电工程首次实体画面已提交',firstMeta,perfSession);
      void Promise.resolve(sampleSubstationMemory(state,'interactive',perfSession,firstMeta,ctx)).catch(reportBackgroundError);
      // Give the submitted model frame a paint opportunity before optional
      // synchronous work. No GPU completion fence or readback is used.
      const start=()=>{
        if(!isCurrent())return;background.markInteractive();
        startPostInteractiveTask('IFC 空间语义',options.startSpatialSemantic,options.scheduleSpatialSemantic);
        startPostInteractiveTask('STD/SLD',options.startStdSld,options.scheduleStdSld);
        startPostInteractiveTask('缓存持久化',options.startCachePersistence,options.scheduleCachePersistence);
        void import('../viewer/ifcNameIndex.js').then(async({buildIfcNameIndex})=>{
          if(!isCurrent())return;await buildIfcNameIndex(ctx,state,{session});
          if(isCurrent())await renderSubstationCoreUi(state,showMessage,session,perfSession,'变电 IFC 名称补全');
        }).catch(reportBackgroundError);
      };
      if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>setTimeout(start,0));else setTimeout(start,0);
    },perfSession).catch(reportBackgroundError);
    signalInteractive();
    // Keep the IFC tail and DEV anchor live even if the first IFC is empty.
    // Optional CPU/serialization work starts only after a model draw.
    background.startRemainingIfc();
    if (state.projectSourceToViewerMatrix) {
      background.markCoordinateAnchorReady();
      state.deviceLodRuntime?.notifyCoordinateAnchor?.();
      enqueueDevGeometry('coordinateAnchorReady');
    }
  };

  const enqueueDevGeometry = (startAfter: SubstationBackgroundGate = 'allIfcReady'): void => {
    if (devGeometryQueued) return;
    devGeometryQueued = background.enqueue({
      task: 'devGeometry',
      priority: 2,
      heavy: false, // Reuses the already running, bounded DEV pool.
      startAfter,
      run: async () => {
        state.geometryLoadToken++;
        const token = state.geometryLoadToken;
        try {
          await autoLoadModStlPostIfc(state, showMessage, ctx, {
            onDevCheckpoint: unit => background.servicePendingUserFineAtCheckpoint(unit),
            token,
            includeMod: true,
            includeStl: false,
            session,
            geometryCacheValid: options.geometryCacheValid,
            geometryCacheManifestValid: options.geometryCacheManifestValid,
            geometryCacheVersionFileMatch: options.geometryCacheVersionFileMatch,
          });
        } catch (err) {
          console.warn('[GIM] 后台 MOD 加载失败:', err);
        }
      },
    });
  };

  const ifcSources = new Map<string, string>();
  const ifcStages = new Map<string, string>();
  let activeIfcPath = '';
  let ifcLifecycleSettled = false;
  const cacheWriteFailures = new Set<string>();
  const setIfcStatus = (text:string) => { if(isCurrent()&&!ifcLifecycleSettled)publishIfcStatus(text); };
  const ifcCacheProgress = () => {
    const cold = [...ifcSources.values()].filter(source => source === 'ifc').length;
    const lod = [...ifcSources.values()].filter(source => source === 'lod-cache').length;
    return `冷转换 ${cold} · LOD缓存 ${lod}`;
  };
  const ifcStatus = (entry: IfcEntry, index: number, total: number, extra = '') => {
    const skipped = state.ifcSkippedLargeIfc.length;
    return `IFC ${index + 1}/${total} · ${entry.name} · ${ifcStages.get(entry.path) ?? '待检查'}${extra ? ` · ${extra}` : ''} · ${ifcCacheProgress()}${skipped ? ` · 已跳过 ${skipped} 个超大 IFC` : ''}`;
  };
  const ifcStageLabels: Record<string, string> = { 'checking-cache': '查询LOD缓存', 'lod-cache-hit': 'LOD缓存命中', 'cold-convert': '冷转换中', 'far-ready': '远景就绪', 'cache-write-start': '缓存写入中', 'cache-written': '缓存已写', 'cache-write-failed': '远景就绪(缓存写入失败)' };
  const publishTerminalStatus = () => {
    if(isCurrent())publishIfcStatus(`IFC 已结束 · 已加载 ${state.loadedModels.size}/${entries.length} · ${ifcCacheProgress()}${failed.length ? ` · 失败 ${failed.length}` : ''}${state.ifcSkippedLargeIfc.length ? ` · 已跳过 ${state.ifcSkippedLargeIfc.length} 个超大 IFC` : ''}${cacheWriteFailures.size ? ` · 缓存写入失败 ${cacheWriteFailures.size}` : ''}`);
  };
  const lifecycleTask = (async (): Promise<void> => {
    try {
      const { ensureEngineReady } = await import('../viewer/ifcLoader.js');
      if (!isCurrent()) return;
      const endEngineInit = perfBegin('web-ifc / Fragments engine 初始化', undefined, perfSession);
      await ensureEngineReady(ctx, state, modelCallbacks);
      if (!isCurrent()) return;
      endEngineInit(undefined, { initialized: true });
      const { loadIfcEntry } = await import('../viewer/ifcEntryLoader.js');
      if (!isCurrent()) return;

      let firstIfcLoadStarted = false;
      const sizes = new Map(options.ifcSourceSizes);
      for (const entry of entries) {
        const file = state.currentFiles && getFileByPath(state.currentFiles, entry.path);
        if (file) sizes.set(entry.path.toLowerCase(), file.size);
      }
      const queue = [...entries];
      // 超大 IFC（如 452 MB 的设备接线）冷转换可能需要数分钟；默认允许后台
      // 长转换并排到队尾。设置里可显式跳过这类非关键文件，跳过后在状态栏和
      // 控制台列出，绝不静默丢弃。
      const { shouldSkipLargeIfc, LARGE_IFC_BYTES } = await import('./appSettings.js');
      const skippedLargeIfc: Array<{ path: string; bytes: number }> = [];
      const { isRegionalConnectionObject } = await import('../viewer/ifcRegionalData.js');
      const evidencedConnections = new Set<string>();
      const visitConnectionEvidence = (node: CbmNode): void => {
        if (node.ifcFile && node.ifcGuid && isRegionalConnectionObject({
expressId: 0, globalId: node.ifcGuid,
          ifcType: 'IFCBUILDINGELEMENTPROXY', name: node.name, bounds: []
})) {
          const id = resolveIfcModelId(node.ifcFile, entries);
          if (id) evidencedConnections.add(id);
        }
        node.children.forEach(visitConnectionEvidence);
      };
      if (state.currentCbmTree) visitConnectionEvidence(state.currentCbmTree);
      const isConnectionIfc = (entry: IfcEntry): boolean =>
        evidencedConnections.has(entry.modelId) || /接线|连接线|软导|导线|wire|cable/i.test(`${entry.name} ${entry.path}`);
      if (shouldSkipLargeIfc() && queue.length > 1) {
        for (let index = queue.length - 1;index >= 1;index--) {
          // Connection-line IFC is the only source of those lines for some
          // substations; never silently skip it by size.
          if (isConnectionIfc(queue[index])) continue;
          const bytes = sizes.get(queue[index].path.toLowerCase()) ?? 0;
          if (bytes <= LARGE_IFC_BYTES) continue;
          skippedLargeIfc.push({ path: queue[index].path, bytes });
          queue.splice(index, 1);
        }
        if (skippedLargeIfc.length > 0) {
          console.warn('[IFC] 已按设置跳过超大文件:', skippedLargeIfc);
          perfMark('IFC 跳过超大文件', { skipped: skippedLargeIfc }, perfSession);
        }
      }
      state.ifcSkippedLargeIfc = skippedLargeIfc.map((row) => row.path);
      const connectionEntries = queue.filter(isConnectionIfc);
      queue.splice(0, queue.length, ...prioritizeIfcEntries(queue, sizes, new Set(connectionEntries.map(entry => entry.modelId))));
      if (connectionEntries.length) {
        perfMark('IFC 连接线优先', {
          order: queue.slice(0, 4).map((entry) => entry.path),
          evidencedModels: [...evidencedConnections],
          anchorPreserved: queue[0]?.modelId === entries[0]?.modelId,
        }, perfSession);
      }
      for (let queueIndex = 0;queueIndex < queue.length;queueIndex++) {
        if (!isCurrent()) return;
        const entry = queue[queueIndex];
        activeIfcPath = entry.path;
        ifcStages.set(entry.path, ifcStageLabels['checking-cache']);
        setIfcStatus(ifcStatus(entry, queueIndex, queue.length));
        // After the first IFC the viewport and bottom status bar are the
        // source of truth; do not cover them with the center loading pill.
        if (!interactiveInitialized) showLoading(`正在加载 ${entry.name}...`);
        let readEnded = false;
        let readProfiled = false;
        let lastIfcReadByteLength = 0;
        let loadEnded = false;
        const loadSource: { value: 'lod-cache' | 'ifc' | 'unknown' } = { value: 'unknown' };
        const setIfcStage = (stage: string, meta?: Record<string, unknown>) => {
          if (!isCurrent()) return;
          if(stage==='cache-write-failed')cacheWriteFailures.add(entry.path);
          if(stage==='cache-written')cacheWriteFailures.delete(entry.path);
          if(ifcLifecycleSettled){
            if(stage==='cache-write-failed'||stage==='cache-written')publishTerminalStatus();
            return;
          }
          ifcStages.set(entry.path, (ifcStageLabels[stage] ?? stage) + (meta?.phase ? ` · ${String(meta.phase)}` : ''));
          if (activeIfcPath === entry.path) setIfcStatus(ifcStatus(entry, queueIndex, queue.length, meta?.ms != null ? `${String(meta.ms)}ms` : ''));
        };
        const statusStarted = performance.now();
        const statusTimer = setInterval(() => {
          if (isCurrent() && !ifcLifecycleSettled && activeIfcPath === entry.path) setIfcStatus(ifcStatus(entry, queueIndex, queue.length,
            `${Math.round((sizes.get(entry.path.toLowerCase()) ?? 0) / 1048576)} MiB · ${Math.floor((performance.now() - statusStarted) / 1000)}秒`));
        }, 1000);
        const endRead = perfBegin(`变电 IFC read · ${entry.path}`, undefined, perfSession);
        const endIfcLoad = perfBegin(`变电 web-ifc / Fragments load · ${entry.path}`, undefined, perfSession);
        try {
          if (!firstIfcLoadStarted) {
            firstIfcLoadStarted = true;
            perfMarkProductMoment('firstIfcLoadStart', {
              name: entry.name,
              path: entry.path,
            }, perfSession);
          }
          const ifcBytes: { value: Uint8Array | null } = { value: null };
          const readBytes = async (): Promise<Uint8Array | null> => {
            ifcBytes.value = await getIfcBufferForEntry(entry, state, session);
            if (!isCurrent()) return null;
            lastIfcReadByteLength = ifcBytes.value?.byteLength ?? 0;
            const readMeta = { bytes: ifcBytes.value?.byteLength ?? 0, source: state.currentFiles ? 'extracted' : 'disk-cache', found: ifcBytes.value != null };
            if (!readProfiled) { endRead(undefined, readMeta); readProfiled = true; }
            readEnded = true;
            return ifcBytes.value;
          };
          let finePromise: Promise<void> | null = null;
          const loadFine = (): Promise<void> => {
            if (finePromise) return finePromise;
            const task = loadIfcEntry(ctx, state, entry, readBytes,
              (p) => { if (isCurrent()&&!ifcLifecycleSettled) { setIfcStatus(ifcStatus(entry, queueIndex, queue.length, `${Math.round(p * 100)}%`)); if (!interactiveInitialized) showLoading(`${entry.name}: ${Math.round(p * 100)}%`); } },
              {
session, perfSessionId: perfSession.id, onLoadSource: (source) => { if(!isCurrent()||ifcLifecycleSettled)return;setSubstationViewerInteractive(true); loadSource.value = source; ifcSources.set(entry.path, source); ifcStages.set(entry.path, source === 'ifc' ? '冷转换完成' : source === 'lod-cache' ? 'LOD缓存恢复完成' : '完整缓存恢复完成'); },
                onStage: (stage, meta) => setIfcStage(stage, meta),
                onProfile: (profile) => { if (isCurrent()) perfRecordIfcLoadProfile(profile, perfSession); },
                onRegionalBatch: (batch) => {
                  if (isCurrent()) {
                    const accepted = connectionPreview.acceptBatch({
                      ...batch,
                      modelId: entry.modelId,
                      sourcePath: entry.path,
                      sourceIdentity: session.sourceSha256 ?? `session:${session.generation}`,
                      coordinateBasis: 'ifc-y-up-m',
                    });
                    if (accepted && !connectionFirstBatches.has(entry.modelId)
                      && batch.chunks?.some(chunk => chunk.vertices.length > 0)) {
                      connectionFirstBatches.add(entry.modelId);
                      perfMark('IFC connection preview first batch', {
                        modelId: entry.modelId,
                        entryPath: entry.path,
                        sequence: batch.sequence,
                        objects: batch.objects.length,
                        bytes: batch.bytes,
                        source: 'stream',
                      }, perfSession);
                    }
                    updateConnectionStatus();
                  }
                },
                onRegionalComplete: (meta) => {
                  if (isCurrent()) {
                    connectionPreview.markComplete(entry.modelId, meta);
                    if (!connectionCompletions.has(entry.modelId)) {
                      connectionCompletions.add(entry.modelId);
                      perfMark('IFC connection preview settled', {
                        modelId: entry.modelId,
                        entryPath: entry.path,
                        objectCount: meta.objectCount,
                        sequence: meta.sequence,
                        source: 'regional-index-complete',
                      }, perfSession);
                    }
                    updateConnectionStatus();
                  }
                },
                transferInput: true, openingPolicy
});
            const wrapped = task.catch(error => {
              if (finePromise === wrapped) { ifcBytes.value = null; readEnded = false; finePromise = null; }
              throw error;
            });
            finePromise = wrapped;
            return wrapped;
          };
          await loadFine();
          if (!isCurrent()) return;
          connectionPreview.markModelReady(entry.modelId, state.ifcRegionalRuntimes.get(entry.modelId)?.index.objects);
          updateConnectionStatus();
          if (!readEnded) {
            // 浏览 LOD 缓存命中时不会调用 getIfcBuffer；显式记录“未读取 IFC”。
            if (!readProfiled) endRead(undefined, {
              bytes: 0,
              source: 'not-read',
              found: false,
            });
            readEnded = true;
          }
          endIfcLoad(undefined, {
            bytes: lastIfcReadByteLength,
            source: loadSource.value,
            cacheHit: loadSource.value === 'lod-cache',
          });
          loadEnded = true;
          ifcStages.set(entry.path, loadSource.value === 'ifc' ? '冷转换完成' : 'LOD缓存恢复完成');
          setIfcStatus(ifcStatus(entry, queueIndex, queue.length));
          ifcBytes.value = null;
          const runtimeModelId = state.ifcRuntimeModelIds.get(entry.modelId) ?? entry.modelId;
          const usable = state.loadedModels.has(entry.modelId) && ctx.fragments.list.has(runtimeModelId);
          if (usable && !interactiveInitialized) {
            await initializeInteractiveAfterFirstIfc(entry, loadSource.value);
            if (!isCurrent()) return;
          }
        } catch (err) {
          if (!readEnded) {
            endRead('（失败）', { source: loadSource.value, error: err instanceof Error ? err.message : String(err) });
            readEnded = true;
          }
          if (!loadEnded) {
            endIfcLoad('（失败）', {
              source: loadSource.value,
                cacheHit: loadSource.value === 'lod-cache',
              error: err instanceof Error ? err.message : String(err),
            });
            loadEnded = true;
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error('[GIM] IFC 加载失败:', entry, err);
          // IFC 加载可能在工程切换后才 reject；不要让旧工程继续进入
          // 后续坐标同步、名称索引或 UI 渲染阶段。
          if (!isCurrent()) return;
          connectionPreview.markFailed?.(entry.modelId);
          updateConnectionStatus();
          ifcStages.set(entry.path, '失败');
          setIfcStatus(ifcStatus(entry, queueIndex, queue.length, message.slice(0, 80)));
          failed.push({ name: entry.name, message });
          // 防御性清理
          try {
            const modelId = entry.modelId;
            const runtimeModelId = state.ifcRuntimeModelIds.get(modelId) ?? modelId;
            if (ctx.fragments.list.has(runtimeModelId)) {
              void Promise.resolve(ctx.fragments.core.disposeModel(runtimeModelId)).catch(reportBackgroundError);
            }
            state.loadedModels.delete(modelId);
            const modelRow = document.getElementById(`model-${modelId}`)
              ?? document.getElementById(`model-${runtimeModelId}`);
            if (modelRow) modelRow.remove();
          } catch (cleanupErr) {
            console.warn('[GIM] cleanup failed model after load error', entry, cleanupErr);
          }
          continue;
        } finally { clearInterval(statusTimer); }
      }
      activeIfcPath = '';

      // A first usable IFC normally establishes the coordinate anchor.  Retry
      // once after the sequential tail only when that first attempt had no
      // usable Fragments base; this retry is a diagnostic fallback, not an
      // interactive barrier.
      if (!state.projectSourceToViewerMatrix) {
        await syncCoordinateAnchor('变电 coordinate alignment（all IFC fallback）');
        if (!isCurrent()) return;
      }

      ifcLifecycleSettled = true;
      publishTerminalStatus();
      background.completeRemainingIfc();
      state.endIfcBackgroundLoading();
      enqueueDevGeometry();
      background.markAllIfcReady();
      perfMarkProductMoment('allIfcReady', {
total: entries.length, loaded: state.loadedModels.size,
        failed: failed.length, firstInteractive: interactiveInitialized
}, perfSession);
      void Promise.resolve(sampleSubstationMemory(state, 'allIfcReady', perfSession, { total: entries.length, loaded: state.loadedModels.size, failed: failed.length }, ctx)).catch(reportBackgroundError);

      // buildIfcNameIndex 失败不应阻断 UI 渲染
      const { buildIfcNameIndex } = await import('../viewer/ifcNameIndex.js');
      if (!isCurrent()) return;
      state.engineeringIfcGeometryFinished = true;
      state.engineeringGeometryEvidenceChanged?.();
      const endNameIndex = perfBegin('变电 IFC name index', undefined, perfSession);
      await buildIfcNameIndex(ctx, state, { session }).catch((err) => {
        console.warn('[GIM] buildIfcNameIndex failed', err);
      });
      if (!isCurrent()) return;
      endNameIndex(undefined, { models: state.loadedModels.size });

      if (!interactiveInitialized && state.loadedModels.size > 0) {
        // Defensive fallback for a loader that populated state without the
        // usual first-model event.  Normal IFC paths initialize above.
        const firstLoaded = entries.find((entry) => state.loadedModels.has(entry.modelId));
        if (firstLoaded) await initializeInteractiveAfterFirstIfc(firstLoaded, 'unknown');
        if (!isCurrent()) return;
      }
      await renderSubstationCoreUi(state, (text) => showLoadingBeforeInteractive(text), session, perfSession, '变电 navigation/UI（all IFC）');
      if (!isCurrent()) return;
      // Keep the heavy post-IFC lane behind the final name-index/UI pass.  The
      // allIfcReady product moment is already recorded above, but releasing the
      // coordinator here avoids DEV geometry or a spatial rebuild competing with
      // the last mandatory UI bookkeeping.
      background.markAllIfcReady();

    } catch (err) {
      if (!isCurrent()) return;
      state.engineeringIfcGeometryFinished = true; state.engineeringGeometryEvidenceChanged?.();
      console.error('[GIM] IFC 加载失败 (outer)', {
        error: err,
        message: err instanceof Error ? err.message : String(err),
      });
      showLoading(`IFC 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => { if (isCurrent()) hideLoading(); }, 3000);
      if (!interactiveSignaled) rejectInteractive(err);
      return;
    }

    // Interactive is reached after the first usable IFC.  The sequential tail
    // may still have failed entries, but it must no longer own the first-use
    // loading barrier.
    if (failed.length > 0) {
      showLoading(`部分 IFC 加载失败：${failed.length}/${entries.length}，详见控制台`);
      setTimeout(() => { if (isCurrent()) hideLoading(); }, 4000);
    } else {
      hideLoading();
    }

  })();

  // The first usable IFC is the caller-visible readiness boundary. The
  // sequential IFC tail and post-IFC geometry continue under the same
  // session/token guards after this promise resolves.
  void lifecycleTask.finally(() => {
    ifcLifecycleSettled = true; activeIfcPath = '';
    publishTerminalStatus();
    // If every IFC failed (or the session became stale) there is no usable
    // geometry event to signal. Release the caller rather than leaving an
    // unresolved readiness promise behind.
    if (!interactiveSignaled) signalInteractive();
  }).catch(() => undefined);

  try {
    await interactiveReady;
  } catch {
    return;
  }
}
