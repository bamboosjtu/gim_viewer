import { reportBackgroundError } from '../../utils/backgroundErrors.js';
import { projectPresentation } from '../../services/projectPresentationPort.js';
import type { AppState } from '../state.js';
import type * as THREE from 'three';
import { DEBUG_RUNTIME_LOGS } from '../../config/debug.js';
import { debugLog, logger } from '../../utils/logger.js';
import { container } from '../../services/presentation/dom.js';
import { perfCurrentSession, perfReset } from '../../utils/perfTimings.js';
import { sampleSubstationRuntimeResources } from '../../services/substationResourceTelemetry.js';
import type { ViewerContext } from '../../viewer/viewerEngine.js';
import { cancelSubstationExtraction } from '../../services/substationExtractionJob.js';
import { cancelIfcConversions } from '../../viewer/ifcConversion.js';
import { resetStatusRight } from '../../services/presentation/shell_statusBar.js';
import { markMeasurementCancellation } from '../../measurement/runtime.js';

/** Close the current project or prepare the scene for a specific open request. */
export function cleanupProject(state: AppState, expectedGeneration?: number): Promise<boolean> {
  if (expectedGeneration !== undefined && state.projectGeneration !== expectedGeneration)
    return Promise.resolve(false);
  const closing = expectedGeneration === undefined;
  const shouldCaptureSubstationResources =
    state.currentProjectType === 'substation' ||
    state.currentIfcEntries.length > 0 ||
    state.modRootGroup != null ||
    state.stlRootGroup != null ||
    state.loadedXmlModGroups.size > 0 ||
    state.loadedStlGroups.size > 0;
  // 先标记主动取消，让会话释放 Worker 时保留正确的测量原因。
  // 两步均在首个 await 前执行，旧任务在清理开始时同步失效。
  let cleanupGeneration: number;
  try {
    markMeasurementCancellation(closing ? 'project-closed' : 'project-replaced');
  } finally {
    cleanupGeneration = state.invalidatePendingLoads();
  }
  const isCurrentCleanup = () => state.projectGeneration === cleanupGeneration;
  if (!isCurrentCleanup()) return Promise.resolve(false);
  cancelSubstationExtraction(state);
  cancelIfcConversions();
  // One Viewer runtime is shared. A newer cleanup waits for a disposal already
  // admitted by its predecessor, then enumerates the remaining resources.
  return state.projectSession.queueCleanup(() =>
    finishCleanup(
      state,
      cleanupGeneration,
      closing,
      shouldCaptureSubstationResources,
      isCurrentCleanup,
    ),
  );
}

interface CleanupCounts {
  disposedCount: number;
  attemptedCount: number;
  xmlModDisposedCount: number;
  stlDisposedCount: number;
}

/** Dispose admitted model IDs before any new scene can establish its anchor. */
async function disposeIfcSceneModels(
  state: AppState,
  ctx: ViewerContext,
  isCurrentCleanup: () => boolean,
  counts: CleanupCounts,
): Promise<boolean> {
  // 合并 state.loadedModels 中记录的 runtime ID 与 ctx.fragments.list 的 key
  // - state.loadedModels 可能比 ctx 多（dispose 失败的残留索引）
  // - ctx.fragments.list 可能比 state 多（state 被外部 reset 但 ctx 未清）
  const ids = new Set<string>();
  for (const [logicalModelId, loaded] of state.ifc.loadedModels) {
    ids.add(
      loaded.runtimeModelId || state.ifc.runtimeModelIds.get(logicalModelId) || logicalModelId,
    );
  }
  // DEV-only viewers have no Fragments core yet; list also accesses core.
  // Still continue below to release their MOD/STL resources and highlights.
  const fragments = ctx.fragments.initialized ? ctx.fragments : null;
  if (fragments) for (const modelId of fragments.list.keys()) ids.add(modelId);

  counts.attemptedCount = ids.size;
  for (const modelId of ids) {
    if (!isCurrentCleanup()) return false;
    try {
      if (fragments) await fragments.core.disposeModel(modelId);
      if (!isCurrentCleanup()) return false;
      counts.disposedCount++;
    } catch (err) {
      logger.warn('[Cleanup] dispose model failed:', modelId, err);
    }
  }

  if (!isCurrentCleanup()) return false;

  // Fragments clears its shared coordinate anchor only after the last
  // asynchronous model disposal. Never let the next open race that reset.
  if (fragments && fragments.list.size !== 0) {
    logger.error('[Cleanup] 旧 IFC 模型尚未释放，停止打开以免复用错误坐标基准');
    return false;
  }

  return true;
}

