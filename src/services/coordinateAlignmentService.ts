/**
 * 项目级坐标对齐服务（MVP: translation-only）。
 *
 * 背景：
 * - IFC loader 使用 coordinateToOrigin=true，把 IFC 几何归一化到 viewer 原点附近。
 * - MOD/STL 保留 GIM 原始工程坐标（通常是大数偏移，如几十万米）。
 * - 两者坐标基准不同，直接同时显示会严重错位。
 *
 * 策略：
 * - 保持 IFC loader 的 coordinateToOrigin=true 不变（保护 IFC 主显示链路）。
 * - 给 MOD/STL 增加 projectSourceToViewer 变换，把 GIM 工程坐标平移到 viewer 空间。
 *
 * 本轮 MVP 仅实现 translation-only：
 * - 不做旋转 / 缩放 / 坐标轴翻转。
 * - 不实现自动对齐算法。
 * - 通过 localStorage GIM_COORD_OFFSET="dx,dy,dz" 手动调试，输出诊断日志辅助估算。
 *
 * 后续可基于共同 CBM 节点的 IFC bbox 与 MOD bbox 自动估算 sourceToViewer offset。
 */

import * as THREE from 'three';
import type { AppState } from '../app/state.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';

export interface ProjectCoordinateAlignment {
  sourceToViewer: THREE.Matrix4;
  reason: string;
  confidence: 'manual' | 'estimated' | 'unknown';
}

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

/**
 * 把项目级 sourceToViewer 矩阵应用到 Group。
 * matrix 为 null 时直接返回（无对齐）。
 */
export function applyProjectSourceToViewer(group: THREE.Group, matrix: THREE.Matrix4 | null): void {
  if (!matrix) return;
  group.applyMatrix4(matrix);
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
