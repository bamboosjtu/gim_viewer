/** MOD/STL load orchestration; compatibility exports keep existing callers stable. */
import * as THREE from 'three';
import { getSourceGeometryOccurrences } from './sourceGeometryService.js';
import type { AppState } from '../app/state.js';
import type { DiscoveredModGeometry, DiscoveredStlGeometry } from './modGeometryDiscovery.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { PARSER_LIMITS } from '../gim/parserLimits.js';
import { getLoadedDevOccurrenceKind } from './devGlbTemplateRuntime.js';
import { YIELD_MS, isGeometryContextValid } from './modGeometryContracts.js';
import type { AutoLoadProgress, GeometryAutoLoadOptions } from './modGeometryContracts.js';
import { tryDevGlbFastPath } from './devGlbCacheFastPath.js';
import type { DevGlbFastPathProfile } from './devGlbCacheFastPath.js';
import { buildFileMapFromDiskCache, loadModFile, loadStlFile } from './modGeometrySourceFiles.js';
import { loadScopedRawFallbackGeometry } from './modRawGeometryLoader.js';
import { recoverFailedDevGlbCaches } from './devGlbCacheRecovery.js';
import { ensureGeometryLayers, prepareModGroupForScene, prepareStlGroupForScene } from './modGeometryScene.js';
export { isGeometryTokenValid } from './modGeometryContracts.js';
export type { GeometryAutoLoadOptions, AutoLoadProgress } from './modGeometryContracts.js';
export { ensureGeometryLayers, diagnoseGroupBBox } from './modGeometryScene.js';
export { emptyFastPathProfile, tryDevGlbFastPath } from './devGlbCacheFastPath.js';
export type { DevGlbFastPathProfile, DevGlbFailureType, DevGlbFastPathResult } from './devGlbCacheFastPath.js';
export { recoverFailedDevGlbCaches } from './devGlbCacheRecovery.js';
export type { DevGlbCacheRecoveryResult, DevGlbCacheRecoveryDependencies } from './devGlbCacheRecovery.js';
export { loadScopedRawFallbackGeometry } from './modRawGeometryLoader.js';
export type { ScopedRawFallbackResult } from './modRawGeometryLoader.js';

/** 每批并发加载的文件数 */
const CONCURRENCY = 4;

