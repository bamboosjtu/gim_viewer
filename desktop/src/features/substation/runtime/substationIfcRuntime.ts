import * as statusPresentation from '../../../services/presentation/shell_statusBar.js';
import { reportBackgroundError } from '../../../utils/backgroundErrors.js';

import { setSubstationViewerInteractive } from './substationLoadingState.js';
/** Sequential IFC loading, early geometry, cache profiles and background gates. */
import type { IfcEntry } from '../../../gim/types.js';
import type { AppState, ProjectLoadSession } from '../../../app/state.js';
import { logger } from '../../../utils/logger.js';
import {
  SubstationBackgroundCoordinator,
  type SubstationBackgroundGate,
} from './substationBackgroundRuntime.js';
import {
  perfCurrentSession,
  perfBegin,
  perfMark,
  perfMarkProductMoment,
  perfGeometryTracksEnabled,
} from '../../../utils/perfTimings.js';
import { startSubstationResourceMonitor } from '../../../services/project/projectResourceTelemetry.js';
import { showLoading, hideLoading } from '../../../services/project/gimOpenCore.js';
import { autoLoadModStlPostIfc } from './substationDevRuntime.js';

import {
  renderSubstationCoreUi,
  showLoadingBeforeInteractive,
} from '../presentation/substationPresentation.js';
import { sampleSubstationMemory } from './substationRuntimeTelemetry.js';
import { stationViewPolicy } from './stationViewPolicy.js';
import { observeFirstGeometry } from '../../../services/presentation/geometryPresentationService.js';
import { createSubstationIfcLoadProgress } from './substationIfcLoadProgress.js';
import type { SubstationIfcUsableModel } from './substationIfcModelLoad.js';
import { loadSubstationIfcQueue } from './substationIfcQueue.js';
import { createSubstationIfcCompletion } from './substationIfcCompletion.js';

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
  const session = options.session ?? state.captureProjectSession();
  const scope = state.sessionScope(session);
  const perfSession = perfCurrentSession();
  const measureGeometryTracks = perfGeometryTracksEnabled();
  const { isCurrent } = scope;
  const clearIfcPending = () => {
    if (isCurrent()) state.ifcLoading.pending = false;
  };
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
  state.ifcLoading.pending = true;
  let devGeometryQueued = false;
  background.registerRemainingIfc();
  const releaseBackground = scope.own(() => {
    if (state.substationFineQueue === background) {
      state.substationFineQueue = null;
      state.ifcLoading.pending = false;
    }
    background.cancelPending();
    background.completeRemainingIfc();
  });
  // 调试入口：从 localStorage 读取手动坐标偏移（GIM_COORD_OFFSET="dx,dy,dz"）
  // 仅作为调试功能，不写入数据库，不作为最终算法。
  // resetGimState 会清空 projectSourceToViewerMatrix，因此每次打开项目时重新解析。
  try {
    const { loadManualCoordOffsetFromLocalStorage } =
      await import('../../../services/project/coordinateAlignmentService.js');
    if (!isCurrent()) return;
    loadManualCoordOffsetFromLocalStorage(state);
  } catch {
    // 忽略：coordinateAlignmentService 不可用时不影响主流程
  }

  if (entries.length === 0) {
    // 无 IFC 但仍触发 MOD/STL 自动加载（纯 xml-mod 工程）
    try {
      await autoLoadModStlPostIfc(state, showMessage, undefined, { session });
    } finally {
      clearIfcPending();
      releaseBackground();
    }
    return;
  }

  showLoading('正在加载 3D 引擎...');
  const endEngine = perfBegin('3D 引擎创建', undefined, perfSession);
  const [{ getViewerRuntimeWithUI }, { IfcConnectionPreviewRuntime }] = await Promise.all([
    import('../../../services/presentation/viewerUIBinding.js'),
    import('../../../viewer/ifcConnectionPreviewRuntime.js'),
  ]).catch((error: unknown) => {
    clearIfcPending();
    releaseBackground();
    throw error;
  });
  if (!isCurrent()) return;
  let runtime;
  try {
    runtime = await getViewerRuntimeWithUI(state, showMessage);
  } catch (error) {
    clearIfcPending();
    releaseBackground();
    throw error;
  }
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
  if (state.projectSourceToViewerMatrix)
    connectionPreview.setTransform?.(state.projectSourceToViewerMatrix);
  state.viewState.stationOverview = () => {
    if (!state.isCurrentSession(session) || state.currentProjectType === 'transmission_line')
      return;
    state.viewState.cameraNavigationVersion++;
    void Promise.resolve(
      import('../../../viewer/camera.js').then(({ fitCameraToStationOverview }) => {
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
    const { startDeviceLod } = await import('../../../services/dev-geometry/devLodRuntime.js');
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
  setSubstationViewerInteractive(state, scope, false);
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
  const releaseOpening = scope.own(signalInteractive);

  const syncCoordinateAnchor = async (label: string): Promise<void> => {
    if (!isCurrent() || state.projectSourceToViewerMatrix) return;
    const endCoordinate = perfBegin(label, undefined, perfSession);
    try {
      const { syncProjectSourceToViewerFromFragments } =
        await import('../../../services/project/coordinateAlignmentService.js');
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
          import('../../../viewer/camera.js').then(({ fitCameraToStationOverview }) => {
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
    loadSource: SubstationIfcUsableModel['source'],
    object: SubstationIfcUsableModel['object'],
  ): Promise<void> => {
    if (interactiveInitialized || !isCurrent()) return;
    await syncCoordinateAnchor('变电 coordinate alignment（首个 IFC）');
    if (!isCurrent()) return;

    await renderSubstationCoreUi(
      state,
      (text) => showLoadingBeforeInteractive(state, text),
      session,
      perfSession,
      '变电 navigation/UI（首个 IFC）',
    );
    if (!isCurrent()) return;

    const { fitCameraToStationOverview } = await import('../../../viewer/camera.js');
    if (!isCurrent()) return;
    // 变电默认打开为整站远景全景，不再恢复上次相机；层级树展开状态仍恢复。
    const { restoreTreeState } = await import('../../../services/project/viewStateStore.js');
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
    let frameHandled = false;
    onIfcPresented = () => {
      if (frameHandled || !isCurrent()) return;
      frameHandled = true;
      setSubstationViewerInteractive(state, scope, true);
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
    void observeFirstGeometry(
      state,
      ctx,
      object,
      session,
      onIfcPresented,
      perfSession,
      'ifc',
    ).catch(reportBackgroundError);
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
        state.advanceGeometryBatch();
        try {
          await autoLoadModStlPostIfc(state, showMessage, ctx, { session });
        } catch (err) {
          logger.warn('[GIM] 后台 MOD 加载失败:', err);
        }
      },
    });
  };

  const progress = createSubstationIfcLoadProgress({
    total: entries.length,
    isCurrent,
    loadedCount: () => state.ifc.loadedModels.size,
    skippedCount: () => state.ifcLoading.skippedLargeIfc.length,
  });
  const completion = createSubstationIfcCompletion({
    state,
    ctx,
    entries,
    session,
    perfSession,
    background,
    progress,
    measureGeometryTracks,
    isCurrent,
    isInteractive: () => interactiveInitialized,
    syncCoordinateAnchor,
    enqueueDevGeometry,
    startDeferredAfterPaint: () => afterPaintOpportunity(() => startDeferredTasks()),
    initializeInteractiveAfterFirstIfc,
  });

  const loadIfcQueue = () =>
    loadSubstationIfcQueue({
      state,
      ctx,
      scope,
      entries,
      connectionPreview,
      progress,
      perfSession,
      measureGeometryTracks,
      modelCallbacks,
      ifcSourceSizes: options.ifcSourceSizes,
      isInteractive: () => interactiveInitialized,
      onUsable: async (entry, { source, object }) => {
        if (measureGeometryTracks)
          perfMarkProductMoment(
            'ifcFirstUsable',
            { source, scope: 'registered-authoritative-base' },
            perfSession,
          );
        if (!interactiveInitialized) {
          await initializeInteractiveAfterFirstIfc(entry, source, object);
          return;
        }
        void observeFirstGeometry(
          state,
          ctx,
          object,
          session,
          onIfcPresented,
          perfSession,
          'ifc',
        ).catch(reportBackgroundError);
      },
    });

  const lifecycleTask = (async (): Promise<void> => {
    try {
      const skippedCount = await loadIfcQueue();
      if (skippedCount === undefined || !isCurrent()) return;
      if (!(await completion.settle(skippedCount)) || !isCurrent()) return;
      if (!(await completion.finishNavigation()) || !isCurrent()) return;
    } catch (err) {
      if (!isCurrent()) return;
      clearIfcPending();
      releaseBackground();
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
    if (progress.failedCount() > 0) {
      showLoading(`部分 IFC 加载失败：${progress.failedCount()}/${entries.length}，详见控制台`);
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
      progress.settle();
      // If every IFC failed (or the session became stale) there is no usable
      // geometry event to signal. Release the caller rather than leaving an
      // unresolved readiness promise behind.
      releaseOpening();
    })
    .catch(() => undefined);

  try {
    await interactiveReady;
  } catch {
    clearIfcPending();
    return;
  }
}
