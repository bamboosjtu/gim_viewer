/** Scene placement, geometry bounds checks and layer ownership. */
import * as THREE from 'three';
import { isUsableAffineMatrix } from '../gim/geometry/affineMatrix.js';
import { freezeContainerLocalMatrix } from '../viewer/staticContainer.js';
import { GEOMETRY_MAX_EXTENT_M } from '../viewer/geometryBounds.js';
import type { AppState } from '../app/state.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { applyProjectSourceToViewer } from './coordinateAlignmentService.js';

/**
 * 异常 bbox 尺寸阈值（米）。
 *
 * DEV 粒度合并几何可合法包含全站系统（电缆沟/消防管网等，跨度 100m+），
 * 阈值需覆盖站点尺度（500m 覆盖特大型变电站）；
 * 单位错误类损坏（mm/m 混淆）通常为 km 级，仍可拦截。
 */
export const BBOX_MAX_DIM_M = GEOMETRY_MAX_EXTENT_M;

/**
 * 异常 bbox 位置阈值（米）：bbox 中心距原点超过此值视为平移失控。
 *
 * 尺寸检查拦截不了"几何正常但被错误平移到远处"的情况
 * （如放置矩阵 mm/m 混淆把设备平移到 100km 外）；
 * 场景经 projectSourceToViewer 对齐后正常几何中心应在站点尺度（≤1km）内。
 */
export const BBOX_MAX_CENTER_M = 5000;

/**
 * 确保 MOD/STL 图层根节点存在（挂在 scene 下，与 IFC 平级）。
 * 首次调用时创建，后续调用返回已有实例。
 */
export function ensureGeometryLayers(state: AppState, scene: THREE.Scene): { modRoot: THREE.Group; stlRoot: THREE.Group } {
  if (!state.modRootGroup) {
    state.modRootGroup = new THREE.Group();
    freezeContainerLocalMatrix(state.modRootGroup);
    state.modRootGroup.name = '__GIM_MOD_LAYER__';
    state.modRootGroup.visible = true;
    scene.add(state.modRootGroup);
  }
  if (!state.stlRootGroup) {
    state.stlRootGroup = new THREE.Group();
    freezeContainerLocalMatrix(state.stlRootGroup);
    state.stlRootGroup.name = '__GIM_STL_LAYER__';
    state.stlRootGroup.visible = true;
    scene.add(state.stlRootGroup);
  }
  return { modRoot: state.modRootGroup, stlRoot: state.stlRootGroup };
}

/**
 * 诊断 MOD/STL Group 的 bbox 是否异常。
 *
 * 过滤条件：
 * - 空包围盒（通常是当前尚未支持的 primitive，静默跳过）
 * - 无限/NaN 尺寸
 * - 单轴跨度 > BBOX_MAX_DIM_M（单位错误类几何损坏，km 级）
 * - bbox 中心距原点 > BBOX_MAX_CENTER_M（平移失控，如放置矩阵 mm/m 混淆）
 *
 * @returns true 表示 bbox 正常，可以加入场景
 */
export function diagnoseGroupBBox(
  group: THREE.Group,
  sourcePath: string,
  options: { disposeOnFailure?: boolean } = {},
): boolean {
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const center = box.getCenter(new THREE.Vector3());
  const centerDist = center.length();

  const empty = box.isEmpty() || maxDim <= 0;
  const bad =
    !empty &&
    (!Number.isFinite(maxDim) ||
      maxDim > BBOX_MAX_DIM_M ||
      !Number.isFinite(centerDist) ||
      centerDist > BBOX_MAX_CENTER_M);

  if (empty || bad) {
    if (bad) {
      console.warn('[autoLoad] 异常几何 bbox，跳过（不加入场景）:', {
        sourcePath,
        center: center.toArray(),
        size: size.toArray(),
        maxDim,
        centerDist,
        thresholds: { maxDim: BBOX_MAX_DIM_M, center: BBOX_MAX_CENTER_M },
      });
    }
    // dispose GPU 资源，避免内存泄漏.  Shared DEV GLB placements must
    // disable this branch: their geometry/materials belong to the template
    // pool and are released once at session cleanup.
    if (options.disposeOnFailure === false) return false;
    // 方案 B：merged geometry 是 unique 的（每 MOD Group 独立），可以安全 dispose
    // Material 是共享的（_sharedMaterialCache），不可在此处 dispose！
    //   否则会 corrupt 其他使用同一 Material 的 MOD Group
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        if ((material.userData as Record<string, unknown> | undefined)?.__gimOwnedInstanceMaterial === true) {
          material.dispose();
        }
      }
      // 共享 XML MOD 材质由 disposeSharedXmlModMaterials 统一释放
    });
  }

  return !(empty || bad);
}

