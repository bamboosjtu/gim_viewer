/** Scoped MOD/STL fallback for explicit DEV occurrences. */
import * as THREE from 'three';
import type { SourceGeometryOccurrence } from '../gim/engineering/geometryOccurrences.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { DevCheckpointHandler } from './substationBackgroundRuntime.js';
import type { DiscoveredModGeometry, DiscoveredStlGeometry } from './modGeometryDiscovery.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { getLoadedDevOccurrenceKind } from './devGlbTemplateRuntime.js';
import { isGeometryContextValid } from './modGeometryContracts.js';
import type { AutoLoadProgress } from './modGeometryContracts.js';
import { disposeFastPathGroup } from './devGlbCacheFastPath.js';
import type { DevGlbFastPathProfile } from './devGlbCacheFastPath.js';
import { buildFileMapFromDiskCache, normalizeDevEntryPath, loadModFile, loadStlFile } from './modGeometrySourceFiles.js';
import { multiplyTransformMatrices, ensureGeometryLayers, prepareModGroupForScene, prepareStlGroupForScene } from './modGeometryScene.js';
import { YIELD_MS } from './modGeometryContracts.js';

export interface ScopedRawFallbackResult {
  modCount: number;
  stlCount: number;
  rows: number;
}

/**
 * 仅恢复 GLB 失败 DEV 的可达 MOD/STL。
 *
 * 该路径刻意不触碰已加入 scene 的 GLB group，也不调用 cleanupAndFail。
 * Rust 查询会沿 SUBDEVICE 展开传入的 DEV 集合，因此一个失败父 DEV 的
 * 嵌套 child DEV 也会被包含；返回行同时带 dev_path，便于诊断和旧桥接
 * 版本下的兼容过滤。
 */
