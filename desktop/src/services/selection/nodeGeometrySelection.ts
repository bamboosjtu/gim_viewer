import * as THREE from 'three';
import type {
  AppState,
  ProjectLoadSession,
  SelectionGeometryState,
  SelectionRequest,
} from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';
import type { ViewerContext } from '../../viewer/viewerEngine.js';
import { collectIfcRefs } from '../../gim/cbmParser.js';
import { deviceOccurrenceScope, type DeviceOccurrenceScope } from '../../gim/substationEvidence.js';
import {
  geometryDiagnosticSummary,
  getGeometryDiagnostic,
} from '../../gim/geometry/geometryDiagnostics.js';
import { hasRenderableGeometry } from '../../viewer/geometryBounds.js';
import { perfMarkProductMoment } from '../../utils/perfTimings.js';
import { resolveGeometryLoadNode } from '../dev-geometry/nodeGeometrySources.js';
import { selectionMessage } from './nodeSelectionFeedback.js';
import { beginSelectionStage } from './selectionTiming.js';

/**
 * 将 devPath 归一化为可比较的形式（去除 DEV/ 前缀，小写）。
 *
 * 用于 collectDeviceGroups 匹配：
 * - geometryNode.devPath 形如 "abc.dev"（无 DEV/ 前缀）
 * - group.userData.devPath 形如 "DEV/abc.dev"（DEV LOD 标记）
 * 归一化后两者可正确比较。
 */
function normalizeDevPathForCompare(devPath: string | undefined): string {
  if (!devPath) return '';
  const p = devPath.replace(/\\/g, '/').toLowerCase();
  return p.startsWith('dev/') ? p.slice(4) : p;
}

export function describeNodeSelectionGeometry(
  state: AppState,
  node: CbmNode,
  attempted = false,
): SelectionGeometryState {
  const scope = deviceOccurrenceScope(state.currentCbmTree, node);
  if (scope.assemblyPaths?.length === 0)
    return { status: 'unlinked', detail: '部件未关联到真实 DEV 装配路径；保留相机位置。' };
  const diagnostic = getGeometryDiagnostic(state, node.devPath);
  if ((scope.assemblyPaths?.length ?? 0) > 1)
    return {
      status: 'ambiguous',
      detail: `部件存在 ${scope.assemblyPaths!.length} 条装配路径，将定位所属设备内的全部候选。${diagnostic ? `几何状态：${geometryDiagnosticSummary(diagnostic)}` : '部件完整性尚未获得确定性诊断。'}`,
    };
  if (diagnostic)
    return { status: diagnostic.status, detail: geometryDiagnosticSummary(diagnostic) };
  if (node.devPath) {
    const groups = collectDeviceGroups(state, node.devPath, scope);
    if (groups.some(hasRenderableGeometry))
      return { status: 'available', detail: '已有可显示几何；完整性尚未获得确定性诊断。' };
    const owner = resolveGeometryLoadNode(state.currentCbmTree, node);
    const parentDiagnostic =
      owner !== node ? getGeometryDiagnostic(state, owner.devPath) : undefined;
    if (parentDiagnostic && ['failed', 'empty', 'unsupported'].includes(parentDiagnostic.status))
      return {
        status: parentDiagnostic.status,
        detail: `所属装配设备：${geometryDiagnosticSummary(parentDiagnostic)}`,
      };
    return attempted
      ? { status: 'unknown', detail: '当前没有可显示几何；尚无确定性诊断，不能判为空模型。' }
      : { status: 'not-loaded', detail: '当前设备几何尚未加载。' };
  }
  if (collectIfcRefs(node, state.currentIfcEntries).size > 0)
    return {
      status: attempted ? 'unknown' : 'not-loaded',
      detail: attempted ? '未找到可显示的直接 GUID 关联构件。' : '正在读取直接 IFC 对象关联。',
    };
  if (node.ifcFile || state.deviceToIfcFile.has(node.path.split('/').pop() || ''))
    return {
      status: 'file-only',
      detail: '只有 IFC 文件来源，没有直接对象 GUID 关联；保留相机位置。',
    };
  return {
    status: 'unassociated',
    detail: '此对象没有可定位的设备几何或直接 IFC 对象关联；保留相机位置。',
  };
}

