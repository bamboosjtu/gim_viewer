import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { loadPresentation } from './presentationPort.js';
/** DEV post-IFC LOD startup and geometry recovery. */
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { perfCurrentSession, perfBegin, perfMark, perfMarkProductMoment, perfProductMomentSnapshot, perfRecordDevGeometryProfile } from '../utils/perfTimings.js';
import { scheduleSubstationResourceCheckpoint } from './substationResourceTelemetry.js';
import { hideLoading } from './gimOpenCore.js';
import { showLoadingBeforeInteractive } from './substationPresentation.js';
import { sampleSubstationMemory } from './substationRuntimeTelemetry.js';
import {observeFirstGeometry} from './geometryPresentationService.js';

/**
 * MOD/STL 自动加载（IFC 加载后置步骤，同时用于无 IFC 的纯 MOD 工程）。
 *
 * 若 ctx 未传入（无 IFC 场景），内部创建 ViewerRuntime。
 *
 * 双路径：
 * - 首次打开（currentFiles 非空）→ 渐进式 DEV GLB 管线：
 *   序列化 → 落盘 → 逐 CBM 实例渲染一体化，MOD 只解析 1 遍（原流程解析 2 遍）
 * - 缓存命中（currentFiles=null）→ 原有 autoLoadModAndStlGeometry
 *   （GLB 快速路径 → SQLite 直通回退）
 */

