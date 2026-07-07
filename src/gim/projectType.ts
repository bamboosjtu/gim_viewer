/**
 * GIM 工程类型识别。
 *
 * 依据 docs/gim_line.md：
 * - 变电工程：CBM/DEV/MOD/PHM（全大写），含 IFC 文件，FileDevRelation.cbm
 * - 线路工程：Cbm/Dev/Mod/Phm（首字母大写），无 IFC，每层引用键不同
 *
 * 识别策略：只读取文本文件（CBM/DEV/FAM），不读取 IFC/STL 大文件全文。
 * 信号匹配采用 KEY=VALUE 级别匹配，避免裸子串误判
 * （如 WIREWEIGHT 包含 WIRE、CROSSSECTION 包含 CROSS）。
 */

import { parseKeyValue } from './cbmParser.js';
import { DEBUG_RUNTIME_LOGS } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';

/** GIM 工程类型 */
export type GimProjectType = 'substation' | 'transmission_line' | 'hybrid' | 'unknown';

/** 识别细节，便于日志输出和调试 */
export interface GimProjectTypeDetails {
  hasIfc: boolean;
  hasLineArtifacts: boolean;
  ifcCount: number;
  cbmCount: number;
  devCount: number;
  famCount: number;
  phmCount: number;
  modCount: number;
  stlCount: number;
  /** 位于 PascalCase Cbm/ 目录下的文件数 */
  lineCbmDirCount: number;
  /** 位于 PascalCase Dev/ 目录下的文件数 */
  lineDevDirCount: number;
  /** 位于 PascalCase Mod/ 目录下的文件数 */
  lineModDirCount: number;
  /** 位于 PascalCase Phm/ 目录下的文件数 */
  linePhmDirCount: number;
  /** 位于全大写 CBM/DEV/MOD/PHM 目录下的文件数（变电工程特征，便于排查 hybrid） */
  substationDirCount: number;
  /** 命中的线路信号字段列表，便于排查 */
  lineSignals: string[];
}

export interface GimProjectTypeResult {
  type: GimProjectType;
  details: GimProjectTypeDetails;
}

/**
 * 精确键存在型信号：只要 kv 中存在该键即命中。
 * 这些键只在线路工程 CBM/DEV/FAM 文本中出现。
 */
const EXACT_KEY_SIGNALS: readonly string[] = [
  'SECTIONS.NUM',
  'STRAINSECTIONS.NUM',
  'GROUPS.NUM',
  'TOWERS.NUM',
  'STRINGS.NUM',
  'BASES.NUM',
  'GROUPTYPE',
  'WIRETYPE',
  'KVALUE',
  'POINT0.BLHA',
  'DEVICETYPE',
];

/**
 * 实体值型信号：检查 ENTITYNAME / GROUPTYPE / DEVICETYPE 的值是否等于信号。
 * 避免裸子串匹配（WIREWEIGHT 包含 WIRE、CROSSSECTION 包含 CROSS）。
 */
const ENTITY_VALUE_SIGNALS: readonly string[] = [
  'Tower_Device',
  'Wire_Device',
  'WIRE',
  'CROSS',
];

/** 全部线路信号总数（用于提前终止判断） */
const TOTAL_LINE_SIGNALS = EXACT_KEY_SIGNALS.length + ENTITY_VALUE_SIGNALS.length;

/** IFC 文本信号键：kv 中存在任一即判定 hasIfc（仅当无 .ifc 文件时检查） */
const IFC_TEXT_SIGNAL_KEYS: readonly string[] = ['IFC.NUM', 'IFCFILE', 'IFCGUID'];

/** 文件扩展名 → 计数字段映射辅助 */
function extOf(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx + 1).toLowerCase() : '';
}

/**
 * 将路径按 \ 和 / 切分为 segment 数组（兼容 Windows 反斜杠与解压后的正斜杠）。
 * 这样无论路径是 Cbm/project.cbm、demo-line/Cbm/project.cbm 还是 Cbm\project.cbm，
 * 都能正确识别其中的 Cbm 段。
 */