/**
 * 收集指定 devPath 对应的所有已加载 Group（MOD + STL）。
 *
 * 遍历 state.loadedXmlModGroups 和 state.loadedStlGroups，查找
 * scope 指定根放置实例和实际装配候选子树。无 scope 时才显式按 DEV
 * 模板收集全部实例。用于相机定位和高亮。
 */
export function collectDeviceGroups(
  state: AppState,
  devPath: string,
  scope?: DeviceOccurrenceScope,
): THREE.Object3D[] {
  const normalized = normalizeDevPathForCompare(devPath);
  if (!normalized) return [];
  const result: THREE.Object3D[] = [];
  const seen = new Set<THREE.Object3D>();
  // The runtime owns one complete placement subtree per physical occurrence.
  // Legacy/raw loading and template-wide queries retain the full-map path.
  const loadedRoot = scope
    ? state.deviceLodRuntime?.getLoadedRoot?.(scope.rootOccurrence)
    : undefined;
  const roots = loadedRoot
    ? [loadedRoot]
    : [...state.loadedXmlModGroups.values(), ...state.loadedStlGroups.values()];
  for (const root of roots) {
    root.traverse((object) => {
      // GLTFLoader restores source group nodes as Object3D, which still owns
      // the complete renderable subtree. Identity must not depend on isGroup.
      const group = object;
      if (seen.has(group)) return;
      let owner: THREE.Object3D | null = group;
      while (owner && !owner.userData.rootOccurrence) owner = owner.parent;
      const inRoot = !scope || owner?.userData.rootOccurrence === scope.rootOccurrence;
      const assembly = String(group.userData.assemblyPath ?? '');
      const inAssembly =
        !scope?.assemblyPaths ||
        scope.assemblyPaths.some((path) => assembly === path || assembly.startsWith(`${path}/`));
      const matches = scope
        ? !!group.userData.devPath
        : normalizeDevPathForCompare(group.userData.devPath as string | undefined) === normalized;
      if (inRoot && inAssembly && matches) {
        // A selected ancestor already contains these meshes; returning both
        // would highlight them twice and overwrite original material tracking.
        for (let parent = group.parent; parent; parent = parent.parent) {
          if (seen.has(parent)) return;
        }
        seen.add(group);
        result.push(group);
      }
    });
  }
  return result;
}

/**
 * 将相机定位到指定 devPath 对应的已加载几何并高亮。
 *
 * 流程：
 * 1. collectDeviceGroups 收集匹配的 Group
 * 2. 合并包围盒，调用 frameBox 定位相机
 * 3. resetHighlight 清除旧高亮（IFC + MOD）
 * 4. highlightModGroups 高亮该设备的所有 MOD/STL Group
 *
 * 设计动机：
 * - 替代旧的 fitCameraToScene（仅首次加载时定位整个场景）
 * - 用户每次点击 MOD 设备节点都应将视点聚焦到该设备并高亮
 */