/**
 * 输出 Group 的 bbox 诊断日志（仅 debug 模式）。
 *
 * 用于在应用 projectSourceToViewer 前后对比 MOD/STL 的位置，
 * 辅助估算 sourceToViewer offset。
 *
 * @param stage 'raw' = 应用 projectSourceToViewer 前（GIM 工程坐标）
 *              'transformed' = 应用后（viewer 坐标）
 */
export function logGroupBBox(group: THREE.Group, sourcePath: string, stage: 'raw' | 'transformed'): void {
  if (!DEBUG_IFC_LOAD) return;
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) {
    debugLog(DEBUG_IFC_LOAD, `[CoordAlign] ${stage} bbox 为空: ${sourcePath}`);
    return;
  }
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  debugLog(DEBUG_IFC_LOAD, `[CoordAlign] ${stage} bbox: ${sourcePath}`, {
    center: [center.x, center.y, center.z],
    size: [size.x, size.y, size.z],
  });
}

/**
 * MOD Entity.TransformMatrix 表达图元在 MOD 文件内的局部位置；
 * CBM/DEV/SUBDEVICE/PHM 累积矩阵表达该 MOD 实例在工程中的放置位置。
 *
 * 应用顺序：Entity local → placement → projectSourceToViewer。
 */
export function prepareModGroupForScene(
  group: THREE.Group,
  sourcePath: string,
  applyPlacementTransform: (group: THREE.Group, transformMatrix: number[] | null | undefined) => void,
  placementTransformMatrix: number[] | null | undefined,
  projectSourceToViewerMatrix: THREE.Matrix4 | null,
): boolean {
  // Entity local transform 已在 loadXmlModFromFiles 中烘焙
  applyPlacementTransform(group, placementTransformMatrix);
  // 输出 raw bbox（应用 projectSourceToViewer 前）
  logGroupBBox(group, sourcePath, 'raw');
  // 应用项目级坐标转换（translation-only MVP）
  applyProjectSourceToViewer(group, projectSourceToViewerMatrix);
  // 输出 transformed bbox（应用后）
  logGroupBBox(group, sourcePath, 'transformed');
  return diagnoseGroupBBox(group, sourcePath);
}

export function prepareStlGroupForScene(
  group: THREE.Group,
  sourcePath: string,
  applyPlacementTransform: (group: THREE.Group, transformMatrix: number[] | null | undefined) => void,
  placementTransformMatrix: number[] | null | undefined,
  projectSourceToViewerMatrix: THREE.Matrix4 | null,
): boolean {
  // 顺序：Entity local(无) → 累积装配矩阵 → projectSourceToViewer
  applyPlacementTransform(group, placementTransformMatrix);
  // 输出 raw bbox（应用 projectSourceToViewer 前，已含 DEV/PHM 变换）
  logGroupBBox(group, sourcePath, 'raw');
  // 应用项目级坐标转换
  applyProjectSourceToViewer(group, projectSourceToViewerMatrix);
  // 输出 transformed bbox（应用后）
  logGroupBBox(group, sourcePath, 'transformed');
  return diagnoseGroupBBox(group, sourcePath);
}

export const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function parseCbmTransformMatrix(raw: string | undefined): number[] {
  if (!raw) return IDENTITY_MATRIX.slice();
  const values = raw.split(',').map((part) => Number(part.trim()));
  if (raw.split(',').some(part => !part.trim()) || !isUsableAffineMatrix(values)) {
    return IDENTITY_MATRIX.slice();
  }
  return values;
}

export function multiplyTransformMatrices(a: number[], b: number[]): number[] {
  const am = new THREE.Matrix4().fromArray(a.length === 16 ? a : IDENTITY_MATRIX);
  const bm = new THREE.Matrix4().fromArray(b.length === 16 ? b : IDENTITY_MATRIX);
  return am.multiply(bm).toArray();
}
