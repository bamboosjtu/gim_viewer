import * as THREE from 'three';
import type { AppState, ProjectLoadSession } from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';
import { DEBUG_IFC_LOAD } from '../../config/debug.js';
import { debugLog, logger } from '../../utils/logger.js';
import { getFileByPath } from '../../gim/fileLookup.js';
import { deviceOccurrenceScope } from '../../gim/substationEvidence.js';
import {
  getGeometryDiagnostic,
  diagnosticForFailure,
  setGeometryDiagnostic,
} from '../../gim/geometry/geometryDiagnostics.js';
import { InvalidDevGeometryError } from '../../gim/geometry/sourceGeometryError.js';
import { hasRenderableGeometry } from '../../viewer/geometryBounds.js';
import { applyProjectSourceToViewer } from '../project/coordinateAlignmentService.js';
import { getLoadedDevOccurrenceKind } from './devGlbTemplateRuntime.js';
import { ensureGeometryLayer } from './modGeometryScene.js';
import { readRawNodeGeometry } from './nodeGeometrySources.js';
import { tryLoadDevGlbForNode } from './nodeDevGlbLoader.js';
import type {
  DiscoveredGeometries,
  DiscoveredModGeometry,
  DiscoveredStlGeometry,
} from './modGeometryDiscovery.js';
import type { XmlModGeometryDiagnostics } from '../../viewer/xmlModLoader.js';

const pendingOccurrenceLoads = new WeakMap<AppState, Map<string, Promise<void>>>();