function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** 路径中是否包含任一指定 segment（区分大小写） */
function hasSegment(path: string, names: readonly string[]): boolean {
  const segs = pathSegments(path);
  return segs.some((s) => names.includes(s));
}

/**
 * 线路工程目录：路径中任意 segment 为 PascalCase 目录（Cbm/Dev/Mod/Phm/Fam）。
 * 变电工程使用全大写目录，因此 Cbm 不会匹配 CBM（区分大小写）。
 */
function isLineDir(path: string): boolean {
  return hasSegment(path, ['Cbm', 'Dev', 'Mod', 'Phm', 'Fam']);
}

/**
 * 变电工程目录：路径中任意 segment 为全大写目录（CBM/DEV/MOD/PHM）。
 */
function isSubstationDir(path: string): boolean {
  return hasSegment(path, ['CBM', 'DEV', 'MOD', 'PHM']);
}

/**
 * 识别 GIM 工程类型。
 *
 * 规则：
 * - hasIfc：存在 DEV/*.ifc，或 CBM 文本出现 IFC.NUM / IFCFILE / IFCGUID（KEY 级别匹配）
 * - hasLineArtifacts：存在 Mod/*.mod 或 Mod/*.stl，或 CBM/DEV/FAM 文本出现线路信号字段（KEY=VALUE 级别匹配）
 * - hasIfc && hasLineArtifacts → hybrid
 * - hasIfc → substation
 * - hasLineArtifacts → transmission_line
 * - 否则 → unknown
 *
 * 信号匹配策略（避免裸子串误判）：
 * - 精确键存在型（SECTIONS.NUM / GROUPTYPE / KVALUE 等）：kv[key] !== undefined
 * - 实体值型（WIRE / CROSS / Tower_Device 等）：ENTITYNAME === sig || GROUPTYPE === sig
 *   避免 WIREWEIGHT 包含 WIRE、CROSSSECTION 包含 CROSS 等误判。
 *
 * 不读取 IFC/STL 大文件全文，只统计数量；文本文件读取内容做 KEY=VALUE 级别匹配。
 */
