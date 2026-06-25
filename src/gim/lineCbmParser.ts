/**
 * 线路工程 CBM 解析器。
 *
 * 与变电工程的 cbmParser 不同，线路工程每层引用键不同：
 * - F1System: SECTIONS.NUM + SECTION<i>
 * - F2System: STRAINSECTIONS.NUM + STRAINSECTION<i>
 * - F3System: GROUPS.NUM + GROUP<i>
 * - F4System (GROUPTYPE=TOWER): TOWERS.NUM + TOWER<i>, STRINGS.NUM + STRING<i>.STRING, BASES.NUM + BASE<i>, SUBDEVICES.NUM + SUBDEVICE<i>
 * - F4System (GROUPTYPE=WIRE): BACKSTRING, FRONTSTRING, SUBDEVICES.NUM + SUBDEVICE<i>
 * - Tower_Device/Wire_Device/WIRE/CROSS: OBJECTMODELPOINTER(→.dev), BASEFAMILY(→.fam)
 *
 * 依据 gim-analysis.md 第三章。
 */

import type { GimGraph, GimGraphNode } from './gimGraphTypes.js';
import { parseKeyValue } from './cbmParser.js';

/** refs 中数组类型的字段名（排除 rawRefs） */
type ArrayRefField = 'cbmFiles' | 'devFiles' | 'famFiles' | 'phmFiles' | 'modFiles' | 'stlFiles' | 'wireFiles' | 'ifcFiles';

/** 文件引用后缀 → refs 数组字段映射 */
const REF_SUFFIX_MAP: Record<string, ArrayRefField> = {
  '.cbm': 'cbmFiles',
  '.dev': 'devFiles',
  '.fam': 'famFiles',
  '.phm': 'phmFiles',
  '.mod': 'modFiles',
  '.stl': 'stlFiles',
  '.wire': 'wireFiles',
  '.ifc': 'ifcFiles',
};

/** 非递归单值引用键（仅记录引用，不建立子节点） */
const NON_RECURSIVE_SINGLE_KEYS = ['BACKSTRING', 'FRONTSTRING', 'OBJECTMODELPOINTER', 'BASEFAMILY'] as const;

/** 数组引用键规格：NUM 键 + 元素前缀 */
const ARRAY_REF_SPECS = [
  { num: 'SECTIONS.NUM', prefix: 'SECTION', recursive: true },
  { num: 'STRAINSECTIONS.NUM', prefix: 'STRAINSECTION', recursive: true },
  { num: 'GROUPS.NUM', prefix: 'GROUP', recursive: true },
  { num: 'TOWERS.NUM', prefix: 'TOWER', recursive: true },
  { num: 'BASES.NUM', prefix: 'BASE', recursive: true },
  { num: 'SUBDEVICES.NUM', prefix: 'SUBDEVICE', recursive: true },
] as const;

/** STRING 数组：STRINGS.NUM + STRING<i>.STRING（递归）+ STRING<i>.GPOINT（挂点名，非文件） */
const STRING_NUM_KEY = 'STRINGS.NUM';

/** 取文件名小写作为查找键（GIM 文件名是 GUID，全局唯一） */
function lowerFileName(path: string): string {
  const idx = path.lastIndexOf('/');
  const name = idx >= 0 ? path.slice(idx + 1) : path;
  return name.toLowerCase();
}

/** 判断 value 是否是文件引用（按后缀） */
function suffixOf(value: string): string | null {
  const lower = value.toLowerCase();
  for (const suffix of Object.keys(REF_SUFFIX_MAP)) {
    if (lower.endsWith(suffix)) return suffix;
  }
  return null;
}

/** 从 value 提取文件名（去除可能的路径前缀，保留 xxx.ext） */
function extractFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  // value 可能是 "xxx.cbm" 或 "Cbm/xxx.cbm"，取最后一段
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * 构建线路工程 GIM 图。
 *
 * 流程：
 * 1. 确定 CBM 目录前缀（Cbm/ 或 CBM/），定位 project.cbm
 * 2. 构建 fileName → {path, file} 索引（兼容大小写）
 * 3. 从 project.cbm 的 SUBSYSTEM 入口递归构建节点
 * 4. 递归过程中识别所有引用键，建立 refs 和 children
 * 5. 用 visited 防止循环引用
 * 6. 收集 stats 和 filesByType
 */