/** The occurrence owns geometry. Each selection applies its own effects after this promise. */
export async function prepareDeviceOccurrence(
  state: AppState,
  node: CbmNode,
  session: ProjectLoadSession,
): Promise<void> {
  if (!state.isCurrentSession(session)) return;
  const key = `${session.generation}:${session.geometryToken}:${node.path}`;
  const pending = pendingOccurrenceLoads.get(state) ?? new Map<string, Promise<void>>();
  pendingOccurrenceLoads.set(state, pending);
  let task = pending.get(key);
  if (!task) {
    task = loadDeviceOccurrence(state, node, session).catch((error) => {
      if (!state.isCurrentSession(session)) return;
      const reason =
        error instanceof InvalidDevGeometryError && error.sourceEvidence
          ? 'source-invalid'
          : 'parse-failed';
      setGeometryDiagnostic(
        state,
        diagnosticForFailure(
          node.devPath,
          reason,
          'raw',
          error instanceof Error ? error.message : String(error),
        ),
      );
    });
    pending.set(key, task);
  }
  try {
    await task;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}

async function loadDeviceOccurrence(
  state: AppState,
  node: CbmNode,
  session: ProjectLoadSession,
): Promise<void> {
  const current = () => state.isCurrentSession(session);
  const scope = deviceOccurrenceScope(state.currentCbmTree, node);
  if (!current() || scope.assemblyPaths?.length === 0) return;
  if (!state.currentFiles && session.projectId == null) return;

  const { getViewerRuntimeWithUI } = await import('../presentation/viewerUIBinding.js');
  if (!current()) return;
  const { ctx } = await getViewerRuntimeWithUI(state, () => {});
  if (!current()) return;
  const scene = ctx.world.scene.three as THREE.Scene;
  if (
    session.projectId != null &&
    node.devPath &&
    (await tryLoadDevGlbForNode(state, scene, node, session))
  )
    return;
  if (!current()) return;
  const sources = await readRawNodeGeometry(node, state, session);
  if (!current() || !sources) return;

  const { files, mods, stls } = sources;
  if (mods.length || stls.length) {
    await loadModOccurrences(state, scene, mods, files, current);
    if (!current()) return;
    await loadStlOccurrences(state, scene, stls, files, current);
  }
  if (current()) await publishRawGeometryDiagnostic(state, node, sources, current);
}

type Current = () => boolean;
type RawGeometry = DiscoveredGeometries & { files: Map<string, File> };

async function loadModOccurrences(
  state: AppState,
  scene: THREE.Scene,
  mods: readonly DiscoveredModGeometry[],
  discoveryFiles: Map<string, File>,
  current: Current,
): Promise<void> {
  const { loadXmlModFromFiles, applyPlacementTransformToSceneUnits } =
    await import('../../viewer/xmlModLoader.js');
  if (!current()) return;
  for (const geo of mods) {
    if (state.loadedXmlModGroups.has(geo.instanceKey)) {
      debugLog(DEBUG_IFC_LOAD, '[xml-mod] MOD 实例已加载，跳过:', geo.instanceKey);
      continue;
    }

    const group = await loadXmlModFromFiles(
      geo.modPath,
      discoveryFiles,
      geo.phmColor,
      geo.phmColorMaxA,
    );
    if (!current()) {
      group?.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
      return;
    }
    if (!group) continue;

    applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
    applyProjectSourceToViewer(group, state.projectSourceToViewerMatrix);
    const modRoot = ensureGeometryLayer(state, scene, 'mod');
    group.userData.devPath = geo.devPath;
    if (
      getLoadedDevOccurrenceKind(state, geo.rootOccurrence) === 'glb' ||
      state.loadedXmlModGroups.has(geo.instanceKey)
    ) {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
      continue;
    }
    group.userData.rootOccurrence = geo.rootOccurrence;
    group.userData.assemblyPath = geo.assemblyPath;
    group.userData.referencePath = geo.referencePath;
    modRoot.add(group);
    state.loadedXmlModGroups.set(geo.instanceKey, group);
  }
}

async function loadStlOccurrences(
  state: AppState,
  scene: THREE.Scene,
  stls: readonly DiscoveredStlGeometry[],
  discoveryFiles: Map<string, File>,
  current: Current,
): Promise<void> {
  const { applyPlacementTransformToSceneUnits } = await import('../../viewer/xmlModLoader.js');
  const { parseStlBinary } = await import('../../viewer/stlLoader.js');
  const { applyPhmColorOverride } = await import('../../viewer/xmlModGeometry.js');
  if (!current()) return;
  for (const geo of stls) {
    if (state.loadedStlGroups.has(geo.instanceKey)) {
      debugLog(DEBUG_IFC_LOAD, '[xml-mod] STL 实例已加载，跳过:', geo.instanceKey);
      continue;
    }

    const stlFile = getFileByPath(discoveryFiles, geo.stlPath);
    if (!stlFile) {
      logger.warn(`[xml-mod] STL 文件不存在: ${geo.stlPath}`);
      continue;
    }
    const buffer = await stlFile.arrayBuffer();
    if (!current()) return;
    const group = parseStlBinary(buffer, geo.stlPath);
    if (!group) continue;
    applyPhmColorOverride(group, geo.phmColor, geo.phmColorMaxA);

    applyPlacementTransformToSceneUnits(group, geo.placementTransformMatrix);
    applyProjectSourceToViewer(group, state.projectSourceToViewerMatrix);
    const stlRoot = ensureGeometryLayer(state, scene, 'stl');
    group.userData.devPath = geo.devPath;
    if (
      getLoadedDevOccurrenceKind(state, geo.rootOccurrence) === 'glb' ||
      state.loadedStlGroups.has(geo.instanceKey)
    ) {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
      continue;
    }
    group.userData.rootOccurrence = geo.rootOccurrence;
    group.userData.assemblyPath = geo.assemblyPath;
    group.userData.referencePath = geo.referencePath;
    stlRoot.add(group);
    state.loadedStlGroups.set(geo.instanceKey, group);
  }
}

async function checkReachability(
  devPath: string,
  files: Map<string, File>,
): Promise<string | undefined> {
  try {
    const { discoverGeometriesFromDevPath } = await import('./modGeometryDiscovery.js');
    await discoverGeometriesFromDevPath(
      devPath,
      files,
      new THREE.Matrix4().toArray(),
      new Set(),
      0,
      { instances: 0 },
      { strictDependencies: true },
    );
    return undefined;
  } catch (error) {
    return String(error);
  }
}

async function publishRawGeometryDiagnostic(
  state: AppState,
  node: CbmNode,
  sources: RawGeometry,
  current: Current,
): Promise<void> {
  const { files, mods, stls, reason } = sources;
  const reachabilityError = await checkReachability(node.devPath, files);
  if (!current()) return;
  if (!mods.length && !stls.length) {
    if (reachabilityError) {
      setGeometryDiagnostic(
        state,
        diagnosticForFailure(node.devPath, 'missing-dependency', 'raw', reachabilityError),
      );
    } else if (!getGeometryDiagnostic(state, node.devPath)) {
      setGeometryDiagnostic(state, {
        devPath: node.devPath,
        status: 'empty',
        source: 'raw',
        reason: reason ?? 'unknown',
        unsupportedPrimitiveTypeCounts: {},
        detail: '引用遍历已完成，没有可达 MOD/STL 主几何源。',
      });
    }
    return;
  }
  const { XML_MOD_GEOMETRY_DIAGNOSTICS_KEY } = await import('../../viewer/xmlModLoader.js');
  if (!current()) return;
  const groups = [
    ...mods.map((geo) => state.loadedXmlModGroups.get(geo.instanceKey)),
    ...stls.map((geo) => state.loadedStlGroups.get(geo.instanceKey)),
  ];
  const visible = groups.filter((group) => group && hasRenderableGeometry(group)).length;
  const missing = groups.filter((group) => !group).length;
  const xml = groups.flatMap((group) =>
    group?.userData[XML_MOD_GEOMETRY_DIAGNOSTICS_KEY]
      ? [group.userData[XML_MOD_GEOMETRY_DIAGNOSTICS_KEY] as XmlModGeometryDiagnostics]
      : [],
  );
  const degraded = xml.some(
    (diagnostic) => diagnostic.status === 'partial' || diagnostic.status === 'unsupported',
  );
  const types: Record<string, number> = {};
  const sourceDiagnostics = xml
    .flatMap((diagnostic) => diagnostic.sourceDiagnostics ?? [])
    .slice(0, 64);
  for (const diagnostic of xml)
    for (const [type, count] of Object.entries(diagnostic.unsupportedPrimitiveTypeCounts))
      types[type] = (types[type] ?? 0) + count;
  if (visible || missing || xml.length === groups.length) {
    const status = visible
      ? missing || reachabilityError || degraded
        ? 'partial'
        : 'renderable'
      : missing || reachabilityError
        ? 'failed'
        : degraded
          ? 'unsupported'
          : 'empty';
    setGeometryDiagnostic(state, {
      devPath: node.devPath,
      status,
      source: 'raw',
      unsupportedPrimitiveTypeCounts: types,
      ...(sourceDiagnostics.length ? { sourceDiagnostics } : {}),
      ...(missing || reachabilityError
        ? {
            reason: 'missing-dependency' as const,
            detail: `${missing} 个几何源加载失败；${visible} 个来源可显示。${reachabilityError ?? ''}`,
          }
        : sourceDiagnostics.length
          ? {
              reason: 'source-invalid' as const,
              detail: '源矩阵无效，位置待确认。已使用可浏览的回退表示。',
            }
          : degraded
            ? {
                reason: 'parser-unsupported' as const,
                detail: '部分来源或 primitive 暂不支持；只定位当前实例中可显示的几何。',
              }
            : {}),
      discoveredModCount: mods.length,
      discoveredStlCount: stls.length,
    });
  }
}
