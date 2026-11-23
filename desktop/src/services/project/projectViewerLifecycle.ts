import type { AppState } from '../../app/state.js';
import type * as THREE from 'three';
import type { ViewerContext } from '../../viewer/viewerEngine.js';
import { DEBUG_RUNTIME_LOGS } from '../../config/debug.js';
import { debugLog, logger } from '../../utils/logger.js';

export interface ViewerReleaseCounts {
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
  counts: ViewerReleaseCounts,
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
  counts: ViewerReleaseCounts,
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
  } = await import('../dev-geometry/devGlbTemplateRuntime.js');
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

export async function releaseProjectViewer(
  state: AppState,
  existingViewer: () => Promise<ViewerContext | undefined>,
  isCurrentCleanup: () => boolean,
  beforeRelease: (ctx?: ViewerContext | null) => void,
): Promise<{ context: ViewerContext | null; counts: ViewerReleaseCounts } | false> {
  let cleanupViewerContext: ViewerContext | null = null;
  let sampled = false;
  const counts: ViewerReleaseCounts = {
    disposedCount: 0,
    attemptedCount: 0,
    xmlModDisposedCount: 0,
    stlDisposedCount: 0,
  };
  if (!isCurrentCleanup()) return false;
  try {
    const ctx = await existingViewer();
    if (!isCurrentCleanup()) return false;
    if (ctx) {
      cleanupViewerContext = ctx;
      // Preserve tree expansion before disposing the scene (camera is not restored).
      try {
        const { saveViewState } = await import('./viewStateStore.js');
        if (!isCurrentCleanup()) return false;
        saveViewState(state);
      } catch {
        /* best effort */
      }
      if (!isCurrentCleanup()) return false;
      sampled = true;
      beforeRelease(ctx);

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
    }
  } catch (err) {
    logger.warn('[Cleanup] ViewerRuntime cleanup failed:', err);
  }
  // A project can have semantic/geometry state without a created viewer (for
  // example a partially failed open).  Still record the ownership checkpoint.
  if (!isCurrentCleanup()) return false;
  if (!sampled) beforeRelease();
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

  return { context: cleanupViewerContext, counts };
}
