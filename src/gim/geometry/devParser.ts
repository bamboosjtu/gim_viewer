/**
 * DEV 文件解析器。
 *
 * DEV（Device）文件描述物理设备及其几何引用链：
 * - SOLIDMODELS 块：SOLIDMODELn + TRANSFORMMATRIXn（变电指向 .phm；线路可指向 .phm 或 .dev 递归）
 * - SUBDEVICES 块（仅变电）：SUBDEVICEn + TRANSFORMMATRIXn（递归子 .dev）
 *
 * 关键约束：
 * - SOLIDMODELS 块与 SUBDEVICES 块的 TRANSFORMMATRIX 索引各自独立从 0 开始
 *   → 同一 DEV 文件中 TRANSFORMMATRIX0 可能出现两次（一次给 SUBDEVICE0，一次给 SOLIDMODEL0）
 *   → 必须按行顺序追踪 currentBlock 区分归属
 * - TRANSFORMMATRIX 4×4 矩阵按 Three.js Matrix4.elements 布局展开，平移在 m[12..14]
 * - 缺失/格式异常时回退单位矩阵（与 PHM parser 一致）
 *
 * 详见 docs/schema/dev.md。
 */

import type {
  DevDocument,
  DevSolidModelEntry,
  DevSubDeviceEntry,
} from './ir.js';

/** 单位矩阵（列主序 / Three.js Matrix4.elements 布局，长度 16） */
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * 解析 DEV 文件内容为 DevDocument。
 *
 * @param text DEV 文件文本
 * @param devPath DEV 文件路径（如 "DEV/abc.dev"），用于 DevDocument.devPath
 */
export function parseDev(text: string, devPath: string): DevDocument {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // 第一遍：提取简单标量字段
  const kv: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const baseFamily = kv['BASEFAMILY'] || '';
  const symbolName = kv['SYMBOLNAME'] || '';
  const type = kv['TYPE'] || kv['DEVICETYPE'] || '';
  const solidModelsNum = parseInt(kv['SOLIDMODELS.NUM'] || '0', 10);
  const subDevicesNum = parseInt(kv['SUBDEVICES.NUM'] || '0', 10);

  // 第二遍：按行顺序解析 SOLIDMODELS / SUBDEVICES 块
  // 关键：通过 currentBlock 追踪当前所处的块，正确归属 TRANSFORMMATRIXn
  const solidModels: DevSolidModelEntry[] = [];
  const subDevices: DevSubDeviceEntry[] = [];
  let currentBlock: 'solid' | 'sub' | null = null;

  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    // 块开始标记
    if (key === 'SOLIDMODELS.NUM') {
      currentBlock = 'solid';
      continue;
    }
    if (key === 'SUBDEVICES.NUM') {
      currentBlock = 'sub';
      continue;
    }

    // SOLIDMODELn 条目
    const solidMatch = key.match(/^SOLIDMODEL(\d+)$/);
    if (solidMatch) {
      const i = parseInt(solidMatch[1], 10);
      currentBlock = 'solid';
      if (i >= 0 && i < solidModelsNum && value) {
        solidModels.push({
          solidModelPath: value,
          transformMatrix: IDENTITY_MATRIX.slice(),
        });
      }
      continue;
    }

    // SUBDEVICEn 条目
    const subMatch = key.match(/^SUBDEVICE(\d+)$/);
    if (subMatch) {
      const i = parseInt(subMatch[1], 10);
      currentBlock = 'sub';
      if (i >= 0 && i < subDevicesNum && value) {
        subDevices.push({
          devPath: value,
          transformMatrix: IDENTITY_MATRIX.slice(),
        });
      }
      continue;
    }

    // TRANSFORMMATRIXn（归属当前块）
    const tmMatch = key.match(/^TRANSFORMMATRIX(\d+)$/);
    if (tmMatch) {
      const tmIndex = parseInt(tmMatch[1], 10);
      const matrix = parseTransformMatrix(value);
      if (currentBlock === 'solid' && tmIndex >= 0 && tmIndex < solidModels.length) {
        solidModels[tmIndex].transformMatrix = matrix;
      } else if (currentBlock === 'sub' && tmIndex >= 0 && tmIndex < subDevices.length) {
        subDevices[tmIndex].transformMatrix = matrix;
      }
      // currentBlock 为 null 时不归属（不应出现在合法 DEV 中）
    }
  }

  const isEmpty = solidModels.length === 0 && subDevices.length === 0;

  return {
    devPath,
    baseFamily,
    type,
    symbolName,
    solidModels,
    subDevices,
    isEmpty,
  };
}

/**
 * 解析 TRANSFORMMATRIX 字段（16 浮点逗号分隔，列主序 / Three.js Matrix4.elements 布局）。
 *
 * 与 phmParser.parseTransformMatrix 行为一致：
 * - 长度不为 16 → 回退单位矩阵
 * - 含 NaN → 回退单位矩阵
 */
function parseTransformMatrix(value: string): number[] {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length !== 16) {
    return IDENTITY_MATRIX.slice();
  }
  const matrix = parts.map((p) => parseFloat(p));
  if (matrix.some((n) => Number.isNaN(n))) {
    return IDENTITY_MATRIX.slice();
  }
  return matrix;
}
