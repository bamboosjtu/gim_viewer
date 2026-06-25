/**
 * GIM 工程类型识别。
 *
 * 依据 gim-analysis.md 第三章：
 * - 变电工程：CBM/DEV/MOD/PHM（全大写），含 IFC 文件，FileDevRelation.cbm
 * - 线路工程：Cbm/Dev/Mod/Phm（首字母大写），无 IFC，每层引用键不同
 *
 * 识别策略：只读取文本文件（CBM/DEV/FAM），不读取 IFC/STL 大文件全文。
 */

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
  /** 命中的线路信号字段列表，便于排查 */
  lineSignals: string[];
}

export interface GimProjectTypeResult {
  type: GimProjectType;
  details: GimProjectTypeDetails;
}

/** 线路工程特征信号字段（出现任一即判定为线路工程特征） */
const LINE_SIGNAL_KEYS: readonly string[] = [
  'SECTIONS.NUM',
  'STRAINSECTIONS.NUM',
  'GROUPS.NUM',
  'TOWERS.NUM',
  'STRINGS.NUM',
  'BASES.NUM',
  'GROUPTYPE',
  'WIRETYPE',
  'Tower_Device',
  'Wire_Device',
  'WIRE',
  'CROSS',
  'KVALUE',
  'POINT0.BLHA',
  'DEVICETYPE',
] as const;

/** 文件扩展名 → 计数字段映射辅助 */
function extOf(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx + 1).toLowerCase() : '';
}

/**
 * 判断文件是否位于线路工程的 PascalCase 目录（Cbm/Dev/Mod/Phm/Fam）。
 * 变电工程使用全大写目录（CBM/DEV/MOD/PHM），线路工程使用首字母大写目录。
 * spec 第三章：线路工程使用 Cbm/Dev/Mod/Phm 首字母大写目录。
 */
function isLineDir(path: string): boolean {
  // 顶层目录名（区分大小写）
  const top = path.split('/')[0] || '';
  return top === 'Cbm' || top === 'Dev' || top === 'Mod' || top === 'Phm' || top === 'Fam';
}

/**
 * 识别 GIM 工程类型。
 *
 * 规则：
 * - hasIfc：存在 DEV/*.ifc，或 CBM 文本出现 IFC.NUM / IFCFILE / IFCGUID
 * - hasLineArtifacts：存在 Mod/*.mod 或 *.stl，或 CBM/DEV/FAM 文本出现线路信号字段
 * - hasIfc && hasLineArtifacts → hybrid
 * - hasIfc → substation
 * - hasLineArtifacts → transmission_line
 * - 否则 → unknown
 *
 * 不读取 IFC/STL 大文件全文，只统计数量；文本文件读取内容做关键字匹配。
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

  const textFilesToScan: { path: string; file: File }[] = [];

  for (const [path, file] of files) {
    const ext = extOf(path);
    const lineDir = isLineDir(path);
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
  // IFC 文本信号（仅当还没有 hasIfc 时需要从 CBM 文本验证）
  const ifcTextSignals = ['IFC.NUM', 'IFCFILE', 'IFCGUID'];

  // 扫描文本文件
  for (const { file } of textFilesToScan) {
    let text: string;
    try {
      text = await file.text();
    } catch {
      continue;
    }
    // 文件读取后该 File 对象已被消费，但 Map 中的引用不变，后续 lineCbmParser 会重新读取
    // 这里只做字符串匹配
    if (!hasIfc) {
      for (const sig of ifcTextSignals) {
        if (text.includes(sig)) {
          hasIfc = true;
          break;
        }
      }
    }
    if (!hasLineArtifacts || lineSignals.size < LINE_SIGNAL_KEYS.length) {
      for (const sig of LINE_SIGNAL_KEYS) {
        if (lineSignals.has(sig)) continue;
        // 线路信号字段以 KEY=VALUE 形式出现，用 indexOf 匹配键名
        // 注意 WIRE/CROSS/Tower_Device/Wire_Device 可能出现在 ENTITYNAME=xxx 行
        if (text.includes(sig)) {
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
      lineSignals: Array.from(lineSignals).sort(),
    },
  };

  console.log('[GIM] project type:', result);
  return result;
}
