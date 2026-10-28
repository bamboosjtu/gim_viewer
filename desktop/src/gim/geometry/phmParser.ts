/**
 * PHM 文件解析器。
 *
 * PHM（Physical Model / Assembly）是 GIM 工程中描述组合模型的文件，
 * 采用 KEY=VALUE 文本格式，将多个基础几何模型（MOD / STL）组装在一起，
 * 每个引用的模型通过独立的变换矩阵定义空间位置，并可指定颜色。
 *
 * 详见 docs/schema/geometry-model.md。
 *
 * 关键约束：
 * - PHM 不分节，无 [section] 语法
 * - SOLIDSn 和 SOLIDMODELn 两组各自以 index 关联 TRANSFORMMATRIXn / COLORn
 * - COLORn 为空字符串时 color 字段为 undefined（MOD 引用典型）
 * - TRANSFORMMATRIXn 缺失时回退单位矩阵
 * - SOLIDMODELn 目标可为 .mod/.stl/.gl/.phm（.phm 嵌套由遍历层递归处理）
 */

import type { PhmDocument, PhmSolidModelEntry, XmlModColor } from './ir.js';
import { parseBoundedCount } from '../parserLimits.js';
import {
  getFirstNonEmptyKv,
  isGimEmptyValue,
} from '../gimValueSemantics.js';
import { parseKeyValue } from '../kvParser.js';

/** 单位矩阵（列主序，长度 16） */
const IDENTITY_MATRIX: number[] = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

/**
 * 解析 PHM 文件内容为 PhmDocument。
 *
 * @param text PHM 文件文本内容
 * @param phmPath PHM 文件路径（如 "PHM/abc.phm"），用于 PhmDocument.phmPath
 */
export function parsePhm(text: string, phmPath: string): PhmDocument {
  const kv = parseKeyValue(text);
  const groups = ['SOLIDS', 'SOLIDMODELS'].map(key => ({
    count: parseBoundedCount(getFirstNonEmptyKv(kv, [`${key}.NUM`]), `${key}.NUM`),
    values: new Map<string, string>(),
  }));
  if (groups.every(group => group.count === 0)) {
    return { phmPath, solidModels: [], isEmpty: true, colorMaxA: 0 };
  }

  // SOLIDSn and SOLIDMODELn have independent indexed matrices/colors. Both
  // headers may precede all records, so each reference also selects its group.
  let active = 1;
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at < 0) continue;
    const key = line.slice(0, at).replace(/^\uFEFF/, '').trim().toUpperCase();
    const value = line.slice(at + 1).trim();
    if (key === 'SOLIDS.NUM') active = 0;
    else if (key === 'SOLIDMODELS.NUM') active = 1;
    else if (/^SOLIDS\d+$/.test(key)) { active = 0; groups[active].values.set(key, value); }
    else if (/^SOLIDMODEL\d+$/.test(key)) { active = 1; groups[active].values.set(key, value); }
    else if (/^(TRANSFORMMATRIX|COLOR)\d+$/.test(key)) groups[active].values.set(key, value);
  }
  const solidModels: PhmSolidModelEntry[] = [];
  for (const [groupIndex, group] of groups.entries()) for (let i = 0; i < group.count; i++) {
    const solidModelPath = group.values.get(`${groupIndex === 0 ? 'SOLIDS' : 'SOLIDMODEL'}${i}`);
    if (!solidModelPath || isGimEmptyValue(solidModelPath)) continue;
    solidModels.push({ solidModelPath, transformMatrix: parseTransformMatrix(group.values.get(`TRANSFORMMATRIX${i}`)),
      color: parseColor(group.values.get(`COLOR${i}`)) });
  }
  const colorMaxA = solidModels.reduce((max, entry) => Math.max(max, entry.color?.a ?? 0), 0);

  return {
    phmPath,
    solidModels,
    isEmpty: solidModels.length === 0,
    colorMaxA,
  };
}

/**
 * 解析 TRANSFORMMATRIX 字段（16 浮点，逗号分隔，列主序）。
 *
 * 缺失或格式异常时回退单位矩阵。
 */
function parseTransformMatrix(raw: string | undefined): number[] {
  if (typeof raw !== 'string' || isGimEmptyValue(raw)) return [...IDENTITY_MATRIX];
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 16) return [...IDENTITY_MATRIX];
  const matrix = parts.map((p) => parseFloat(p));
  if (matrix.some((n) => !Number.isFinite(n))) {
    return [...IDENTITY_MATRIX];
  }
  return matrix;
}

/**
 * 解析 COLOR 字段（"R,G,B,A" 格式）。
 *
 * - 空字符串 → undefined（MOD 引用典型）
 * - 格式异常 → undefined
 * - A 原始值取 0-255；文件级 max(A) 决定百分制或字节制刻度
 * - R/G/B 取值 0-255
 */
function parseColor(raw: string | undefined): XmlModColor | undefined {
  if (typeof raw !== 'string' || isGimEmptyValue(raw)) return undefined;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 4) return undefined;
  const [r, g, b, a] = parts.map((p) => parseInt(p, 10));
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return undefined;
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return undefined;
  // A 放宽到 0-255：JinQu/SDDP 为百分制，Bentley/BIMBase 可能出现字节制与非零哨兵差异。
  // 刻度判定由消费方（colorToMaterial）按值域处理。
  if (a < 0 || a > 255) return undefined;
  return { r, g, b, a };
}