export async function frameAndHighlightDevice(
  ctx: ViewerContext,
  state: AppState,
  devPath: string,
  scope: DeviceOccurrenceScope,
  session: ProjectLoadSession = state.captureProjectSession(),
  request?: SelectionRequest,
): Promise<void> {
  if (!state.isCurrentSession(session)) return;
  request ??= state.selection.beginSelection({ kind: 'cbm', key: scope.rootOccurrence });
  const guard = state.selection.selectionGuard(request);
  if (!state.isCurrentSession(session) || !guard.isCurrent()) return;
  if (state.deviceLodRuntime) {
    const runtime = state.deviceLodRuntime;
    if (runtime.ensureBase) await runtime.ensureBase(scope.rootOccurrence);
    else await runtime.select(scope.rootOccurrence);
  }
  if (!guard.isCurrent()) return;
  const endCollect = beginSelectionStage(state, request, 'collectGroups');
  let groups: THREE.Object3D[];
  try {
    groups = collectDeviceGroups(state, devPath, scope).filter(hasRenderableGeometry);
  } finally {
    endCollect();
  }
  const { commitSelectionHighlight, highlightModGroups } =
    await import('../../viewer/highlight.js');
  await commitSelectionHighlight(ctx, state, guard, () => highlightModGroups(state, groups));
  if (!guard.isCurrent() || groups.length === 0 || !state.selection.canAutoLocate(request)) return;
  const box = new THREE.Box3();
  groups.forEach((g) => box.expandByObject(g));
  if (
    state.currentProjectType === 'substation' &&
    state.currentFiles &&
    !box.isEmpty() &&
    [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite)
  ) {
    perfMarkProductMoment('coldSelectedDeviceGeometryReady', {
      selectionKey: request.target?.key,
      devPath,
      rootOccurrence: scope.rootOccurrence,
      groups: groups.length,
    });
  }
  const { frameBox } = await import('../../viewer/camera.js');
  if (!state.selection.canAutoLocate(request)) return;
  const owned = state.selection.highlightedModState;
  const { resetModHighlight } = await import('../../viewer/highlight.js');
  const clearOwned = () => {
    if (state.selection.highlightedModState === owned) resetModHighlight(state);
  };
  request.signal.addEventListener('abort', clearOwned, { once: true });
  const endFrame = beginSelectionStage(state, request, 'frame');
  try {
    await frameBox(ctx, box, guard);
  } finally {
    endFrame();
    request.signal.removeEventListener('abort', clearOwned);
  }
}

/** Prepare project-owned geometry, then apply selection effects only for the latest request. */
export async function loadModStlForNode(
  state: AppState,
  node: CbmNode,
  session: ProjectLoadSession = state.captureProjectSession(),
  request?: SelectionRequest,
): Promise<void> {
  if (!state.isCurrentSession(session)) return;
  request ??= state.selection.beginSelection({ kind: 'cbm', key: node.path });
  const scope = deviceOccurrenceScope(state.currentCbmTree, node);
  const root = resolveGeometryLoadNode(state.currentCbmTree, node);
  const message = selectionMessage(state, request);
  const runtime = state.deviceLodRuntime;
  if (runtime) {
    try {
      if (runtime.ensureBase) await runtime.ensureBase(root.path);
      else await runtime.select(root.path);
    } catch (error) {
      message(`设备几何加载失败: ${String(error)}`);
    }
  } else {
    const known = getGeometryDiagnostic(state, node.devPath);
    const alreadyLoaded =
      scope.assemblyPaths?.length &&
      scope.assemblyPaths.every((path) =>
        collectDeviceGroups(state, node.devPath, { ...scope, assemblyPaths: [path] }).some(
          hasRenderableGeometry,
        ),
      );
    if (
      known?.reason !== 'source-invalid' &&
      getGeometryDiagnostic(state, root.devPath)?.reason !== 'source-invalid' &&
      !alreadyLoaded &&
      scope.assemblyPaths?.length !== 0 &&
      known?.status !== 'empty' &&
      known?.status !== 'unsupported'
    ) {
      const rootScope = root === node ? scope : deviceOccurrenceScope(state.currentCbmTree, root);
      const loadedPart =
        root.entityName.toUpperCase() === 'PARTINDEX' &&
        rootScope.assemblyPaths?.every(
          (path) =>
            collectDeviceGroups(state, root.devPath, { ...rootScope, assemblyPaths: [path] })
              .length > 0,
        );
      if (!loadedPart) {
        const { prepareDeviceOccurrence } = await import('../dev-geometry/nodeGeometryLoader.js');
        await prepareDeviceOccurrence(state, root, session);
      }
    }
  }
  if (!state.selection.isCurrentSelection(request)) return;
  state.selection.selectionGeometry = describeNodeSelectionGeometry(state, node, true);
  message(state.selection.selectionGeometry.detail);
  const { getViewerRuntimeWithUI } = await import('../presentation/viewerUIBinding.js');
  const { ctx } = await getViewerRuntimeWithUI(state, message);
  await frameAndHighlightDevice(ctx, state, node.devPath, scope, session, request);
}
