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
import { parseBoundedCount } from '../parserLimits.js';
import {
  getFirstNonEmptyKv,
  isGimEmptyValue,
} from '../gimValueSemantics.js';
import { parseKeyValue } from '../kvParser.js';

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
    .map((l) => l.replace(/^\uFEFF/, '').trim())
    .filter((l) => l.length > 0);

  // 普通标量字段使用与 CBM/PHM 共用的 KEY=VALUE 解析器；第二遍仍按行
  // 处理 block 归属，因为同名 TRANSFORMMATRIX 需要区分 SOLID/SUBDEVICE。
  const kv = parseKeyValue(text);

  const baseFamily = getFirstNonEmptyKv(kv, ['BASEFAMILY', 'BASEFAMILYPOINTER']);
  const symbolName = getFirstNonEmptyKv(kv, ['SYMBOLNAME']);
  const type = getFirstNonEmptyKv(kv, ['TYPE', 'DEVICETYPE']);
  const solidModelsNum = parseBoundedCount(getFirstNonEmptyKv(kv, ['SOLIDMODELS.NUM']), 'SOLIDMODELS.NUM');
  const subDevicesNum = parseBoundedCount(getFirstNonEmptyKv(kv, ['SUBDEVICES.NUM']), 'SUBDEVICES.NUM');

  // 第二遍：按行顺序解析 SOLIDMODELS / SUBDEVICES 块
  // 关键：通过 currentBlock 追踪当前所处的块，正确归属 TRANSFORMMATRIXn
  // 先按声明索引保留槽位，再在末尾过滤空 sentinel。这样 Bentley 等
  // 导出器的 `SOLIDMODEL0=` 不会让后续 `TRANSFORMMATRIX1` 错配到
  // 实际的 SOLIDMODEL1；同样适用于 SUBDEVICE 的稀疏槽位。
  const solidModelSlots: Array<DevSolidModelEntry | undefined> = [];
  const subDeviceSlots: Array<DevSubDeviceEntry | undefined> = [];
  let currentBlock: 'solid' | 'sub' | null = null;

  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const keyUpper = key.toUpperCase();

    // 块开始标记
    if (keyUpper === 'SOLIDMODELS.NUM') {
      currentBlock = 'solid';
      continue;
    }
    if (keyUpper === 'SUBDEVICES.NUM') {
      currentBlock = 'sub';
      continue;
    }

    // SOLIDMODELn 条目
    const solidMatch = keyUpper.match(/^SOLIDMODEL(\d+)$/);
    if (solidMatch) {
      const i = parseInt(solidMatch[1], 10);
      currentBlock = 'solid';
      if (i >= 0 && i < solidModelsNum && !isGimEmptyValue(value)) {
        solidModelSlots[i] = {
          solidModelPath: value,
          transformMatrix: IDENTITY_MATRIX.slice(),
        };
      }
      continue;
    }

    // SUBDEVICEn 条目
    const subMatch = keyUpper.match(/^SUBDEVICE(\d+)$/);
    if (subMatch) {
      const i = parseInt(subMatch[1], 10);
      currentBlock = 'sub';
      if (i >= 0 && i < subDevicesNum && !isGimEmptyValue(value)) {
        subDeviceSlots[i] = {
          devPath: value,
          transformMatrix: IDENTITY_MATRIX.slice(),
        };
      }
      continue;
    }

    // TRANSFORMMATRIXn（归属当前块）
    const tmMatch = keyUpper.match(/^TRANSFORMMATRIX(\d+)$/);
    if (tmMatch) {
      const tmIndex = parseInt(tmMatch[1], 10);
      const matrix = parseTransformMatrix(value);
      if (currentBlock === 'solid' && tmIndex >= 0 && solidModelSlots[tmIndex]) {
        solidModelSlots[tmIndex]!.transformMatrix = matrix;
      } else if (currentBlock === 'sub' && tmIndex >= 0 && subDeviceSlots[tmIndex]) {
        subDeviceSlots[tmIndex]!.transformMatrix = matrix;
      }
      // currentBlock 为 null 时不归属（不应出现在合法 DEV 中）
    }
  }

  const solidModels = solidModelSlots.filter((entry): entry is DevSolidModelEntry => entry !== undefined);
  const subDevices = subDeviceSlots.filter((entry): entry is DevSubDeviceEntry => entry !== undefined);
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
  if (matrix.some((n) => !Number.isFinite(n))) {
    return IDENTITY_MATRIX.slice();
  }
  return matrix;
}