export async function detectGimProjectType(
  files: Map<string, File>,
): Promise<GimProjectTypeResult> {
  let ifcCount = 0;
  let cbmCount = 0;
  let devCount = 0;
  let famCount = 0;
  let phmCount = 0;
  let modCount = 0;
  let stlCount = 0;
  // 位于 PascalCase Mod/ 目录下的 .mod/.stl 数量（线路工程特征）
  let lineModCount = 0;
  let lineStlCount = 0;
  // PascalCase 目录布局统计（兜底用：即使文本信号未命中也能识别线路工程）
  let lineCbmDirCount = 0;
  let lineDevDirCount = 0;
  let lineModDirCount = 0;
  let linePhmDirCount = 0;
  // 全大写目录文件数（变电工程特征，用于排查 hybrid 与误分类）
  let substationDirCount = 0;

  const textFilesToScan: { path: string; file: File }[] = [];

  for (const [path, file] of files) {
    const ext = extOf(path);
    const lineDir = isLineDir(path);
    if (isSubstationDir(path)) substationDirCount++;
    // 按路径 segment 统计 PascalCase 目录命中（兼容外层包裹目录，如 demo-line/Cbm/...）
    if (lineDir) {
      const segs = pathSegments(path);
      if (segs.includes('Cbm')) lineCbmDirCount++;
      if (segs.includes('Dev')) lineDevDirCount++;
      if (segs.includes('Mod')) lineModDirCount++;
      if (segs.includes('Phm')) linePhmDirCount++;
    }
    // 统计（按扩展名归类；IFC/STL 大文件不读全文，仅计数）
    if (ext === 'cbm') cbmCount++;
    else if (ext === 'dev') devCount++;
    else if (ext === 'fam') famCount++;
    else if (ext === 'phm') phmCount++;
    else if (ext === 'mod') {
      modCount++;
      if (lineDir) lineModCount++;
    }
    else if (ext === 'stl') {
      stlCount++;
      if (lineDir) lineStlCount++;
    }
    else if (ext === 'ifc') {
      ifcCount++;
      continue;
    }

    // 文本文件收集起来做关键字扫描：仅 CBM/DEV/FAM（这些文件通常很小）
    if ((ext === 'cbm' || ext === 'dev' || ext === 'fam') && file.size < 256 * 1024) {
      textFilesToScan.push({ path, file });
    }
  }

  // hasIfc 判定 1：存在 IFC 文件
  let hasIfc = ifcCount > 0;

  // hasLineArtifacts 判定 1：存在位于 PascalCase Mod/ 目录下的 .mod 或 .stl
  // spec 第三章：线路工程使用 Cbm/Dev/Mod/Phm 首字母大写目录；
  // 变电工程的 MOD/ 目录下也有 .mod/.stl，但不应计为线路特征。
  let hasLineArtifacts = lineModCount > 0 || lineStlCount > 0;

  const lineSignals = new Set<string>();

  // 扫描文本文件（KEY=VALUE 级别匹配，避免裸子串误判）
  for (const { file } of textFilesToScan) {
    let text: string;
    try {
      text = await file.text();
    } catch {
      continue;
    }
    // 解析为 KEY=VALUE 映射，避免裸子串匹配
    const kv = parseKeyValue(text);

    // IFC 信号：精确键存在
    if (!hasIfc) {
      for (const key of IFC_TEXT_SIGNAL_KEYS) {
        if (kv[key] !== undefined) {
          hasIfc = true;
          break;
        }
      }
    }

    // 线路信号：仅在尚未完全命中时继续扫描
    if (!hasLineArtifacts || lineSignals.size < TOTAL_LINE_SIGNALS) {
      // 精确键存在型：kv[key] !== undefined
      for (const key of EXACT_KEY_SIGNALS) {
        if (lineSignals.has(key)) continue;
        if (kv[key] !== undefined) {
          lineSignals.add(key);
          if (!hasLineArtifacts) hasLineArtifacts = true;
        }
      }
      // 实体值型：检查 ENTITYNAME / GROUPTYPE / DEVICETYPE 的值是否等于信号
      // 避免 WIREWEIGHT 包含 WIRE、CROSSSECTION 包含 CROSS 等裸子串误判
      const entityName = kv['ENTITYNAME'];
      const groupType = kv['GROUPTYPE'];
      const deviceType = kv['DEVICETYPE'];
      for (const sig of ENTITY_VALUE_SIGNALS) {
        if (lineSignals.has(sig)) continue;
        if (entityName === sig || groupType === sig || deviceType === sig) {
          lineSignals.add(sig);
          if (!hasLineArtifacts) hasLineArtifacts = true;
        }
      }
    }

    if (hasIfc && hasLineArtifacts && lineSignals.size > 0) {
      // 类型已可确定为 hybrid，提前结束
      break;
    }
  }

  // 兜底：即使文本信号未命中（如 .cbm 文件超 256KB 未扫描、或 KEY 未覆盖），
  // 只要存在 PascalCase 布局（Cbm/Dev/Mod 三类目录均有文件）且无 IFC，
  // 即判定为线路工程，避免误走变电流程污染 project_type=substation。
  if (!hasIfc && !hasLineArtifacts
    && lineCbmDirCount > 0 && lineDevDirCount > 0 && lineModDirCount > 0) {
    hasLineArtifacts = true;
    lineSignals.add('PascalCaseLayout:Cbm/Dev/Mod');
  }

  let type: GimProjectType;
  if (hasIfc && hasLineArtifacts) type = 'hybrid';
  else if (hasIfc) type = 'substation';
  else if (hasLineArtifacts) type = 'transmission_line';
  else type = 'unknown';

  const result: GimProjectTypeResult = {
    type,
    details: {
      hasIfc,
      hasLineArtifacts,
      ifcCount,
      cbmCount,
      devCount,
      famCount,
      phmCount,
      modCount,
      stlCount,
      lineCbmDirCount,
      lineDevDirCount,
      lineModDirCount,
      linePhmDirCount,
      substationDirCount,
      lineSignals: Array.from(lineSignals).sort(),
    },
  };

  debugLog(DEBUG_RUNTIME_LOGS, '[GIM] project type:', result);
  return result;
}
