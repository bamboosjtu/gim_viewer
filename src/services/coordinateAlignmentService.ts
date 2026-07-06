/**
 * 项目级坐标对齐服务。
 *
 * 背景：
 * - IFC loader 使用 coordinateToOrigin=true，把 IFC 几何归一化到 viewer 原点附近，
 *   并在内部做 Z-up → Y-up 转换，IFC 加载后位于 Y-up 坐标系。
 * - MOD/STL 保留 GIM 原始工程坐标（Z-up，电力行业惯例：Tz 是"高度"方向，
 *   样本 Tz=5750mm ≈ 5.75 米），未做坐标轴转换。
 * - 两者不仅坐标基准不同（平移），坐标系朝向也不同（Z-up vs Y-up）。
 *   直接同时显示会导致"屏柜横着放"——Z 轴被当成水平方向。
 *
 * 策略：
 * - 保持 IFC loader 的 coordinateToOrigin=true 不变（保护 IFC 主显示链路）。
 * - 给 MOD/STL 的 projectSourceToViewer 矩阵组合两个变换：
 *   1. Z-up → Y-up 旋转（绕 X 轴 -90°）
 *   2. IFC baseCoordinationMatrix 平移（与 IFC 同坐标基准）
 *   即：sourceToViewer = baseCoordinationMatrix × ZUpToYUp
 * - 应用到 MOD Group 时：v' = baseCoordinationMatrix × ZUpToYUp × v
 *   先把 GIM Z-up 几何旋转到 Y-up，再平移到 viewer 原点。
 *
 * localStorage GIM_COORD_OFFSET="dx,dy,dz" 保留为手工调试入口；存在时不覆盖。
 */

import * as THREE from 'three';
import type * as OBC from '@thatopen/components';
import type { AppState } from '../app/state.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';

export interface ProjectCoordinateAlignment {
  sourceToViewer: THREE.Matrix4;
  reason: string;
  confidence: 'manual' | 'fragments-base' | 'estimated' | 'unknown';
}

const IDENTITY_EPSILON = 1e-9;
const FRAGMENTS_BASE_WAIT_FRAMES = 10;

/**
 * GIM 工程坐标系（Z-up）→ viewer 坐标系（Y-up）的旋转矩阵。
 *
 * 绕 X 轴 -90° 旋转：
 * - 原 +Z（GIM 高度方向）→ 新 +Y（viewer 上方向）
 * - 原 +Y → 新 -Z
 * - 原 +X 保持不变
 *
 * 实证依据：CBM 矩阵样本 T=(45758.924, 7382.144, 5750.000)，
 * Tz=5750mm 是变电站内设备的"高度"方向，旋转后映射到 viewer +Y。
 */
const Z_UP_TO_Y_UP = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

/**
 * 构造 manual 对齐矩阵：组合 Z-up→Y-up 旋转 + 用户指定的平移。
 *
 * @param dx X 轴平移（viewer 单位，通常米，已旋转到 Y-up 后）
 * @param dy Y 轴平移
 * @param dz Z 轴平移
 */
export function makeTranslationAlignment(dx: number, dy: number, dz: number): ProjectCoordinateAlignment {
  // manual offset 视为 viewer Y-up 空间下的平移，先旋转再平移
  const translation = new THREE.Matrix4().makeTranslation(dx, dy, dz);
  const m = translation.multiply(Z_UP_TO_Y_UP);
  return {
    sourceToViewer: m,
    reason: `manual alignment dx=${dx}, dy=${dy}, dz=${dz} (combined with Z-up→Y-up rotation)`,
    confidence: 'manual',
  };
}

function isIdentityMatrix(matrix: THREE.Matrix4): boolean {
  const identity = new THREE.Matrix4();
  const a = matrix.elements;
  const b = identity.elements;
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a[i] - b[i]) > IDENTITY_EPSILON) return false;
  }
  return true;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * 把项目级 sourceToViewer 矩阵应用到 Group。
 * matrix 为 null 时直接返回（无对齐）。
 */
export function applyProjectSourceToViewer(group: THREE.Group, matrix: THREE.Matrix4 | null): void {
  if (!matrix) return;
  group.applyMatrix4(matrix);
}

