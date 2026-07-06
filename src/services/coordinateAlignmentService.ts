/**
 * 项目级坐标对齐服务。
 *
 * 背景：
 * - IFC loader 使用 coordinateToOrigin=true，把 IFC 几何归一化到 viewer 原点附近。
 * - MOD/STL 保留 GIM 原始工程坐标（通常是大数偏移，如几十万米）。
 * - 两者坐标基准不同，直接同时显示会严重错位。
 *
 * 策略：
 * - 保持 IFC loader 的 coordinateToOrigin=true 不变（保护 IFC 主显示链路）。
 * - 给 MOD/STL 增加 projectSourceToViewer 变换，把 GIM 工程坐标平移到 viewer 空间。
 * - 优先复用 ThatOpen FragmentsManager 的 baseCoordinationMatrix，使 MOD/STL
 *   与 IFC autoCoordinate 使用同一个工程坐标基准。
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
 * 构造 translation-only 对齐矩阵。
 *
 * @param dx X 轴平移（viewer 单位，通常米）
 * @param dy Y 轴平移
 * @param dz Z 轴平移
 */
export function makeTranslationAlignment(dx: number, dy: number, dz: number): ProjectCoordinateAlignment {
  const m = new THREE.Matrix4().makeTranslation(dx, dy, dz);
  return {
    sourceToViewer: m,
    reason: `translation-only alignment dx=${dx}, dy=${dy}, dz=${dz}`,
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
 * 从 ThatOpen FragmentsManager 同步 IFC 自动坐标基准。
 *
 * IfcLoader.load(..., true) 会启用 Fragments 的 autoCoordinate：第一个 IFC
 * 模型提供 baseCoordinationMatrix，后续 IFC 以它为基准。MOD/STL 不经过
 * IfcLoader，因此需要显式应用同一个 source → viewer 矩阵。
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

  state.projectSourceToViewerMatrix = base.clone();

  debugLog(DEBUG_IFC_LOAD, '[CoordAlign] 已从 Fragments baseCoordinationMatrix 同步 MOD/STL 坐标基准', {
    baseCoordinationModel: fragments.baseCoordinationModel,
    isIdentity: isIdentityMatrix(base),
    matrix: base.elements,
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
