import { projectPresentation } from './projectPresentationPort.js';
import * as statusPresentation from './presentation/shell_statusBar.js';
import { reportBackgroundError } from '../utils/backgroundErrors.js';

import { setSubstationViewerInteractive } from './substationLoadingState.js';
/** Sequential IFC loading, early geometry, cache profiles and background gates. */
import {
  setConnectionStatus,
  setIfcStatus as publishIfcStatus,
} from './presentation/shell_statusBar.js';
import type { IfcEntry } from '../gim/types.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import { getFileByPath } from '../gim/fileLookup.js';
import { logger } from '../utils/logger.js';
import {
  SubstationBackgroundCoordinator,
  type SubstationBackgroundGate,
} from './substationBackgroundRuntime.js';
import {
  perfCurrentSession,
  perfBegin,
  perfMark,
  perfMarkProductMoment,
  perfRecordIfcLoadProfile,
} from '../utils/perfTimings.js';
import { startSubstationResourceMonitor } from './substationResourceTelemetry.js';
import { showLoading, hideLoading } from './gimOpenCore.js';
import { planSubstationIfcLoad } from './ifcLoadOrder.js';
import { autoLoadModStlPostIfc } from './substationDevRuntime.js';

import { renderSubstationCoreUi, showLoadingBeforeInteractive } from './substationPresentation.js';
import { sampleSubstationMemory } from './substationRuntimeTelemetry.js';
import { stationViewPolicy } from './stationViewPolicy.js';
import { observeFirstGeometry } from './geometryPresentationService.js';
import { getIfcBufferForEntry } from './substationIfcSource.js';