/** Release MOD/STL layers and their shared or instance-owned assets. */
async function disposeGeometryLayers(
  state: AppState,
  ctx: ViewerContext,
  isCurrentCleanup: () => boolean,
  counts: CleanupCounts,
): Promise<boolean> {
  // dispose MOD/STL 图层根节点 + 所有子 Group
  // v6: MOD/STL 挂在独立图层 __GIM_MOD_LAYER__ / __GIM_STL_LAYER__ 下，
  // 移除根节点即可级联移除所有子节点
  // v7: Material 全部共享（xmlModGeometry），逐 mesh dispose 会破坏同色 Mesh；
  //     traverse 只 dispose geometry，Material 由 disposeSharedXmlModMaterials 统一释放
  // v8: Geometry 也共享（方案 A），traverse 不再 dispose geometry；
  //     Geometry 由 disposeSharedXmlModGeometries 统一释放
  // v9（方案 B）: merged geometry 不再共享（每 MOD Group 独立），
  //              traverse 逐 mesh dispose merged geometry；Material 仍共享
  const scene = ctx.world.scene.three;
  const {
    disposeXmlModGroup,
    disposeOwnedXmlModMaterials,
    disposeSharedXmlModMaterials,
    disposeSharedXmlModGeometries,
  } = await import('../../viewer/xmlModLoader.js');
  const { disposeStlGroup } = await import('../../viewer/stlLoader.js');
  const {
    disposeDevGlbTemplatePool,
    DEV_GLB_TEMPLATE_PLACEMENT_USER_DATA_KEY,
    DEV_GLB_EXCLUSIVE_PLACEMENT_USER_DATA_KEY,
  } = await import('../../services/devGlbTemplateRuntime.js');
  if (!isCurrentCleanup()) return false;

  // 遍历 MOD 图层中的子 Group
  if (state.modRootGroup) {
    // DEV GLB Phase 4 placements share template resources.  Remove the
    // placement nodes without disposing their geometry; the session-local
    // template pool owns and releases each shared resource exactly once.
    disposeDevGlbTemplatePool(state.modRootGroup);
    for (const child of state.modRootGroup.children) {
      if (child.userData?.[DEV_GLB_TEMPLATE_PLACEMENT_USER_DATA_KEY] === true) continue;
      const exclusiveGlb = child.userData?.[DEV_GLB_EXCLUSIVE_PLACEMENT_USER_DATA_KEY] === true;
      // Legacy XML MOD groups have instance-owned geometry.  Keep the
      // previous cleanup semantics for those groups only.
      child.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        if (exclusiveGlb) {
          const materials = Array.isArray(mesh.material)
            ? mesh.material
            : mesh.material
              ? [mesh.material]
              : [];
          for (const material of materials) material.dispose();
        }
      });
    }
    disposeOwnedXmlModMaterials(state.modRootGroup);
    scene.remove(state.modRootGroup);
    counts.xmlModDisposedCount = state.loadedXmlModGroups.size;
  } else {
    // 初始化中途失败也可能留下独立 Group；根节点尚未建立时逐个释放。
    for (const [modPath, group] of state.loadedXmlModGroups) {
      try {
        scene.remove(group);
        disposeXmlModGroup(group);
        counts.xmlModDisposedCount++;
      } catch (err) {
        logger.warn('[Cleanup] dispose xml-mod group failed:', modPath, err);
      }
    }
  }

  // 统一释放共享 Geometry + Material 缓存（所有 MOD Group 已移除后才能安全释放）
  disposeSharedXmlModGeometries();
  disposeSharedXmlModMaterials();

  // 遍历 STL 图层中的子 Group 并 dispose
  if (state.stlRootGroup) {
    state.stlRootGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose?.();
    });
    scene.remove(state.stlRootGroup);
    counts.stlDisposedCount = state.loadedStlGroups.size;
  } else {
    for (const [stlPath, group] of state.loadedStlGroups) {
      try {
        scene.remove(group);
        disposeStlGroup(group);
        counts.stlDisposedCount++;
      } catch (err) {
        logger.warn('[Cleanup] dispose stl group failed:', stlPath, err);
      }
    }
  }

  return true;
}

