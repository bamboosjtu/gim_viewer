import * as THREE from 'three';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { ensureGeometryLayer } from './modGeometryScene.js';
import { readNodeDevGlb } from './nodeGeometrySources.js';
import {
  attachDevGlbTemplatePool,
  getDevGlbTemplatePool,
  DevGlbTemplatePool,
  DEV_GLB_EXCLUSIVE_PLACEMENT_USER_DATA_KEY,
  placeSourceGeometry,
  getLoadedDevOccurrenceKind,
} from './devGlbTemplateRuntime.js';

/**
 * 方案 C v2：节点点击时尝试 DEV 粒度 GLB 快速路径。
 *
 * 如果 DEV.glb 命中，加载整个 DEV 的几何并应用 CBM 矩阵，返回 true。
 * 如果未命中，返回 false，调用方回退到 MOD 粒度加载。
 */
export async function tryLoadDevGlbForNode(
  state: AppState,
  scene: THREE.Scene,
  geometryNode: CbmNode,
  session: ProjectLoadSession,
): Promise<boolean> {
  if (!state.isCurrentSession(session)) return false;
  if (!geometryNode.devPath) return false;
  const existing = getLoadedDevOccurrenceKind(state, geometryNode.path);
  if (existing) return existing === 'glb';

  const source = await readNodeDevGlb(geometryNode, state, session);
  if (!source || !state.isCurrentSession(session)) return false;
  const { path: devPath, bytes: glbBytes } = source;

  // 检查是否已加载
  const instanceKey = `dev:${devPath}#${geometryNode.path}`;
  if (state.loadedXmlModGroups.has(instanceKey)) {
    debugLog(DEBUG_IFC_LOAD, `[xml-mod] DEV GLB 实例已加载，跳过: ${instanceKey}`);
    return true;
  }

  // 应用 CBM 累积矩阵
  const { computeCbmParentTransform } = await import('./modGeometryDiscovery.js');

  // DEV_SUBDEVICE 虚拟节点需要父链矩阵
  const parentCbmTransform =
    geometryNode.entityName === 'DEV_SUBDEVICE'
      ? computeCbmParentTransform(state.currentCbmTree, geometryNode.path)
      : undefined;

  // 计算 CBM 累积矩阵（parent × node.transformMatrix）
  const localTransform = parseMatrixFromString(geometryNode.transformMatrix);
  const cbmTransform = parentCbmTransform
    ? multiplyMatrices(parentCbmTransform, localTransform)
    : localTransform;

  // Reuse the current session's template pool when the automatic pipeline
  // already parsed this DEV.  A click that reaches a not-yet-loaded DEV also
  // creates the same pool abstraction, so lazy interaction does not introduce
  // a second placement/parse semantic.
  const { loadDevGlb, parseDevGlbAsset } = await import('./glbCacheService.js');
  const modRoot = ensureGeometryLayer(state, scene, 'mod');
  const templatePool =
    getDevGlbTemplatePool(modRoot, session) ??
    new DevGlbTemplatePool({
      session,
      isCurrent: () => state.isCurrentSession(session),
      parse: parseDevGlbAsset,
    });
  attachDevGlbTemplatePool(modRoot, templatePool);
  const preparation = await templatePool.prepare(devPath, glbBytes);
  if (!state.isCurrentSession(session)) return false;
  const afterPrepare = getLoadedDevOccurrenceKind(state, geometryNode.path);
  if (afterPrepare) return afterPrepare === 'glb';

  if (preparation?.kind === 'shared') {
    const sharedGroup = preparation.template.createPlacement({
      instanceKey,
      placementMatrix: cbmTransform,
      projectSourceToViewerMatrix: state.projectSourceToViewerMatrix,
    });
    if (!state.isCurrentSession(session)) return false;
    sharedGroup.userData.rootOccurrence = geometryNode.path;
    modRoot.add(sharedGroup);
    state.loadedXmlModGroups.set(instanceKey, sharedGroup);
    debugLog(
      DEBUG_IFC_LOAD,
      `[xml-mod] DEV GLB template placement 命中: ${devPath} (instance: ${instanceKey})`,
    );
    return true;
  }

  // Independently loaded assets preserve animations/skinning ownership.
  let group = await loadDevGlb(devPath, glbBytes);
  if (!state.isCurrentSession(session)) {
    group?.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
    return false;
  }
  if (!group) return false;

  group = placeSourceGeometry(group, {
    rootOccurrence: geometryNode.path,
    instanceKey,
    placementMatrix: cbmTransform,
    projectSourceToViewerMatrix: state.projectSourceToViewerMatrix,
  });
  group.userData.devPath = devPath;
  if (!state.isCurrentSession(session)) {
    group.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
    return false;
  }
  const beforeCommit = getLoadedDevOccurrenceKind(state, geometryNode.path);
  if (beforeCommit) {
    group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
    return beforeCommit === 'glb';
  }
  group.userData.rootOccurrence = geometryNode.path;
  group.userData.instanceKey = instanceKey;
  group.userData[DEV_GLB_EXCLUSIVE_PLACEMENT_USER_DATA_KEY] = true;
  if (!state.isCurrentSession(session)) {
    group.traverse((object) => (object as THREE.Mesh).geometry?.dispose?.());
    return false;
  }
  modRoot.add(group);
  state.loadedXmlModGroups.set(instanceKey, group);

  debugLog(DEBUG_IFC_LOAD, `[xml-mod] DEV GLB 命中: ${devPath} (instance: ${instanceKey})`);

  return true;
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function parseMatrixFromString(raw: string | undefined): number[] {
  if (!raw) return IDENTITY_MATRIX.slice();
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 16) return IDENTITY_MATRIX.slice();
  const values = parts.map(Number);
  return values.some((n) => !Number.isFinite(n)) ? IDENTITY_MATRIX.slice() : values;
}

function multiplyMatrices(a: number[], b: number[]): number[] {
  const am = new THREE.Matrix4().fromArray(a.length === 16 ? a : IDENTITY_MATRIX);
  const bm = new THREE.Matrix4().fromArray(b.length === 16 ? b : IDENTITY_MATRIX);
  return am.multiply(bm).toArray();
}