export async function autoLoadModStlPostIfc(
  state: AppState,
  showMessage: (text: string) => void,
  existingCtx?: ViewerContext,
  options?: {
    token?: number;
    includeMod?: boolean;
    includeStl?: boolean;
    session?: ProjectLoadSession;
    geometryCacheValid?: boolean;
    geometryCacheManifestValid?: boolean;
    geometryCacheVersionFileMatch?: boolean;
    onDevCheckpoint?: import('./substationBackgroundRuntime.js').DevCheckpointHandler;
  },
): Promise<void> {
  let endModStl: ((labelSuffix?: string, endMeta?: Record<string, unknown>) => void) | null = null;
  let modStlEnded = false;
  try {
    const session = options?.session ?? state.captureProjectSession();
    const perfSession = perfCurrentSession();
    if (!state.isCurrentSession(session)) return;
    endModStl = perfBegin('变电 MOD/STL', undefined, perfSession);
    const finishModStl = (suffix?: string, meta?: Record<string, unknown>): void => {
      if (modStlEnded) return;
      modStlEnded = true;
      endModStl?.(suffix, meta);
    };
    // 获取 scene：优先用已有 ctx，否则创建 ViewerRuntime
    let scene: import('three').Scene;
    let resourceCtx: ViewerContext | null = existingCtx ?? null;
    if (existingCtx) {
      scene = (existingCtx.world.scene as any).three as import('three').Scene;
    } else {
      const { getViewerRuntimeWithUI } = await import('./viewerUIBinding.js');
      if (!state.isCurrentSession(session)) return;
      const runtime = await getViewerRuntimeWithUI(state, showMessage);
      if (!state.isCurrentSession(session)) return;
      scene = (runtime.ctx.world.scene as any).three as import('three').Scene;
      resourceCtx = runtime.ctx;
    }

    // DEV is an on-demand geometry domain. Both cold and warm consume the same occurrence/catalog/placement runtime.
    if (resourceCtx && state.currentProjectType === 'substation' && typeof Worker !== 'undefined') {
      const { startDeviceLod } = await import('./devLodRuntime.js');
      if (!state.isCurrentSession(session)) return;
      if (!state.currentIfcEntries.length && !state.projectSourceToViewerMatrix) {
        const THREE = await import('three');
        if (!state.isCurrentSession(session)) return;
        state.projectSourceToViewerMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
      }
      await startDeviceLod(state, resourceCtx, session, (text, detail) => {
        if (state.isCurrentSession(session)) void Promise.resolve(loadPresentation('shell_statusBar').then(({ setDeviceStatus }) => { if (state.isCurrentSession(session)) setDeviceStatus(text, detail); })).catch(reportBackgroundError);
      });
      if (!state.isCurrentSession(session)) return;
      finishModStl(undefined, { path: 'device-lod-directory', onDemand: true });
      if(state.modRootGroup)void observeFirstGeometry(state,resourceCtx,state.modRootGroup,session,hideLoading,perfSession).catch(reportBackgroundError);
      return; // Current-view readiness is recorded by the LOD owner, not a whole-station completion.
    }

    // 首次打开：渐进式 DEV GLB 管线（编译→落盘→渐进渲染一体）
    if (state.currentFiles) {
      const { runProgressiveDevGlbPipeline } = await import('./progressiveGeometryService.js');
      if (!state.isCurrentSession(session)) return;
      const result = await runProgressiveDevGlbPipeline(
        state,
        scene,
        (p) => {
          if (!state.isCurrentSession(session)) return;
          if (p.phase === 'compiling') {
            showLoadingBeforeInteractive(`正在后台编译几何模型 (${p.compiledDevs}/${p.totalDevs})...`);
          } else if (p.phase === 'done') {
            perfMark('渐进式 DEV GLB 管线完成', {
              compiledDevs: p.compiledDevs,
              renderedInstances: p.renderedInstances,
            }, perfSession);
            hideLoading();
          }
        },
        {
          token: options?.token,
          generation: session.generation,
          projectId: session.projectId,
          sourceSha256: session.sourceSha256,
          session,
          onDevCheckpoint: options?.onDevCheckpoint,
        },
      );

      if (!state.isCurrentSession(session)) return;

      // 渐进 GLB 编译同样按 DEV 做失败隔离。无法产生 GLB 的 DEV 只在
      // 当前解压文件源上做定向 raw fallback；已成功渲染的其它 DEV 不得
      // 被清理或重新解析。
      const devGlbProfile = result.devGlbProfile;
      let scopedRaw = { modCount: 0, stlCount: 0, rows: 0 };
      if (!result.interrupted && result.rawFallbackDevs.length > 0 && state.currentFiles) {
        try {
          const {
            loadScopedRawFallbackGeometry,
          } = await import('./modAutoLoadService.js');
          const { getSourceGeometryOccurrences } = await import('./sourceGeometryService.js');
          const fallbackNodes = await getSourceGeometryOccurrences(state, session);
          scopedRaw = await loadScopedRawFallbackGeometry(
            state,
            scene,
            (p) => {
              if (!state.isCurrentSession(session)) return;
              if (p.phase === 'loading_mod') {
                showLoadingBeforeInteractive(`正在定向回退失败 DEV 的 MOD 模型 ${p.loadedMods}/${p.totalMods}...`);
              } else if (p.phase === 'loading_stl') {
                showLoadingBeforeInteractive(`正在定向回退失败 DEV 的 STL 模型 ${p.loadedStls}/${p.totalStls}...`);
              }
            },
            result.rawFallbackDevs,
            true,
            false,
            options?.token,
            session.generation,
            session.projectId,
            session.sourceSha256,
            session,
            devGlbProfile,
            state.currentFiles,
            fallbackNodes,
            options?.onDevCheckpoint,
          );
        } catch (error) {
          // 定向回退失败不应清理已经成功的 GLB；把错误留在控制台与
          // 性能 span 中，后续诊断可以区分“部分回退失败”和全项目失败。
          console.warn('[GIM] 渐进几何 scoped raw fallback 失败:', error);
        }
      }

      if (devGlbProfile) {
        perfRecordDevGeometryProfile(devGlbProfile as unknown as Record<string, unknown>, perfSession);
      }
      finishModStl(undefined, {
        path: 'progressive-dev-glb',
        compiledDevs: result.compiledDevs,
        renderedInstances: result.renderedInstances,
        rawFallbackDevs: result.rawFallbackDevs.length,
        rawFallbackInstances: scopedRaw.modCount + scopedRaw.stlCount,
        rawFallbackRows: scopedRaw.rows,
        interrupted: result.interrupted,
        ...(devGlbProfile ? { devGlbProfile } : {}),
      });
      const totalGeometryInstances = result.renderedInstances
        + scopedRaw.modCount
        + scopedRaw.stlCount;
      if (!result.interrupted && totalGeometryInstances > 0) {
        debugLog(DEBUG_IFC_LOAD, '[GIM] 渐进几何管线完成', result);
        // 编译完成后强制重新 fit 相机（bbox 可能显著变化）
        if (existingCtx) {
          const { fitCameraToScene } = await import('../viewer/camera.js');
          if (!state.isCurrentSession(session)) return;
          if (!state.selectionRequest?.target) fitCameraToScene(existingCtx, state, { force: true });
        }
      }
      if (!result.interrupted) {
        const fullMeta = {
          ifcModels: state.loadedModels.size,
          modInstances: result.renderedInstances + scopedRaw.modCount,
          compiledDevs: result.compiledDevs,
          sourceInvalidDevCount: result.sourceInvalidDevs?.length ?? 0,
          geometryFullyRendered: ![...state.geometryDiagnosticsByDevPath.values()].some(d => d.status === 'failed' || d.status === 'partial' || d.status === 'unsupported'),
          stlInstances: scopedRaw.stlCount,
        };
        perfMarkProductMoment('devGeometryReady', { ...fullMeta, path: 'progressive-dev-glb', renderedInstances: totalGeometryInstances }, perfSession);
        perfMarkProductMoment('fullModelReady', fullMeta, perfSession);
        await sampleSubstationMemory(state, 'fullModelReady', perfSession, { path: 'progressive-dev-glb', renderedInstances: totalGeometryInstances }, resourceCtx);
        scheduleSubstationResourceCheckpoint(state, 'idleAfterFullModel', perfSession, resourceCtx,
          { path: 'progressive-dev-glb', renderedInstances: totalGeometryInstances }, { isCurrent: () => state.isCurrentSession(session) });
      }
      return;
    }

    // 缓存命中：原有路径（GLB 快速路径 → SQLite 直通回退）
    const { autoLoadModAndStlGeometry } = await import('./modAutoLoadService.js');
    if (!state.isCurrentSession(session)) return;
    const result = await autoLoadModAndStlGeometry(
      state,
      scene,
      (p) => {
        if (!state.isCurrentSession(session)) return;
        if (p.phase === 'discovering') {
          showLoadingBeforeInteractive(`正在发现几何引用... (${p.currentPath || ''})`);
        } else if (p.phase === 'loading_mod') {
          showLoadingBeforeInteractive(`正在加载 MOD 模型 ${p.processedMods ?? p.loadedMods}/${p.totalMods}...`);
        } else if (p.phase === 'loading_stl') {
          showLoadingBeforeInteractive(`正在加载 STL 模型 ${p.loadedStls}/${p.totalStls}...`);
        } else if (p.phase === 'done') {
          // 后台几何加载结束必须隐藏提示，否则 toast 永久停留在最后一批的批前计数
          hideLoading();
        }
      },
      {
        token: options?.token,
        generation: session.generation,
        projectId: session.projectId,
        sourceSha256: session.sourceSha256,
        session,
        geometryCacheValid: options?.geometryCacheValid,
        geometryCacheManifestValid: options?.geometryCacheManifestValid,
        geometryCacheVersionFileMatch: options?.geometryCacheVersionFileMatch,
        onDevCheckpoint: options?.onDevCheckpoint,
        includeMod: options?.includeMod ?? true,
        includeStl: options?.includeStl ?? false,
      },
    );

    if (!state.isCurrentSession(session)) return;

    if (result.modCount > 0 || result.stlCount > 0) {
      debugLog(DEBUG_IFC_LOAD, '[GIM] MOD/STL 自动加载完成', result);
      // MOD/STL 加载后强制重新 fit 相机（bbox 可能显著变化）
      if (existingCtx) {
        const { fitCameraToScene } = await import('../viewer/camera.js');
        if (!state.isCurrentSession(session)) return;
        if (!state.selectionRequest?.target) fitCameraToScene(existingCtx, state, { force: true });
      }
    }
    finishModStl(undefined, {
      path: 'cached-geometry',
      modCount: result.modCount,
      stlCount: result.stlCount,
      ...(result.devGlbProfile ? { devGlbProfile: result.devGlbProfile } : {}),
    });
    if (result.devGlbProfile) {
      perfRecordDevGeometryProfile(result.devGlbProfile as unknown as Record<string, unknown>, perfSession);
    }
    if (!state.isCurrentSession(session)) return;
    if (!perfProductMomentSnapshot().firstGeometryReady
      && (result.modCount > 0 || result.stlCount > 0)) {
      perfMarkProductMoment('firstUsableGeometryReady', {
        kind: 'mod-stl',
        modCount: result.modCount,
        stlCount: result.stlCount,
      }, perfSession);
      if(resourceCtx&&state.modRootGroup)void observeFirstGeometry(state,resourceCtx,state.modRootGroup,session,hideLoading,perfSession).catch(reportBackgroundError);
      void Promise.resolve(sampleSubstationMemory(state, '第一个几何模型后', perfSession, {
        kind: 'mod-stl',
        modCount: result.modCount,
        stlCount: result.stlCount,
      })).catch(reportBackgroundError);
    }
    const fullMeta = {
      ifcModels: state.loadedModels.size,
      modInstances: result.modCount,
      stlInstances: result.stlCount,
      path: 'cached-geometry',
      sourceInvalidDevCount: [...state.geometryDiagnosticsByDevPath.values()].filter(d => d.reason === 'source-invalid').length,
      geometryFullyRendered: ![...state.geometryDiagnosticsByDevPath.values()].some(d => d.status === 'failed' || d.status === 'partial' || d.status === 'unsupported'),
    };
    perfMarkProductMoment('devGeometryReady', { ...fullMeta, path: 'cached-geometry' }, perfSession);
    perfMarkProductMoment('fullModelReady', fullMeta, perfSession);
    await sampleSubstationMemory(state, 'fullModelReady', perfSession, { path: 'cached-geometry', modCount: result.modCount, stlCount: result.stlCount }, resourceCtx);
    scheduleSubstationResourceCheckpoint(state, 'idleAfterFullModel', perfSession, resourceCtx,
      { path: 'cached-geometry', modCount: result.modCount, stlCount: result.stlCount }, { isCurrent: () => state.isCurrentSession(session) });
  } catch (err) {
    if (!modStlEnded) {
      endModStl?.('（失败）', { error: err instanceof Error ? err.message : String(err) });
      modStlEnded = true;
    }
    console.warn('[GIM] MOD/STL 自动加载失败:', err);
  }
}
