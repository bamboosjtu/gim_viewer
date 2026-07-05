/**
 * PHM 文件解析器。
 *
 * PHM（Physical Model / Assembly）是 GIM 工程中描述组合模型的文件，
 * 采用 KEY=VALUE 文本格式，将多个基础几何模型（MOD / STL）组装在一起，
 * 每个引用的模型通过独立的变换矩阵定义空间位置，并可指定颜色。
 *
 * 详见 docs/schema/phm.md。
 *
 * 关键约束：
 * - PHM 不分节，无 [section] 语法
 * - SOLIDMODELn / TRANSFORMMATRIXn / COLORn 三者通过 index 一一对应
 * - COLORn 为空字符串时 color 字段为 undefined（MOD 引用典型）
 * - TRANSFORMMATRIXn 缺失时回退单位矩阵
 * - PHM 不嵌套引用同级 PHM（实证已确认，解析器不处理）
 */

import type { PhmDocument, PhmSolidModelEntry, XmlModColor } from './ir.js';

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
  const kv = parsePhmKeyValue(text);
  const num = parseInt(kv['SOLIDMODELS.NUM'] ?? '0', 10);
  if (Number.isNaN(num) || num < 0) {
    return { phmPath, solidModels: [], isEmpty: true };
  }
  if (num === 0) {
    return { phmPath, solidModels: [], isEmpty: true };
  }

  const solidModels: PhmSolidModelEntry[] = [];
  for (let i = 0; i < num; i++) {
    const solidModelPath = kv[`SOLIDMODEL${i}`];
    if (!solidModelPath) continue;

    const transformMatrixRaw = kv[`TRANSFORMMATRIX${i}`];
    const colorRaw = kv[`COLOR${i}`];

    solidModels.push({
      solidModelPath,
      transformMatrix: parseTransformMatrix(transformMatrixRaw),
      color: parseColor(colorRaw),
    });
  }

  return {
    phmPath,
    solidModels,
    isEmpty: solidModels.length === 0,
  };
}

/**
 * 解析 KEY=VALUE 文本（PHM 不分节，无 [section] 语法）。
 *
 * 与 src/gim/cbmParser.ts 的 parseKeyValue 行为一致，但内联以避免循环依赖。
 */
function parsePhmKeyValue(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key) result[key] = val;
    }
  }
  return result;
}

/**
 * 解析 TRANSFORMMATRIX 字段（16 浮点，逗号分隔，列主序）。
 *
 * 缺失或格式异常时回退单位矩阵。
 */
function parseTransformMatrix(raw: string | undefined): number[] {
  if (!raw) return [...IDENTITY_MATRIX];
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 16) return [...IDENTITY_MATRIX];
  const matrix = parts.map((p) => parseFloat(p));
  if (matrix.some((n) => Number.isNaN(n))) {
    return [...IDENTITY_MATRIX];
  }
  return matrix;
}

/**
 * 解析 COLOR 字段（"R,G,B,A" 格式）。
 *
 * - 空字符串 → undefined（MOD 引用典型）
 * - 格式异常 → undefined
 * - A 取值 0-100（透明度百分比），实测 40 或 100
 * - R/G/B 取值 0-255
 */
function parseColor(raw: string | undefined): XmlModColor | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 4) return undefined;
  const [r, g, b, a] = parts.map((p) => parseInt(p, 10));
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return undefined;
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return undefined;
  if (a < 0 || a > 100) return undefined;
  return { r, g, b, a };
}