async function finishCleanup(
  state: AppState,
  cleanupGeneration: number,
  closing: boolean,
  shouldCaptureSubstationResources: boolean,
  isCurrentCleanup: () => boolean,
): Promise<boolean> {
  if (!isCurrentCleanup()) return false;
  const { resetIfcWorkCompletion } = await import('../../viewer/geometryWorkGate.js');
  if (!isCurrentCleanup()) return false;
  resetIfcWorkCompletion();
  const { cancelDevGeometryPreprocessing } =
    await import('../../services/devGeometryWorkerClient.js');
  if (!isCurrentCleanup()) return false;
  cancelDevGeometryPreprocessing(state);
  // 清空场景没有上层 open 请求负责重置性能会话；在无 expectedGeneration
  // 的直接清理路径这里切断旧工程的迟到 span/invoke/Long Task。带代次的
  // 打开流程由 openGimService 在请求开始处重置，并保留本次解压计时。
  if (closing) {
    perfReset({ generation: cleanupGeneration, projectId: null, sourceSha256: null });
  }
  const cleanupPerfSession = perfCurrentSession();
  let cleanupViewerContext: ViewerContext | null = null;
  let beforeCleanupSampled = false;
  const sampleBeforeCleanup = (ctx?: ViewerContext | null): void => {
    if (!shouldCaptureSubstationResources || beforeCleanupSampled) return;
    beforeCleanupSampled = true;
    void Promise.resolve(
      sampleSubstationRuntimeResources(
        state,
        'beforeCleanup',
        cleanupPerfSession,
        ctx,
        { cleanupGeneration },
        { isCurrent: isCurrentCleanup },
      ),
    ).catch(reportBackgroundError);
  };

  // 共性 UI 契约：清理即重置顶栏工程身份与状态栏（纯 UI，位于 token 递增之后）
  try {
    await projectPresentation().resetIdentity(isCurrentCleanup);
  } catch {
    /* UI 模块不可用不影响清理 */
  }
  if (!isCurrentCleanup()) return false;
  resetStatusRight();

  // ---- 2. dispose ViewerRuntime 中所有 fragments 模型 ----
  // 必须在 resetGimState 之前执行：resetGimState 会清空 state.loadedModels 索引，
  // 但 ctx.fragments.list 中的 Three.js 对象仍残留，需要显式 dispose
  const counts: CleanupCounts = {
    disposedCount: 0,
    attemptedCount: 0,
    xmlModDisposedCount: 0,
    stlDisposedCount: 0,
  };
  const { isViewerRuntimeCreated, getViewerRuntime } =
    await import('../../viewer/viewerRuntime.js');
  if (!isCurrentCleanup()) return false;
  if (isViewerRuntimeCreated()) {
    try {
      const runtime = await getViewerRuntime(container);
      if (!isCurrentCleanup()) return false;
      const ctx = runtime.ctx;
      cleanupViewerContext = ctx;
      // Preserve tree expansion before disposing the scene (camera is not restored).
      try {
        const { saveViewState } = await import('../../services/viewStateStore.js');
        if (!isCurrentCleanup()) return false;
        saveViewState(state);
      } catch {
        /* best effort */
      }
      if (!isCurrentCleanup()) return false;
      sampleBeforeCleanup(ctx);

      if (!(await disposeIfcSceneModels(state, ctx, isCurrentCleanup, counts))) return false;
      if (!isCurrentCleanup()) return false;
      if (!(await disposeGeometryLayers(state, ctx, isCurrentCleanup, counts))) return false;
      if (!isCurrentCleanup()) return false;

      // ---- 3. 重置高亮 ----
      try {
        const { resetHighlight } = await import('../../viewer/highlight.js');
        if (!isCurrentCleanup()) return false;
        await resetHighlight(ctx, state, isCurrentCleanup);
        if (!isCurrentCleanup()) return false;
      } catch (err) {
        logger.warn('[Cleanup] resetHighlight failed:', err);
      }
    } catch (err) {
      logger.warn('[Cleanup] ViewerRuntime cleanup failed:', err);
    }
  }
  // A project can have semantic/geometry state without a created viewer (for
  // example a partially failed open).  Still record the ownership checkpoint.
  if (!isCurrentCleanup()) return false;
  sampleBeforeCleanup();
  debugLog(
    DEBUG_RUNTIME_LOGS,
    '[Cleanup] disposed viewer models:',
    counts.disposedCount,
    '(attempted:',
    counts.attemptedCount,
    '), xml-mod groups:',
    counts.xmlModDisposedCount,
    ', stl groups:',
    counts.stlDisposedCount,
  );

  // ---- 4. 清空 UI 残留 ----
  // disposeModel 会触发 onItemDeleted → removeModelFromUI，但保险起见再清一次
  // 同步清空其他面板，避免上一个工程（如线路 TOWER 属性）残留到下一个工程
  try {
    await projectPresentation().clearProjectViews(isCurrentCleanup);
  } catch (error) {
    logger.warn('[Cleanup] clear project views failed:', error);
  }

  // ---- 5. 重置 state ----
  // 必须在 dispose 之后执行：resetGimState 会清空 state.loadedModels 索引
  // resetGimState 是集中 mutator，已包含 loadedModels.clear / highlightedItems=null / hasFittedCamera=false
  if (!state.finishProjectCleanup(cleanupGeneration, closing)) return false;
  // 用户主动关闭工程时撤销加载遮罩；切换到新工程的清理不能隐藏新工程刚
  // 显示的进度（expectedGeneration 有值表示本次清理服务于一次新的打开）。
  if (closing) {
    try {
      const { hideLoading } = await import('../../services/gimOpenCore.js');
      if (isCurrentCleanup()) hideLoading();
    } catch {
      /* best effort */
    }
    if (!isCurrentCleanup()) return false;
    window.dispatchEvent(new CustomEvent('gim:project-closed'));
  }
  if (shouldCaptureSubstationResources && isCurrentCleanup()) {
    const cleanupMeta = {
      cleanupGeneration,
      disposedModels: counts.disposedCount,
      attemptedModels: counts.attemptedCount,
      xmlModGroups: counts.xmlModDisposedCount,
      stlGroups: counts.stlDisposedCount,
    };
    void Promise.resolve(
      sampleSubstationRuntimeResources(
        state,
        'afterCleanup',
        cleanupPerfSession,
        cleanupViewerContext,
        cleanupMeta,
        { isCurrent: isCurrentCleanup },
      ),
    ).catch(reportBackgroundError);
    setTimeout(() => {
      if (!isCurrentCleanup()) return;
      void Promise.resolve(
        sampleSubstationRuntimeResources(
          state,
          'settledAfterCleanup',
          cleanupPerfSession,
          cleanupViewerContext,
          cleanupMeta,
          { isCurrent: isCurrentCleanup },
        ),
      ).catch(reportBackgroundError);
    }, 250);
  }
  return true;
}