export async function buildLineGimGraph(
  files: Map<string, File>,
): Promise<GimGraph> {
  // 1. 构建 fileName(小写) → {path, file} 索引
  const fileByName = new Map<string, { path: string; file: File }>();
  for (const [path, file] of files) {
    fileByName.set(lowerFileName(path), { path, file });
  }

  // 2. 收集 filesByType
  const filesByType: GimGraph['filesByType'] = {
    cbm: [], dev: [], fam: [], phm: [], mod: [], stl: [], ifc: [], other: [],
  };
  for (const path of files.keys()) {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    if (ext === 'cbm') filesByType.cbm.push(path);
    else if (ext === 'dev') filesByType.dev.push(path);
    else if (ext === 'fam') filesByType.fam.push(path);
    else if (ext === 'phm') filesByType.phm.push(path);
    else if (ext === 'mod') filesByType.mod.push(path);
    else if (ext === 'stl') filesByType.stl.push(path);
    else if (ext === 'ifc') filesByType.ifc.push(path);
    else filesByType.other.push(path);
  }

  // 3. 定位入口：优先 Cbm/project.cbm / CBM/project.cbm
  let entryPath: string | null = null;
  for (const candidate of ['Cbm/project.cbm', 'CBM/project.cbm', 'cbm/project.cbm']) {
    if (files.has(candidate)) { entryPath = candidate; break; }
  }
  if (!entryPath) {
    // 回退：取第一个 .cbm 文件作为入口
    const firstCbm = filesByType.cbm[0];
    if (firstCbm) {
      entryPath = firstCbm;
      console.warn('[GIM] 未找到 project.cbm，回退使用第一个 .cbm 作为入口:', entryPath);
    } else {
      console.warn('[GIM] 线路工程未找到任何 .cbm 文件');
      return { projectType: 'transmission_line', root: null, nodesByPath: new Map(), filesByType, stats: {} };
    }
  }

  // 4. 递归构建
  const visited = new Set<string>();
  const nodesByPath = new Map<string, GimGraphNode>();
  const stats: Record<string, number> = {
    total: 0,
    F1System: 0, F2System: 0, F3System: 0, F4System: 0,
    Tower_Device: 0, Wire_Device: 0, WIRE: 0, CROSS: 0,
  };

  async function build(nodePath: string): Promise<GimGraphNode | null> {
    const lowerName = lowerFileName(nodePath);
    if (visited.has(lowerName)) return null;
    visited.add(lowerName);

    const entry = fileByName.get(lowerName);
    if (!entry) return null;
    const file = entry.file;
    const actualPath = entry.path;

    let kv: Record<string, string>;
    try {
      kv = parseKeyValue(await file.text());
    } catch {
      console.warn('[GIM] 读取 CBM 文件失败:', actualPath);
      return null;
    }

    const entityName = kv['ENTITYNAME'] || '';
    const classifyName = kv['GROUPTYPE'] || kv['WIRETYPE'] || kv['DEVICETYPE'] || kv['SYSCLASSIFYNAME'] || kv['PARTNAME'] || '';
    const fileName = actualPath.split('/').pop() || actualPath;
    const name = classifyName || entityName || fileName;

    // 收集引用
    const refs: GimGraphNode['refs'] = {
      cbmFiles: [], devFiles: [], famFiles: [], phmFiles: [],
      modFiles: [], stlFiles: [], wireFiles: [], ifcFiles: [],
      rawRefs: {},
    };
    const children: GimGraphNode[] = [];

    /** 将引用值归类到 refs */
    function recordRef(value: string, rawKey?: string): void {
      const fn = extractFileName(value);
      if (!fn) return;
      const suffix = suffixOf(fn);
      if (suffix && REF_SUFFIX_MAP[suffix]) {
        const field = REF_SUFFIX_MAP[suffix];
        // 去重
        if (!refs[field].includes(fn)) refs[field].push(fn);
      }
      if (rawKey) {
        if (!refs.rawRefs[rawKey]) refs.rawRefs[rawKey] = [];
        if (!refs.rawRefs[rawKey].includes(value)) refs.rawRefs[rawKey].push(value);
      }
    }

    // SUBSYSTEM：递归单值引用（project.cbm → F1System 入口）
    const subSystemVal = kv['SUBSYSTEM'];
    if (subSystemVal) {
      recordRef(subSystemVal, 'SUBSYSTEM');
      const child = await build(subSystemVal);
      if (child) children.push(child);
    }

    // 非递归单值引用键（BACKSTRING/FRONTSTRING/OBJECTMODELPOINTER/BASEFAMILY）
    for (const key of NON_RECURSIVE_SINGLE_KEYS) {
      const v = kv[key];
      if (v) recordRef(v, key);
    }

    // 数组引用键（NUM + PREFIX<i>）
    for (const spec of ARRAY_REF_SPECS) {
      const num = parseInt(kv[spec.num] || '0', 10);
      for (let i = 0; i < num; i++) {
        const v = kv[`${spec.prefix}${i}`];
        if (v) {
          recordRef(v, `${spec.prefix}${i}`);
          if (spec.recursive) {
            const child = await build(v);
            if (child) children.push(child);
          }
        }
      }
    }

    // STRING 数组特殊处理：STRINGS.NUM + STRING<i>.STRING（递归）+ STRING<i>.GPOINT（挂点名）
    const stringsNum = parseInt(kv[STRING_NUM_KEY] || '0', 10);
    for (let i = 0; i < stringsNum; i++) {
      const strVal = kv[`STRING${i}.STRING`];
      const gpoint = kv[`STRING${i}.GPOINT`];
      if (strVal) {
        recordRef(strVal, `STRING${i}.STRING`);
        const child = await build(strVal);
        if (child) children.push(child);
      }
      if (gpoint) {
        // GPOINT 是挂点名称（如"前导6"），非文件引用，保留到 rawRefs
        if (!refs.rawRefs[`STRING${i}.GPOINT`]) refs.rawRefs[`STRING${i}.GPOINT`] = [];
        refs.rawRefs[`STRING${i}.GPOINT`].push(gpoint);
      }
    }

    // 兜底：扫描所有 kv，捕获未识别但带文件后缀的引用（如 POINT<i>.MATRIX 等非引用键会被跳过）
    // 注意：WIRE 节点的 POINT<i>.BLHA / POINT<i>.MATRIX0 不是文件引用，已存在 rawProps 中
    // 这里只补充捕获其他可能遗漏的文件引用键
    const nonRecursiveKeysList = NON_RECURSIVE_SINGLE_KEYS as readonly string[];
    const arrayPrefixes = ARRAY_REF_SPECS.map(s => s.prefix);
    for (const [k, v] of Object.entries(kv)) {
      if (!v) continue;
      // 跳过已处理的键
      if (k === 'SUBSYSTEM' || nonRecursiveKeysList.includes(k)) continue;
      if (ARRAY_REF_SPECS.some(s => s.num === k)) continue;
      if (arrayPrefixes.some(p => k.startsWith(p))) continue;
      if (k === STRING_NUM_KEY || k.startsWith('STRING')) continue;
      // 跳过非引用属性键（ENTITYNAME/TRANSFORMMATRIX/BLHA/MODLEG/KVALUE/SPLIT/POINT*/ISJUMPER/MATERIALSHEET 等）
      const suffix = suffixOf(v);
      if (suffix) {
        // 捕获遗漏的文件引用（如 OBJECTMODELPOINTER 已在 SINGLE_REF_KEYS，这里兜底）
        const fn = extractFileName(v);
        const field = REF_SUFFIX_MAP[suffix];
        if (fn && !refs[field].includes(fn)) {
          refs[field].push(fn);
          if (!refs.rawRefs[k]) refs.rawRefs[k] = [v];
          else if (!refs.rawRefs[k].includes(v)) refs.rawRefs[k].push(v);
        }
      }
    }

    const node: GimGraphNode = {
      path: actualPath,
      name,
      entityName,
      classifyName,
      rawProps: kv,
      children,
      refs,
    };

    nodesByPath.set(actualPath, node);
    stats.total++;
    if (entityName && entityName in stats) stats[entityName]++;
    return node;
  }

  const root = await build(entryPath);

  // 5. 补充各类文件数到 stats（与缓存恢复路径保持一致，UI 从 stats 读取计数）
  stats.CBM = filesByType.cbm.length;
  stats.DEV = filesByType.dev.length;
  stats.FAM = filesByType.fam.length;
  stats.PHM = filesByType.phm.length;
  stats.MOD = filesByType.mod.length;
  stats.STL = filesByType.stl.length;
  stats.IFC = filesByType.ifc.length;
  stats.OTHER = filesByType.other.length;

  console.log('[GIM] line graph built:', {
    entry: entryPath,
    totalNodes: stats.total,
    stats,
    filesByType: {
      cbm: filesByType.cbm.length,
      dev: filesByType.dev.length,
      fam: filesByType.fam.length,
      phm: filesByType.phm.length,
      mod: filesByType.mod.length,
      stl: filesByType.stl.length,
      ifc: filesByType.ifc.length,
    },
  });

  return { projectType: 'transmission_line', root, nodesByPath, filesByType, stats };
}