/**
 * 从 ThatOpen FragmentsManager 同步 IFC 自动坐标基准，并组合 Z-up→Y-up 旋转。
 *
 * IfcLoader.load(..., true) 会启用 Fragments 的 autoCoordinate：第一个 IFC
 * 模型提供 baseCoordinationMatrix（已是 Y-up 坐标系下的平移），后续 IFC 以它
 * 为基准。MOD/STL 不经过 IfcLoader，且保留 GIM Z-up 工程坐标，因此需要：
 *   1. 先应用 Z-up→Y-up 旋转
 *   2. 再应用 baseCoordinationMatrix 平移
 * 即：sourceToViewer = baseCoordinationMatrix × ZUpToYUp
 *
 * 应用到 MOD Group：v' = baseCoordinationMatrix × ZUpToYUp × v
 *
 * 手工 GIM_COORD_OFFSET 已设置时不覆盖，便于调试。
 */
export async function syncProjectSourceToViewerFromFragments(
  state: AppState,
  fragments: OBC.FragmentsManager,
): Promise<boolean> {
  if (state.projectSourceToViewerMatrix) {
    debugLog(DEBUG_IFC_LOAD, '[CoordAlign] 已存在项目坐标矩阵，跳过 Fragments 自动同步');
    return false;
  }

  for (let i = 0; i < FRAGMENTS_BASE_WAIT_FRAMES; i++) {
    if (fragments.baseCoordinationModel) break;
    await nextAnimationFrame();
  }

  const base = fragments.baseCoordinationMatrix;
  if (!base) return false;

  // 组合：baseCoordinationMatrix（Y-up 平移）× ZUpToYUp（Z-up→Y-up 旋转）
  // 应用顺序：先旋转 GIM 几何到 Y-up，再用 baseCoordinationMatrix 平移到 viewer 原点
  const combined = base.clone().multiply(Z_UP_TO_Y_UP);
  state.projectSourceToViewerMatrix = combined;

  debugLog(DEBUG_IFC_LOAD, '[CoordAlign] 已从 Fragments baseCoordinationMatrix 同步并组合 Z-up→Y-up 旋转', {
    baseCoordinationModel: fragments.baseCoordinationModel,
    baseIsIdentity: isIdentityMatrix(base),
    baseMatrix: base.elements,
    combinedMatrix: combined.elements,
  });

  return true;
}

/**
 * 从 localStorage 读取 GIM_COORD_OFFSET 并设置到 state.projectSourceToViewerMatrix。
 *
 * 格式：GIM_COORD_OFFSET = "dx,dy,dz"（逗号分隔，viewer 单位）
 * 示例：localStorage.setItem('GIM_COORD_OFFSET', '1000,0,-2000')
 *
 * 仅作为调试功能：
 * - 不写入数据库
 * - 不作为最终算法
 * - 解析失败静默忽略（debug 模式输出 warning）
 *
 * @returns true 表示成功解析并设置；false 表示未设置或解析失败
 */
export function loadManualCoordOffsetFromLocalStorage(state: AppState): boolean {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem('GIM_COORD_OFFSET');
  } catch {
    // 隐私模式 / 非浏览器环境
    return false;
  }

  if (!raw || !raw.trim()) return false;

  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 3) {
    debugLog(DEBUG_IFC_LOAD, `[CoordAlign] GIM_COORD_OFFSET 格式非法（应为 "dx,dy,dz"）: ${raw}`);
    return false;
  }

  const nums = parts.map((s) => Number(s));
  if (nums.some((n) => !Number.isFinite(n))) {
    debugLog(DEBUG_IFC_LOAD, `[CoordAlign] GIM_COORD_OFFSET 含非有限数: ${raw}`);
    return false;
  }

  const [dx, dy, dz] = nums;
  const alignment = makeTranslationAlignment(dx, dy, dz);
  state.projectSourceToViewerMatrix = alignment.sourceToViewer;

  debugLog(DEBUG_IFC_LOAD, `[CoordAlign] 已从 GIM_COORD_OFFSET 加载手动平移: dx=${dx}, dy=${dy}, dz=${dz} (${alignment.reason})`);
  return true;
}