export async function loadScopedRawFallbackGeometry(
  state: AppState,
  scene: THREE.Scene,
  showProgress: (p: AutoLoadProgress) => void,
  failedDevPaths: string[],
  includeMod: boolean,
  includeStl: boolean,
  token: number | undefined,
  generation: number,
  projectId: number | null,
  sourceSha256: string | null,
  session: ProjectLoadSession,
  profile?: DevGlbFastPathProfile,
  sourceFiles?: Map<string, File> | null,
  deviceNodes: SourceGeometryOccurrence[] = [],
  onDevCheckpoint?: DevCheckpointHandler,
): Promise<ScopedRawFallbackResult> {
  // Source-file fallback is also valid in browser/non-Tauri mode, where no
  // SQLite project id exists.  Only the disk-backed branch requires
  // projectId; returning early here used to silently drop a failed DEV when
  // the caller already had the in-memory GIM file map available.
  if (failedDevPaths.length === 0 || (projectId == null && !sourceFiles)) {
    return { modCount: 0, stlCount: 0, rows: 0 };
  }
  const started = performance.now();
  // AppState always exposes isCurrentSession at runtime, but keep the
  // geometry-context fallback for lightweight/unit-test state doubles and for
  // older embedders.  The fallback still checks the same generation, project,
  // source-SHA and geometry-token fence, so it does not weaken stale-work
  // isolation.
  const isCurrent = () => {
    const sessionValid = typeof state.isCurrentSession === 'function'
      ? state.isCurrentSession(session)
      : isGeometryContextValid(state, token, generation, projectId, sourceSha256);
    return sessionValid && isGeometryContextValid(state, token, generation, projectId, sourceSha256);
  };

  const modGeos: DiscoveredModGeometry[] = [];
  const modFilterPlacements = new Map<string, number[]>();
  const stlGeos: DiscoveredStlGeometry[] = [];
  let reachableRows = 0;
  let geometryFiles = sourceFiles ?? null;
  let readMs = 0;

  sourceFiles ??= projectId == null ? null : await buildFileMapFromDiskCache(projectId, failedDevPaths, state.substationEntryPaths);
  if (!isCurrent() || !sourceFiles) return { modCount: 0, stlCount: 0, rows: 0 };
  geometryFiles = sourceFiles;
  {
    // 冷路径已经拥有完整 GIM 文件 Map：只从失败 DEV 的 CBM seed 开始
    // 重新发现 DEV→PHM→MOD/STL，不能把成功 GLB 的 DEV 再扫一遍。
    // 同一失败 DEV 可能有很多 CBM placement；几何依赖文本只能解析一次，
    // 然后把 DEV 内部（不含 CBM）的 placement 矩阵套到每个 seed 上。
    // 这样 scoped fallback 不会把“一个失败 DEV × 数百 placement”放大成
    // 数百次 DEV/PHM text + XML 解析。
    const { discoverGeometriesFromDevPath } = await import('./modGeometryDiscovery.js');
    const failedKeys = new Set(failedDevPaths.map((path) => normalizeDevEntryPath(path).toLowerCase()));
    // Nested leaves belong to the failed root occurrence, even if their
    // DEV template is also used under an independently successful root.
    const scopedMods = new Map<string, DiscoveredModGeometry>();
    const scopedStls = new Map<string, DiscoveredStlGeometry>();

    const failedSeedsByDev = new Map<string, SourceGeometryOccurrence[]>();
    for (const seed of deviceNodes) {
      if (!seed.devPath) continue;
      const key = normalizeDevEntryPath(seed.devPath).toLowerCase();
      if (!failedKeys.has(key)) continue;
      const seeds = failedSeedsByDev.get(key) ?? [];
      seeds.push(seed);
      failedSeedsByDev.set(key, seeds);
    }

    // Identity is deliberately local to this fallback.  The discovery result
    // carries DEV/PHM transforms only; CBM placement is applied below per seed.
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const [failedKey, seeds] of failedSeedsByDev) {
      if (!isCurrent()) return { modCount: 0, stlCount: 0, rows: reachableRows };
      const devPath = seeds[0]?.devPath
        ? normalizeDevEntryPath(seeds[0].devPath)
        : failedDevPaths.find((path) => normalizeDevEntryPath(path).toLowerCase() === failedKey);
      if (!devPath) continue;

      let discovered;
      try {
        discovered = await discoverGeometriesFromDevPath(
          devPath,
          sourceFiles,
          identity.slice(),
          new Set<string>(),
        );
      } catch (error) {
        // A malformed/missing dependency belongs to this failed DEV only.  Do
        // not abort fallback for other failed DEV paths or remove successful
        // GLB groups already in the scene.
        console.warn(`[autoLoad] scoped DEV 发现失败: ${devPath}`, error);
        continue;
      }

      for (const seed of seeds) {
        if (!isCurrent()) return { modCount: 0, stlCount: 0, rows: reachableRows };
        const cbmTransform = seed.placementMatrix;
        for (const geo of discovered.mods) {
          // Preserve every child placement belonging to this failed root.
          if (!includeMod) continue;
          const placementTransformMatrix = multiplyTransformMatrices(
            cbmTransform,
            geo.placementTransformMatrix,
          );
          scopedMods.set(`raw:${seed.id}${geo.referencePath}`, {
            ...geo,
            instanceKey: `raw:${seed.id}${geo.referencePath}`,
            rootOccurrence: seed.id,
            placementTransformMatrix,
          });
          modFilterPlacements.set(`raw:${seed.id}${geo.referencePath}`, geo.placementTransformMatrix);
        }
        for (const geo of discovered.stls) {
          if (!includeStl) continue;
          const placementTransformMatrix = multiplyTransformMatrices(
            cbmTransform,
            geo.placementTransformMatrix,
          );
          scopedStls.set(`raw:${seed.id}${geo.referencePath}`, {
            ...geo,
            instanceKey: `raw:${seed.id}${geo.referencePath}`,
            rootOccurrence: seed.id,
            placementTransformMatrix,
          });
        }
      }
    }
    modGeos.push(...scopedMods.values());
    stlGeos.push(...scopedStls.values());
    reachableRows = modGeos.length + stlGeos.length;
  }
  if (profile) {
    profile.partialRawFallbackRows = reachableRows;
    profile.partialRawFallbackReadMs = readMs;
  }

  const { applyPlacementTransformToSceneUnits, XML_MOD_GEOMETRY_DIAGNOSTICS_KEY } = await import('../viewer/xmlModLoader.js');
  // SQLite rows include CBM placement; filtering a shared DEV template does not.
  const inversePlacements = new Map<string, THREE.Matrix4>();
  const inverseRoots = new Set(modGeos.filter(geo => !modFilterPlacements.has(geo.instanceKey)).map(geo => geo.rootOccurrence));
  for (const seed of deviceNodes) {
    if (!inverseRoots.has(seed.id)) continue;
    const matrix = new THREE.Matrix4().fromArray(seed.placementMatrix);
    if (matrix.determinant() !== 0) inversePlacements.set(seed.id, matrix.invert());
  }
  const filterPlacement = (geo: DiscoveredModGeometry): number[] => {
    const known = modFilterPlacements.get(geo.instanceKey);
    if (known) return known;
    const inverse = geo.rootOccurrence ? inversePlacements.get(geo.rootOccurrence) : undefined;
    return inverse ? inverse.clone().multiply(new THREE.Matrix4().fromArray(geo.placementTransformMatrix)).toArray() : geo.placementTransformMatrix;
  };
  const smallFallbacks = new Map<string, { geo: DiscoveredModGeometry; extent: number }>();
  const { modRoot, stlRoot } = ensureGeometryLayers(state, scene);
  let loadedMods = 0;
  let loadedStls = 0;
  let parseMs = 0;
  let skippedBadBBox = 0;
  const allModCount = modGeos.length;
  if (isCurrent()) await onDevCheckpoint?.({ phase: 'raw-prepare', path: failedDevPaths.join('|'), durationMs: performance.now() - started });
  const allStlCount = stlGeos.length;

  for (let i = 0;i < modGeos.length;i++) {
    const unitStarted = performance.now();
    try {
      if (!isCurrent()) return { modCount: loadedMods, stlCount: loadedStls, rows: reachableRows };
      const geo = modGeos[i];
      showProgress({
        phase: 'loading_mod',
        collectedDevPaths: failedDevPaths.length,
        discoveredMods: allModCount,
        discoveredStls: allStlCount,
        loadedMods,
        loadedStls,
        totalMods: allModCount,
        totalStls: allStlCount,
        currentPath: geo.modPath,
        processedMods: i,
      });
      if (state.loadedXmlModGroups.has(geo.instanceKey)) {
        loadedMods++;
        continue;
      }
      const parseStarted = performance.now();
      try {
        const group = await loadModFile(geo, geometryFiles ?? new Map(), {
          placementMatrix: filterPlacement(geo), deferSmallPartFallback: true,
        });
        parseMs += Math.max(0, performance.now() - parseStarted);
        if (!group) {
          loadedMods++;
          continue;
        }
        if (!isCurrent()) {
          disposeFastPathGroup(group);
          return { modCount: loadedMods, stlCount: loadedStls, rows: reachableRows };
        }
        const diagnostic = group.userData[XML_MOD_GEOMETRY_DIAGNOSTICS_KEY];
        if (geo.rootOccurrence && diagnostic?.omittedSmallParts) {
          const extent = diagnostic.omittedMaxExtentMm ?? 0;
          if (!smallFallbacks.has(geo.rootOccurrence) || extent > smallFallbacks.get(geo.rootOccurrence)!.extent)
            smallFallbacks.set(geo.rootOccurrence, { geo, extent });
        }
        if (!prepareModGroupForScene(group, geo.modPath, applyPlacementTransformToSceneUnits, geo.placementTransformMatrix, state.projectSourceToViewerMatrix)) {
          skippedBadBBox++;
          loadedMods++;
          continue;
        }
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
      } catch (error) {
        parseMs += Math.max(0, performance.now() - parseStarted);
        console.warn(`[autoLoad] scoped MOD 加载失败: ${geo.modPath}`, error);
        loadedMods++;
      }
      if (i + 1 < modGeos.length) await new Promise((resolve) => setTimeout(resolve, YIELD_MS));
    } finally {
      if (isCurrent()) await onDevCheckpoint?.({ phase: 'raw-commit', path: modGeos[i].modPath, durationMs: performance.now() - unitStarted });
    }
  }

  for (let i = 0;i < stlGeos.length;i++) {
    const unitStarted = performance.now();
    try {
      if (!isCurrent()) return { modCount: loadedMods, stlCount: loadedStls, rows: reachableRows };
      const geo = stlGeos[i];
      showProgress({
        phase: 'loading_stl',
        collectedDevPaths: failedDevPaths.length,
        discoveredMods: allModCount,
        discoveredStls: allStlCount,
        loadedMods,
        loadedStls,
        totalMods: allModCount,
        totalStls: allStlCount,
        currentPath: geo.stlPath,
      });
      if (state.loadedStlGroups.has(geo.instanceKey)) {
        loadedStls++;
        continue;
      }
      const parseStarted = performance.now();
      try {
        const group = await loadStlFile(geo, geometryFiles ?? new Map());
        parseMs += Math.max(0, performance.now() - parseStarted);
        if (!group) {
          loadedStls++;
          continue;
        }
        if (!isCurrent()) {
          disposeFastPathGroup(group);
          return { modCount: loadedMods, stlCount: loadedStls, rows: reachableRows };
        }
        if (!prepareStlGroupForScene(group, geo.stlPath, applyPlacementTransformToSceneUnits, geo.placementTransformMatrix, state.projectSourceToViewerMatrix)) {
          skippedBadBBox++;
          loadedStls++;
          continue;
        }
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
      } catch (error) {
        parseMs += Math.max(0, performance.now() - parseStarted);
        console.warn(`[autoLoad] scoped STL 加载失败: ${geo.stlPath}`, error);
        loadedStls++;
      }
      if (i + 1 < stlGeos.length) await new Promise((resolve) => setTimeout(resolve, YIELD_MS));
    } finally {
      if (isCurrent()) await onDevCheckpoint?.({ phase: 'raw-commit', path: stlGeos[i].stlPath, durationMs: performance.now() - unitStarted });
    }
  }

  // Deferred filtering is safe only with the same all-small DEV fallback as
  // GLB compilation. STL/other MOD geometry suppresses this extra silhouette.
  const shownRoots = new Set<string>();
  for (const groups of [state.loadedXmlModGroups, state.loadedStlGroups])
    for (const group of groups.values()) if (group.userData.rootOccurrence) shownRoots.add(group.userData.rootOccurrence);
  for (const [root, { geo }] of smallFallbacks) {
    if (!isCurrent()) return { modCount: loadedMods, stlCount: loadedStls, rows: reachableRows };
    if (shownRoots.has(root)) continue;
    const fallbackStarted = performance.now();
    try {
      const group = await loadModFile(geo, geometryFiles ?? new Map(), { placementMatrix: filterPlacement(geo) });
      if (!group) continue;
      if (!isCurrent()) { disposeFastPathGroup(group); return { modCount: loadedMods, stlCount: loadedStls, rows: reachableRows }; }
      if (!prepareModGroupForScene(group, geo.modPath, applyPlacementTransformToSceneUnits, geo.placementTransformMatrix, state.projectSourceToViewerMatrix)) continue;
      Object.assign(group.userData, { devPath: geo.devPath, rootOccurrence: root, assemblyPath: geo.assemblyPath, referencePath: geo.referencePath });
      modRoot.add(group); state.loadedXmlModGroups.set(geo.instanceKey, group);
    } catch (error) { console.warn(`[autoLoad] 小设备轮廓回退失败: ${geo.modPath}`, error); }
    finally { parseMs += performance.now() - fallbackStarted; }
    await new Promise(resolve => setTimeout(resolve, YIELD_MS));
  }
  if (profile) {
    profile.partialRawFallbackParseMs = parseMs;
    profile.partialRawFallbackMs = Math.max(0, performance.now() - started);
  }
  debugLog(DEBUG_IFC_LOAD, '[autoLoad] scoped raw fallback 完成', {
    failedDevPaths,
    rows: reachableRows,
    modInstances: loadedMods,
    stlInstances: loadedStls,
    skippedBadBBox,
    readMs,
    parseMs,
  });
  showProgress({
    phase: 'done',
    collectedDevPaths: failedDevPaths.length,
    discoveredMods: allModCount,
    discoveredStls: allStlCount,
    loadedMods,
    loadedStls,
    totalMods: allModCount,
    totalStls: allStlCount,
  });
  return { modCount: loadedMods, stlCount: loadedStls, rows: reachableRows };
}