const trackedIfcCanvases = new WeakSet<HTMLCanvasElement>();

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
    /** Start optional spatial semantic only after first interactive. */
    startSpatialSemantic?: () => void | Promise<unknown>;
    /** Start STD/SLD parsing or cache restore only after first interactive. */
    startStdSld?: () => void | Promise<unknown>;
    /** Start cold cache persistence only after first interactive. */
    startCachePersistence?: () => void | Promise<unknown>;
    /** Schedule optional spatial work through the substation coordinator. */
    scheduleSpatialSemantic?: (
      coordinator: SubstationBackgroundCoordinator,
      readinessGate: SubstationBackgroundGate,
    ) => void;
    /** Schedule STD/SLD through the substation coordinator. */
    scheduleStdSld?: (
      coordinator: SubstationBackgroundCoordinator,
      gate?: SubstationBackgroundGate,
    ) => void;
    /** Schedule cold persistence through the substation coordinator. */
    scheduleCachePersistence?: (
      coordinator: SubstationBackgroundCoordinator,
      readinessGate: SubstationBackgroundGate,
    ) => void;
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
    onCheckpoint: (unit) => perfMark('DEV safe checkpoint', { ...unit }, perfSession),
    onEvent: (event) => {
      // One compact span per lifecycle transition is enough for queue wait /
      // cancellation diagnostics; do not trace individual placements here.
      perfMark(
        `变电 background task · ${event.task} · ${event.state}`,
        {
          priority: event.priority,
          heavy: event.heavy,
          ...(event.queueWaitMs != null ? { queueWaitMs: event.queueWaitMs } : {}),
          ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
          ...(event.error ? { error: event.error } : {}),
        },
        perfSession,
      );
    },
  });
  // Keep explicit IFC precision requests on the same session-owned priority
  // lane as the background DEV/Spatial work.  The queue remains an optional
  // state capability so browser-only and legacy loader paths keep working.
  state.substationFineQueue = background;
  let devGeometryQueued = false;
  background.registerRemainingIfc();
  state.ifcLoading.pending = true;
  // 调试入口：从 localStorage 读取手动坐标偏移（GIM_COORD_OFFSET="dx,dy,dz"）
  // 仅作为调试功能，不写入数据库，不作为最终算法。
  // resetGimState 会清空 projectSourceToViewerMatrix，因此每次打开项目时重新解析。
  try {
    const { loadManualCoordOffsetFromLocalStorage } =
      await import('./coordinateAlignmentService.js');
    if (!isCurrent()) return;
    loadManualCoordOffsetFromLocalStorage(state);
  } catch {
    // 忽略：coordinateAlignmentService 不可用时不影响主流程
  }

  if (entries.length === 0) {
    // 无 IFC 但仍触发 MOD/STL 自动加载（纯 xml-mod 工程）
    await autoLoadModStlPostIfc(state, showMessage, undefined, { session });
    return;
  }

  showLoading('正在加载 3D 引擎...');
  const endEngine = perfBegin('3D 引擎创建', undefined, perfSession);
  const [{ getViewerRuntimeWithUI }, { IfcConnectionPreviewRuntime }] = await Promise.all([
    import('./viewerUIBinding.js'),
    import('../viewer/ifcConnectionPreviewRuntime.js'),
  ]);
  if (!isCurrent()) return;
  const runtime = await getViewerRuntimeWithUI(state, showMessage);
  if (!isCurrent()) return;
  const { ctx, modelCallbacks } = runtime;
  startSubstationResourceMonitor(state, ctx);
  // Connection previews are additive and session-owned.  They are fed by the
  // IFC conversion worker's source-type batches and disappear as soon as the
  // authoritative Fragments model for that IFC is ready.
  const connectionPreview = new IfcConnectionPreviewRuntime(ctx, session, isCurrent);
  state.substationConnectionPreview = connectionPreview;
  void import('./connectionOwnershipService.js')
    .then(({ prepareConnectionOwnership }) => {
      if (isCurrent()) return prepareConnectionOwnership(state, session);
    })
    .catch((error) => {
      if (isCurrent()) logger.warn('[Connection source evidence]', error);
    });
  void Promise.resolve(
    state.selection.selectionVisibility
      ?.sync()
      .catch((error) => logger.warn('[Selection visibility]', error)),
  ).catch(reportBackgroundError);
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
  if (state.projectSourceToViewerMatrix)
    connectionPreview.setTransform?.(state.projectSourceToViewerMatrix);
  state.viewState.stationOverview = () => {
    if (!state.isCurrentSession(session) || state.currentProjectType === 'transmission_line')
      return;
    state.viewState.cameraNavigationVersion++;
    void Promise.resolve(
      import('../viewer/camera.js').then(({ fitCameraToStationOverview }) => {
        if (state.isCurrentSession(session))
          fitCameraToStationOverview(ctx, state.viewState, {
            force: true,
            ...stationViewPolicy(state),
          });
      }),
    ).catch(reportBackgroundError);
  };
  endEngine();

  // DEV templates are local, independent of the first IFC's coordinate anchor.
  // Start their bounded worker pool now; the LOD owner delays scene commit.
  if (state.currentProjectType === 'substation' && typeof Worker !== 'undefined') {
    const { startDeviceLod } = await import('./devLodRuntime.js');
    if (!isCurrent()) return;
    void startDeviceLod(state, ctx, session, (text, detail) => {
      if (isCurrent())
        void Promise.resolve(
          Promise.resolve(statusPresentation).then(({ setDeviceStatus }) => {
            if (isCurrent()) setDeviceStatus(text, detail);
          }),
        ).catch(reportBackgroundError);
    }).catch((error) => {
      if (isCurrent()) logger.warn('[DEV startup]', error);
    });
  }

  showLoading('正在加载 IFC 模型...');
  const failed: Array<{ name: string; message: string }> = [];
  let interactiveInitialized = false;
  let deferredStarted = false;
  let onIfcPresented: (() => void) | undefined;
  const afterPaintOpportunity = (work: () => void) => {
    if (document.visibilityState !== 'hidden' && typeof requestAnimationFrame === 'function')
      requestAnimationFrame(() => setTimeout(work, 0));
    else setTimeout(work, 0);
  };
  const startDeferredTasks = (presentationGate: SubstationBackgroundGate = 'allIfcReady') => {
    if (deferredStarted || !isCurrent()) return;
    deferredStarted = true;
    const start = (
      label: string,
      starter?: () => void | Promise<unknown>,
      scheduler?: (
        coordinator: SubstationBackgroundCoordinator,
        gate: SubstationBackgroundGate,
      ) => void,
      gate: SubstationBackgroundGate = 'allIfcReady',
    ) => {
      try {
        if (scheduler) scheduler(background, gate);
        else if (starter) void Promise.resolve(starter()).catch(reportBackgroundError);
      } catch (error) {
        logger.warn(`[GIM] 启动${label}失败，继续 IFC 后台加载:`, error);
      }
    };
    start('IFC 空间语义', options.startSpatialSemantic, options.scheduleSpatialSemantic);
    start('STD/SLD', options.startStdSld, options.scheduleStdSld, presentationGate);
    start(
      '缓存持久化',
      options.startCachePersistence,
      options.scheduleCachePersistence,
      presentationGate,
    );
  };
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
      const { syncProjectSourceToViewerFromFragments } =
        await import('./coordinateAlignmentService.js');
      if (!isCurrent()) return;
      await syncProjectSourceToViewerFromFragments(state, ctx.fragments, { session });
      if (!isCurrent()) return;
      if (state.projectSourceToViewerMatrix)
        connectionPreview.setTransform?.(state.projectSourceToViewerMatrix);
      endCoordinate(undefined, {
        hasMatrix: state.projectSourceToViewerMatrix != null,
      });
    } catch (err) {
      endCoordinate('（失败）', { error: err instanceof Error ? err.message : String(err) });
      if (isCurrent()) {
        logger.warn('[CoordAlign] IFC 基准坐标同步失败，MOD/STL 将使用原始坐标或手工 offset:', err);
      }
    }
  };

  /**
   * 变电默认视角为整站远景全景：首个 IFC 就绪时先给一个概览，等其余 IFC
   * 与设备目录补齐后再校正一次；用户一旦手动操作相机就不再自动改。
   */
  const trackCameraInteraction = (): void => {
    const canvas = (ctx.world.renderer as unknown as { domElement?: HTMLCanvasElement })
      ?.domElement;
    if (!canvas || trackedIfcCanvases.has(canvas)) return;
    trackedIfcCanvases.add(canvas);
    const mark = (): void => {
      state.viewState.viewerUserInteracted = true;
    };
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
        if (
          !isCurrent() ||
          state.viewState.viewerUserInteracted ||
          state.selection.selectionRequest?.target
        )
          return;
        void Promise.resolve(
          import('../viewer/camera.js').then(({ fitCameraToStationOverview }) => {
            if (
              !isCurrent() ||
              state.viewState.viewerUserInteracted ||
              state.selection.selectionRequest?.target
            )
              return;
            fitCameraToStationOverview(ctx, state.viewState, {
              force: true,
              ...stationViewPolicy(state),
            });
          }),
        ).catch(reportBackgroundError);
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

    await renderSubstationCoreUi(
      state,
      (text) => showLoadingBeforeInteractive(text),
      session,
      perfSession,
      '变电 navigation/UI（首个 IFC）',
    );
    if (!isCurrent()) return;

    const { fitCameraToStationOverview } = await import('../viewer/camera.js');
    if (!isCurrent()) return;
    // 变电默认打开为整站远景全景，不再恢复上次相机；层级树展开状态仍恢复。
    const { restoreTreeState } = await import('./viewStateStore.js');
    restoreTreeState(state);
    if (!isCurrent()) return;
    if (!state.selection.selectionRequest?.target && !state.viewState.viewerUserInteracted) {
      trackCameraInteraction();
      fitCameraToStationOverview(ctx, state.viewState, stationViewPolicy(state));
      scheduleStationOverviewRefit();
    }
    interactiveInitialized = true;
    perfMark(
      '首个 IFC 就绪',
      {
        name: entry.name,
        source: loadSource,
        cacheHit: loadSource === 'lod-cache',
      },
      perfSession,
    );
    const firstMeta = {
      kind: 'ifc',
      name: entry.name,
      source: loadSource,
      cacheHit: loadSource === 'lod-cache',
      coordinateAnchor: state.projectSourceToViewerMatrix != null,
      loadedModels: state.ifc.loadedModels.size,
    };
    perfMarkProductMoment('firstUsableGeometryReady', firstMeta, perfSession);
    const runtimeId = state.ifc.runtimeModelIds.get(entry.modelId) ?? entry.modelId;
    const object = ctx.fragments.list.get(runtimeId)?.object;
    let frameHandled = false;
    onIfcPresented = () => {
      if (frameHandled || !isCurrent()) return;
      frameHandled = true;
      setSubstationViewerInteractive(true);
      hideLoading();
      perfMark('变电工程首次实体画面已提交', firstMeta, perfSession);
      void Promise.resolve(
        sampleSubstationMemory(state, 'interactive', perfSession, firstMeta, ctx),
      ).catch(reportBackgroundError);
      // Give the submitted model frame a paint opportunity before optional
      // synchronous work. No GPU completion fence or readback is used.
      const start = () => {
        if (!isCurrent()) return;
        background.markInteractive();
        startDeferredTasks('interactive');
      };
      afterPaintOpportunity(start);
    };
    if (object)
      void observeFirstGeometry(state, ctx, object, session, onIfcPresented, perfSession).catch(
        reportBackgroundError,
      );
    signalInteractive();
    // Keep the IFC tail and DEV anchor live even if the first IFC is empty.
    // Optional work starts after a model draw, or after the full IFC tail if
    // every representation is empty/hidden; it never certifies a fake frame.
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
        try {
          await autoLoadModStlPostIfc(state, showMessage, ctx, { session });
        } catch (err) {
          logger.warn('[GIM] 后台 MOD 加载失败:', err);
        }
      },
    });
  };

  const ifcSources = new Map<string, string>();
  const ifcStages = new Map<string, string>();
  let activeIfcPath = '';
  let ifcLifecycleSettled = false;
  const cacheWriteFailures = new Set<string>();
  const setIfcStatus = (text: string) => {
    if (isCurrent() && !ifcLifecycleSettled) publishIfcStatus(text);
  };
  const ifcCacheProgress = () => {
    const cold = [...ifcSources.values()].filter((source) => source === 'ifc').length;
    const lod = [...ifcSources.values()].filter((source) => source === 'lod-cache').length;
    return `冷转换 ${cold} · LOD缓存 ${lod}`;
  };
  const ifcStatus = (entry: IfcEntry, index: number, total: number, extra = '') => {
    const skipped = state.ifcLoading.skippedLargeIfc.length;
    return `IFC ${index + 1}/${total} · ${entry.name} · ${ifcStages.get(entry.path) ?? '待检查'}${extra ? ` · ${extra}` : ''} · ${ifcCacheProgress()}${skipped ? ` · 已跳过 ${skipped} 个超大 IFC` : ''}`;
  };
  const ifcStageLabels: Record<string, string> = {
    'checking-cache': '查询LOD缓存',
    'lod-cache-hit': 'LOD缓存命中',
    'cold-convert': '冷转换中',
    'far-ready': '远景就绪',
    'cache-write-start': '缓存写入中',
    'cache-written': '缓存已写',
    'cache-write-failed': '远景就绪(缓存写入失败)',
  };
  const publishTerminalStatus = () => {
    if (isCurrent())
      publishIfcStatus(
        `IFC 已结束 · 已加载 ${state.ifc.loadedModels.size}/${entries.length} · ${ifcCacheProgress()}${failed.length ? ` · 失败 ${failed.length}` : ''}${state.ifcLoading.skippedLargeIfc.length ? ` · 已跳过 ${state.ifcLoading.skippedLargeIfc.length} 个超大 IFC` : ''}${cacheWriteFailures.size ? ` · 缓存写入失败 ${cacheWriteFailures.size}` : ''}`,
      );
  };
  const lifecycleTask = (async (): Promise<void> => {
    try {
      const [{ ensureEngineReady }, { loadIfcEntry }, { shouldSkipLargeIfc }] = await Promise.all([
        import('../viewer/ifcLoader.js'),
        import('../viewer/ifcEntryLoader.js'),
        import('./appSettings.js'),
      ]);
      if (!isCurrent()) return;
      const endEngineInit = perfBegin('web-ifc / Fragments engine 初始化', undefined, perfSession);
      await ensureEngineReady(ctx, state, modelCallbacks);
      if (!isCurrent()) return;
      endEngineInit(undefined, { initialized: true });
      let firstIfcLoadStarted = false;
      const sizes = new Map(options.ifcSourceSizes);
      for (const entry of entries) {
        const file = state.currentFiles && getFileByPath(state.currentFiles, entry.path);
        if (file) sizes.set(entry.path.toLowerCase(), file.size);
      }
      const { queue, skippedLargeIfc, evidencedConnections, hasConnections } =
        planSubstationIfcLoad(entries, sizes, state.currentCbmTree, shouldSkipLargeIfc());
      if (skippedLargeIfc.length) {
        logger.warn('[IFC] 已按设置跳过超大文件:', skippedLargeIfc);
        perfMark('IFC 跳过超大文件', { skipped: skippedLargeIfc }, perfSession);
      }
      state.ifcLoading.skippedLargeIfc = skippedLargeIfc.map((row) => row.path);
      if (hasConnections) {
        perfMark(
          'IFC 连接线优先',
          {
            order: queue.slice(0, 4).map((entry) => entry.path),
            evidencedModels: [...evidencedConnections],
            anchorPreserved: queue[0]?.modelId === entries[0]?.modelId,
          },
          perfSession,
        );
      }
      for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
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
          if (stage === 'cache-write-failed') cacheWriteFailures.add(entry.path);
          if (stage === 'cache-written') cacheWriteFailures.delete(entry.path);
          if (ifcLifecycleSettled) {
            if (stage === 'cache-write-failed' || stage === 'cache-written')
              publishTerminalStatus();
            return;
          }
          ifcStages.set(
            entry.path,
            (ifcStageLabels[stage] ?? stage) +
              (typeof meta?.phase === 'string' && meta.phase ? ` · ${meta.phase}` : ''),
          );
          if (activeIfcPath === entry.path)
            setIfcStatus(
              ifcStatus(
                entry,
                queueIndex,
                queue.length,
                typeof meta?.ms === 'number' ? `${meta.ms}ms` : '',
              ),
            );
        };
        const statusStarted = performance.now();
        const statusTimer = setInterval(() => {
          if (isCurrent() && !ifcLifecycleSettled && activeIfcPath === entry.path)
            setIfcStatus(
              ifcStatus(
                entry,
                queueIndex,
                queue.length,
                `${Math.round((sizes.get(entry.path.toLowerCase()) ?? 0) / 1048576)} MiB · ${Math.floor((performance.now() - statusStarted) / 1000)}秒`,
              ),
            );
        }, 1000);
        const endRead = perfBegin(`变电 IFC read · ${entry.path}`, undefined, perfSession);
        const endIfcLoad = perfBegin(
          `变电 web-ifc / Fragments load · ${entry.path}`,
          undefined,
          perfSession,
        );
        try {
          if (!firstIfcLoadStarted) {
            firstIfcLoadStarted = true;
            perfMarkProductMoment(
              'firstIfcLoadStart',
              {
                name: entry.name,
                path: entry.path,
              },
              perfSession,
            );
          }
          const ifcBytes: { value: Uint8Array | null } = { value: null };
          const readBytes = async (): Promise<Uint8Array | null> => {
            ifcBytes.value = await getIfcBufferForEntry(entry, state, session);
            if (!isCurrent()) return null;
            lastIfcReadByteLength = ifcBytes.value?.byteLength ?? 0;
            const readMeta = {
              bytes: ifcBytes.value?.byteLength ?? 0,
              source: state.currentFiles ? 'extracted' : 'disk-cache',
              found: ifcBytes.value != null,
            };
            if (!readProfiled) {
              endRead(undefined, readMeta);
              readProfiled = true;
            }
            readEnded = true;
            return ifcBytes.value;
          };
          let finePromise: Promise<void> | null = null;
          const loadFine = (): Promise<void> => {
            if (finePromise) return finePromise;
            const task = loadIfcEntry(
              ctx,
              state,
              entry,
              readBytes,
              (p) => {
                if (isCurrent() && !ifcLifecycleSettled) {
                  setIfcStatus(
                    ifcStatus(entry, queueIndex, queue.length, `${Math.round(p * 100)}%`),
                  );
                  if (!interactiveInitialized)
                    showLoading(`${entry.name}: ${Math.round(p * 100)}%`);
                }
              },
              {
                session,
                perfSessionId: perfSession.id,
                onLoadSource: (source) => {
                  if (!isCurrent() || ifcLifecycleSettled) return;
                  setSubstationViewerInteractive(true);
                  loadSource.value = source;
                  ifcSources.set(entry.path, source);
                  ifcStages.set(
                    entry.path,
                    source === 'ifc'
                      ? '冷转换完成'
                      : source === 'lod-cache'
                        ? 'LOD缓存恢复完成'
                        : '完整缓存恢复完成',
                  );
                },
                onStage: (stage, meta) => setIfcStage(stage, meta),
                onProfile: (profile) => {
                  if (isCurrent()) perfRecordIfcLoadProfile(profile, perfSession);
                },
                onRegionalBatch: (batch) => {
                  if (isCurrent()) {
                    const accepted = connectionPreview.acceptBatch({
                      ...batch,
                      modelId: entry.modelId,
                      sourcePath: entry.path,
                      sourceIdentity: session.sourceSha256 ?? `session:${session.generation}`,
                      coordinateBasis: 'ifc-y-up-m',
                    });
                    if (
                      accepted &&
                      !connectionFirstBatches.has(entry.modelId) &&
                      batch.chunks?.some((chunk) => chunk.vertices.length > 0)
                    ) {
                      connectionFirstBatches.add(entry.modelId);
                      perfMark(
                        'IFC connection preview first batch',
                        {
                          modelId: entry.modelId,
                          entryPath: entry.path,
                          sequence: batch.sequence,
                          objects: batch.objects.length,
                          bytes: batch.bytes,
                          source: 'stream',
                        },
                        perfSession,
                      );
                    }
                    updateConnectionStatus();
                  }
                },
                onRegionalComplete: (meta) => {
                  if (isCurrent()) {
                    connectionPreview.markComplete(entry.modelId, meta);
                    if (!connectionCompletions.has(entry.modelId)) {
                      connectionCompletions.add(entry.modelId);
                      perfMark(
                        'IFC connection preview settled',
                        {
                          modelId: entry.modelId,
                          entryPath: entry.path,
                          objectCount: meta.objectCount,
                          sequence: meta.sequence,
                          source: 'regional-index-complete',
                        },
                        perfSession,
                      );
                    }
                    updateConnectionStatus();
                  }
                },
                transferInput: true,
                openingPolicy,
              },
            );
            const wrapped = task.catch((error) => {
              if (finePromise === wrapped) {
                ifcBytes.value = null;
                readEnded = false;
                finePromise = null;
              }
              throw error;
            });
            finePromise = wrapped;
            return wrapped;
          };
          await loadFine();
          if (!isCurrent()) return;
          connectionPreview.markModelReady(
            entry.modelId,
            state.ifc.regionalRuntimes.get(entry.modelId)?.index.objects,
          );
          updateConnectionStatus();
          if (!readEnded) {
            // 浏览 LOD 缓存命中时不会调用 getIfcBuffer；显式记录“未读取 IFC”。
            if (!readProfiled)
              endRead(undefined, {
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
          const runtimeModelId = state.ifc.runtimeModelIds.get(entry.modelId) ?? entry.modelId;
          const usable =
            state.ifc.loadedModels.has(entry.modelId) && ctx.fragments.list.has(runtimeModelId);
          if (usable && !interactiveInitialized) {
            await initializeInteractiveAfterFirstIfc(entry, loadSource.value);
            if (!isCurrent()) return;
          } else if (usable) {
            // An empty/offscreen first IFC cannot certify a visible frame.
            // Observe later models too, with one shared presentation callback.
            const object = ctx.fragments.list.get(runtimeModelId)?.object;
            if (object)
              void observeFirstGeometry(
                state,
                ctx,
                object,
                session,
                onIfcPresented,
                perfSession,
              ).catch(reportBackgroundError);
          }
        } catch (err) {
          if (!readEnded) {
            endRead('（失败）', {
              source: loadSource.value,
              error: err instanceof Error ? err.message : String(err),
            });
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
          logger.error('[GIM] IFC 加载失败:', entry, err);
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
            const runtimeModelId = state.ifc.runtimeModelIds.get(modelId) ?? modelId;
            if (ctx.fragments.list.has(runtimeModelId)) {
              void Promise.resolve(ctx.fragments.core.disposeModel(runtimeModelId)).catch(
                reportBackgroundError,
              );
            }
            state.ifc.loadedModels.delete(modelId);
            projectPresentation().removeModelRows([modelId, runtimeModelId]);
          } catch (cleanupErr) {
            logger.warn('[GIM] cleanup failed model after load error', entry, cleanupErr);
          }
          continue;
        } finally {
          clearInterval(statusTimer);
        }
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
      state.ifcLoading.pending = false;
      enqueueDevGeometry();
      background.markAllIfcReady();
      // All IFCs may be empty/hidden. Complete source work independently of
      // presentation; this does not emit an interactive/visible-frame moment.
      afterPaintOpportunity(() => startDeferredTasks());
      perfMarkProductMoment(
        'allIfcReady',
        {
          total: entries.length,
          loaded: state.ifc.loadedModels.size,
          failed: failed.length,
          firstInteractive: interactiveInitialized,
        },
        perfSession,
      );
      void Promise.resolve(
        sampleSubstationMemory(
          state,
          'allIfcReady',
          perfSession,
          { total: entries.length, loaded: state.ifc.loadedModels.size, failed: failed.length },
          ctx,
        ),
      ).catch(reportBackgroundError);

      // buildIfcNameIndex 失败不应阻断 UI 渲染
      const { buildIfcNameIndex } = await import('./ifcNameIndex.js');
      if (!isCurrent()) return;
      state.engineering.ifcGeometryFinished = true;
      state.engineeringGeometryEvidenceChanged?.();
      const endNameIndex = perfBegin('变电 IFC name index', undefined, perfSession);
      await buildIfcNameIndex(ctx, state, { session }).catch((err) => {
        logger.warn('[GIM] buildIfcNameIndex failed', err);
      });
      if (!isCurrent()) return;
      endNameIndex(undefined, { models: state.ifc.loadedModels.size });

      if (!interactiveInitialized && state.ifc.loadedModels.size > 0) {
        // Defensive fallback for a loader that populated state without the
        // usual first-model event.  Normal IFC paths initialize above.
        const firstLoaded = entries.find((entry) => state.ifc.loadedModels.has(entry.modelId));
        if (firstLoaded) await initializeInteractiveAfterFirstIfc(firstLoaded, 'unknown');
        if (!isCurrent()) return;
      }
      await renderSubstationCoreUi(
        state,
        (text) => showLoadingBeforeInteractive(text),
        session,
        perfSession,
        '变电 navigation/UI（all IFC）',
      );
      if (!isCurrent()) return;
      // Keep the heavy post-IFC lane behind the final name-index/UI pass.  The
      // allIfcReady product moment is already recorded above, but releasing the
      // coordinator here avoids DEV geometry or a spatial rebuild competing with
      // the last mandatory UI bookkeeping.
      background.markAllIfcReady();
    } catch (err) {
      if (!isCurrent()) return;
      state.engineering.ifcGeometryFinished = true;
      state.engineeringGeometryEvidenceChanged?.();
      logger.error('[GIM] IFC 加载失败 (outer)', {
        error: err,
        message: err instanceof Error ? err.message : String(err),
      });
      showLoading(`IFC 加载失败: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => {
        if (isCurrent()) hideLoading();
      }, 3000);
      if (!interactiveSignaled) rejectInteractive(err);
      return;
    }

    // Interactive is reached after the first usable IFC.  The sequential tail
    // may still have failed entries, but it must no longer own the first-use
    // loading barrier.
    if (failed.length > 0) {
      showLoading(`部分 IFC 加载失败：${failed.length}/${entries.length}，详见控制台`);
      setTimeout(() => {
        if (isCurrent()) hideLoading();
      }, 4000);
    } else {
      hideLoading();
    }
  })();

  // The first usable IFC is the caller-visible readiness boundary. The
  // sequential IFC tail and post-IFC geometry continue under the same
  // session/token guards after this promise resolves.
  void lifecycleTask
    .finally(() => {
      ifcLifecycleSettled = true;
      activeIfcPath = '';
      publishTerminalStatus();
      // If every IFC failed (or the session became stale) there is no usable
      // geometry event to signal. Release the caller rather than leaving an
      // unresolved readiness promise behind.
      if (!interactiveSignaled) signalInteractive();
    })
    .catch(() => undefined);

  try {
    await interactiveReady;
  } catch {
    return;
  }
}