/** 批次间 yield 间隔（毫秒），让浏览器有机会处理 UI 事件 */


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

  // 早期 token 校验：项目已切换则立即退出
  if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] token 不匹配，停止加载（项目已切换）');
    return { modCount: 0, stlCount: 0 };
  }

  showProgress({ phase: 'collecting', collectedDevPaths: 0, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
  const deviceNodes = await getSourceGeometryOccurrences(state, session);
  if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) return resultWithProfile(0, 0);
  const uniqueDevPaths = Array.from(new Set(deviceNodes.map((node) => node.devPath).filter((path): path is string => !!path)));

  debugLog(DEBUG_IFC_LOAD, `[autoLoad] 收集到 ${deviceNodes.length} 个 CBM 设备实例，${uniqueDevPaths.length} 个唯一 devPath`);

  if (deviceNodes.length === 0) {
    showProgress({ phase: 'done', collectedDevPaths: 0, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
    return { modCount: 0, stlCount: 0 };
  }

  // 语义/source cache 命中但 geometry manifest/version 失效时，只重建
  // DEV→PHM→MOD/STL→GLB 这一域。不要让该场景退化成 SQLite 全量 raw
  // 加载，也不要重新 native extract 或重建 CBM/IFC 语义索引。
  const geometryCacheNeedsRebuild = options.geometryCacheValid === false
    && !files
    && capturedProjectId != null
    // A structurally valid, current-version manifest can still be used for
    // DEV-granular isolation when one GLB file is missing/truncated.  Only a
    // missing/invalid manifest or a stale version requires rebuilding every
    // DEV from the disk source map.
    && (
      options.geometryCacheManifestValid === false
      || options.geometryCacheVersionFileMatch === false
      || (options.geometryCacheManifestValid === undefined
        && options.geometryCacheVersionFileMatch === undefined)
    );
  if (geometryCacheNeedsRebuild) {
    debugLog(DEBUG_IFC_LOAD, '[autoLoad] geometry cache 失效：从磁盘缓存准备几何源并重建 GLB');
    let rebuildFiles: Map<string, File> | null = null;
    try {
      rebuildFiles = await buildFileMapFromDiskCache(capturedProjectId, uniqueDevPaths, state.substationEntryPaths);
    } catch (error) {
      console.warn('[autoLoad] geometry cache 重建的源文件准备失败，保持语义缓存并停止几何域:', error);
    }
    if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
      return { modCount: 0, stlCount: 0 };
    }
    if (!rebuildFiles || rebuildFiles.size === 0) {
      showProgress({ phase: 'done', collectedDevPaths: deviceNodes.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });
      return resultWithProfile(0, 0);
    }

    const { runProgressiveDevGlbPipeline } = await import('./progressiveGeometryService.js');
    if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
      return { modCount: 0, stlCount: 0 };
    }
    const rebuilt = await runProgressiveDevGlbPipeline(
      state,
      scene,
      (p) => {
        if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) return;
        if (p.phase === 'compiling') {
          showProgress({
            phase: 'loading_mod',
            collectedDevPaths: deviceNodes.length,
            discoveredMods: deviceNodes.length,
            discoveredStls: 0,
            loadedMods: p.renderedInstances,
            loadedStls: 0,
            totalMods: deviceNodes.length,
            totalStls: 0,
            processedMods: p.compiledDevs,
            currentPath: p.currentDevPath,
          });
        } else {
          showProgress({
            phase: 'done',
            collectedDevPaths: deviceNodes.length,
            discoveredMods: deviceNodes.length,
            discoveredStls: 0,
            loadedMods: p.renderedInstances,
            loadedStls: 0,
            totalMods: deviceNodes.length,
            totalStls: 0,
            processedMods: p.compiledDevs,
          });
        }
      },
      {
        token,
        generation: capturedGeneration,
        projectId: capturedProjectId,
        sourceSha256: capturedSourceSha256,
        session,
        files: rebuildFiles,
        onDevCheckpoint: options.onDevCheckpoint,
      },
    );
    devGlbProfile = rebuilt.devGlbProfile;
    if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
      return { modCount: 0, stlCount: 0 };
    }

    // Progressive compiler 只对无法产生 GLB 的 DEV 返回 rawFallbackDevs；
    // 失败 DEV 之外的已渲染 GLB 永远保留。即使 scoped fallback 出错，也
    // 不回退整个项目，避免再次触发 substation02 的全量 MOD/STL 长尾。
    let scopedCount = { modCount: 0, stlCount: 0 };
    if (rebuilt.rawFallbackDevs.length > 0) {
      try {
        scopedCount = await loadScopedRawFallbackGeometry(
          state,
          scene,
          showProgress,
          rebuilt.rawFallbackDevs,
          includeMod,
          includeStl,
          token,
          capturedGeneration,
          capturedProjectId,
          capturedSourceSha256,
          session,
          devGlbProfile,
          rebuildFiles,
          deviceNodes,
          options.onDevCheckpoint,
        );
      } catch (error) {
        debugLog(DEBUG_IFC_LOAD, '[autoLoad] geometry rebuild scoped raw fallback 失败，保留成功 GLB', error);
      }
    }
    // Rebuild path uses the same source-template DEV fast path; no entity GLB
    // bundle is generated or keyed by an engineering entity.
    return resultWithProfile(rebuilt.renderedInstances + scopedCount.modCount, scopedCount.stlCount);
  }

  // ── Phase 1.2: source-template GLB fast path ──
  // Geometry assets are keyed by source DEV template and reused across all
  // engineering-entity occurrences. Entity identity never becomes a GLB key.
  const devGlbResult = await tryDevGlbFastPath(state, scene, deviceNodes, showProgress, token, undefined, {
    generation: capturedGeneration,
    projectId: capturedProjectId,
    sourceSha256: capturedSourceSha256,
    session,
    geometryCacheValid: options.geometryCacheValid,
    onDevCheckpoint: options.onDevCheckpoint,
  });
  devGlbProfile = devGlbResult.profile;
  if (devGlbResult.loaded) {
    let fastPathResult = devGlbResult;
    let failedDevPaths = fastPathResult.profile.failedDevPaths;
    const recoveryEligible = failedDevPaths.length > 0
      && capturedProjectId != null
      && capturedSourceSha256 != null
      && !files;
    if (recoveryEligible) {
      const recovery = await recoverFailedDevGlbCaches(
        state,
        failedDevPaths,
        files,
        {
          token,
          generation: capturedGeneration,
          projectId: capturedProjectId,
          sourceSha256: capturedSourceSha256,
          session,
          onDevCheckpoint: options.onDevCheckpoint,
        },
      );
      const attempted = failedDevPaths.length;
      const recoveryMeta = {
        cacheRecoveryAttemptCount: attempted,
        cacheRecoverySuccessCount: recovery.repairedDevPaths.length,
        cacheRecoveryEmptyCount: recovery.emptyDevPaths.length,
        cacheRecoveryFailureCount: recovery.unresolvedDevPaths.length,
        cacheRecoveryDevPaths: [
          ...recovery.repairedDevPaths,
          ...recovery.emptyDevPaths,
          ...recovery.unresolvedDevPaths,
        ],
      };
      devGlbProfile = { ...devGlbProfile, ...recoveryMeta };
      if (recovery.repairedDevPaths.length > 0 || recovery.emptyDevPaths.length > 0) {
        // Reuse the existing placement/scene path. It skips already loaded
        // successful placements and parses only newly repaired GLBs.
        const retry = await tryDevGlbFastPath(
          state,
          scene,
          deviceNodes,
          showProgress,
          token,
          undefined,
          {
            generation: capturedGeneration,
            projectId: capturedProjectId,
            sourceSha256: capturedSourceSha256,
            session,
            geometryCacheValid: options.geometryCacheValid,
            onDevCheckpoint: options.onDevCheckpoint,
          },
        );
        if (retry.loaded) {
          fastPathResult = retry;
          failedDevPaths = retry.profile.failedDevPaths;
          devGlbProfile = { ...retry.profile, ...recoveryMeta };
        }
      }
    }
    // A failed DEV can be recovered from the in-memory source map in browser
    // mode as well as from the SQLite index in Tauri.  Do not gate this on
    // projectId alone, otherwise a browser session would silently omit the
    // only failed DEV while keeping the successful GLB placements.
    if (failedDevPaths.length > 0 && (capturedProjectId != null || files != null)) {
      try {
        const scoped = await loadScopedRawFallbackGeometry(
          state,
          scene,
          showProgress,
          failedDevPaths,
          includeMod,
          includeStl,
          token,
          capturedGeneration,
          capturedProjectId,
          capturedSourceSha256,
          session,
          devGlbProfile,
          files,
          deviceNodes,
          options.onDevCheckpoint,
        );
        if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) {
          return resultWithProfile(0, 0);
        }
        return {
          modCount: fastPathResult.modCount + scoped.modCount,
          stlCount: fastPathResult.stlCount + scoped.stlCount,
          devGlbProfile,
        };
      } catch (error) {
        // 失败 DEV 的 scoped 查询失败不应清理已成功的 GLB；保留当前
        // 场景并将错误写入诊断，调用方仍可继续使用成功实例。
        debugLog(DEBUG_IFC_LOAD, '[autoLoad] scoped raw fallback 失败，保留成功 GLB', error);
        return { modCount: fastPathResult.modCount, stlCount: fastPathResult.stlCount, devGlbProfile };
      }
    }
    return { modCount: fastPathResult.modCount, stlCount: fastPathResult.stlCount, devGlbProfile };
  }

  if (!files && capturedProjectId != null) {
    files = await buildFileMapFromDiskCache(capturedProjectId, uniqueDevPaths, state.substationEntryPaths);
    if (!isGeometryContextValid(state, token, capturedGeneration, capturedProjectId, capturedSourceSha256)) return resultWithProfile(0, 0);
  }
  if (!files) return resultWithProfile(0, 0);

  // ── Phase 2: 发现几何源（遍历 CBM 实例 → DEV → PHM → MOD/STL） ──
  // 注意：deviceNodes 可能很大（数千），必须节流 showProgress + 频繁 yield
  showProgress({ phase: 'discovering', collectedDevPaths: deviceNodes.length, discoveredMods: 0, discoveredStls: 0, loadedMods: 0, loadedStls: 0, totalMods: 0, totalStls: 0 });

  const { discoverGeometriesFromDevPath } = await import('./modGeometryDiscovery.js');

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
      const result = await discoverGeometriesFromDevPath(node.devPath, files, node.placementMatrix, new Set(), 0, { instances: 0 }, { rootOccurrence: node.id });
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
    for (let i = 0;i < modGeos.length;i += CONCURRENCY) {
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
            group.userData.devPath = geo.devPath;
            if (getLoadedDevOccurrenceKind(state, geo.rootOccurrence) === 'glb' || ('modPath' in geo ? state.loadedXmlModGroups : state.loadedStlGroups).has(geo.instanceKey)) {
              group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); continue;
            }
            group.userData.rootOccurrence = geo.rootOccurrence;
            group.userData.assemblyPath = geo.assemblyPath;
            group.userData.referencePath = geo.referencePath;
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
    for (let i = 0;i < stlGeos.length;i += CONCURRENCY) {
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
            group.userData.devPath = geo.devPath;
            if (getLoadedDevOccurrenceKind(state, geo.rootOccurrence) === 'glb' || ('modPath' in geo ? state.loadedXmlModGroups : state.loadedStlGroups).has(geo.instanceKey)) {
              group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); continue;
            }
            group.userData.rootOccurrence = geo.rootOccurrence;
            group.userData.assemblyPath = geo.assemblyPath;
            group.userData.referencePath = geo.referencePath;
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
      // 这里只标记，不实际 fit（fit 由 Substation Runtime 在 autoLoad 完成后统一调用）
    } catch {
      // ignore
    }
  }

  return { modCount: loadedMods, stlCount: loadedStls, devGlbProfile };
}
