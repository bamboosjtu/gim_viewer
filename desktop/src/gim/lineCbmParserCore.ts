/**
 * 线路 CBM 图构建的同步核心。
 *
 * 该模块不读取 File、AppState 或 DOM，只消费 LineParserTextCache，因此可在
 * Web Worker 中运行。主线程兼容入口仍保留在 lineCbmParser.ts。
 */

import type { GimGraph, GimGraphNode } from './gimGraphTypes.js';
import { parseKeyValue } from './cbmParser.js';
import { DEBUG_RUNTIME_LOGS } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';
import { normalizeEntityName } from './entityName.js';
import { PARSER_LIMITS, parseBoundedCount } from './parserLimits.js';
import { LineParserTextCache } from './lineParserCache.js';
import { normalizeGimPath } from './linePathNormalize.js';

type ArrayRefField = 'cbmFiles' | 'devFiles' | 'famFiles' | 'phmFiles' | 'modFiles' | 'stlFiles' | 'wireFiles' | 'ifcFiles';

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

const NON_RECURSIVE_SINGLE_KEYS = ['BACKSTRING', 'FRONTSTRING', 'OBJECTMODELPOINTER', 'BASEFAMILY'] as const;
const ARRAY_REF_SPECS = [
  { num: 'SECTIONS.NUM', prefix: 'SECTION', recursive: true },
  { num: 'STRAINSECTIONS.NUM', prefix: 'STRAINSECTION', recursive: true },
  { num: 'GROUPS.NUM', prefix: 'GROUP', recursive: true },
  { num: 'TOWERS.NUM', prefix: 'TOWER', recursive: true },
  { num: 'BASES.NUM', prefix: 'BASE', recursive: true },
  { num: 'SUBDEVICES.NUM', prefix: 'SUBDEVICE', recursive: true },
] as const;
const STRING_NUM_KEY = 'STRINGS.NUM';

function suffixOf(value: string): string | null {
  const lower = value.toLowerCase();
  for (const suffix of Object.keys(REF_SUFFIX_MAP)) {
    if (lower.endsWith(suffix)) return suffix;
  }
  return null;
}

function extractFileName(value: string): string {
  const normalized = normalizeGimPath(value.trim());
  return normalized.split('/').pop() ?? normalized;
}

function emptyGraph(filesByType: GimGraph['filesByType']): GimGraph {
  return {
    projectType: 'transmission_line',
    root: null,
    nodesByPath: new Map(),
    filesByType,
    stats: {},
  };
}

/** 使用共享 cache 构建线路 CBM 图。 */
/**
 * 构建线路图；files 是已解码文本，路径大小写/分隔符不敏感。
 * 解析逻辑与原异步 parser 保持一致，但每个文件的 KV/文本由 cache 复用。
 */
export function buildLineGimGraphFromTexts(
  files: Iterable<{ path: string; text: string }>,
  sharedCache?: LineParserTextCache,
): GimGraph {
  const fileList = Array.from(files);
  const cache = sharedCache ?? new LineParserTextCache(fileList);
  const filesByType: GimGraph['filesByType'] = {
    cbm: [], dev: [], fam: [], phm: [], mod: [], stl: [], ifc: [], other: [],
  };
  for (const { path } of fileList) {
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

  let entryPath: string | null = null;
  for (const candidate of ['Cbm/project.cbm', 'CBM/project.cbm', 'cbm/project.cbm']) {
    const resolved = cache.resolveOriginalPath(candidate);
    if (resolved) { entryPath = resolved; break; }
  }
  if (!entryPath) {
    entryPath = filesByType.cbm[0] ?? null;
    if (entryPath) console.warn('[GIM] 未找到 project.cbm，回退使用第一个 .cbm 作为入口:', entryPath);
    else {
      console.warn('[GIM] 线路工程未找到任何 .cbm 文件');
      return emptyGraph(filesByType);
    }
  }

  const visited = new Set<string>();
  const nodesByPath = new Map<string, GimGraphNode>();
  const stats: Record<string, number> = {
    total: 0,
    F1System: 0, F2System: 0, F3System: 0, F4System: 0,
    Tower_Device: 0, Wire_Device: 0, WIRE: 0, CROSS: 0,
  };
  const nodeBudget = { count: 0 };

  function parseKv(path: string): Record<string, string> | null {
    return cache.parse('kv', path, parseKeyValue);
  }

  function resolveCrossCode(ompValue: string): string | null {
    try {
      const devName = extractFileName(ompValue);
      if (!devName.toLowerCase().endsWith('.dev')) return null;
      const dev = parseKv(devName);
      const phmRaw = dev?.['SOLIDMODEL0'];
      if (!phmRaw || !phmRaw.toLowerCase().endsWith('.phm')) return null;
      const phm = parseKv(extractFileName(phmRaw));
      const modRaw = phm?.['SOLIDMODEL0'];
      if (!modRaw || !modRaw.toLowerCase().endsWith('.mod')) return null;
      const modText = cache.getText(extractFileName(modRaw));
      if (!modText) return null;
      for (const line of modText.split(/\r?\n/)) {
        if (line.toUpperCase().startsWith('CODE=')) {
          return line.split('=').slice(1).join('=').trim() || null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function build(nodePath: string, depth = 0): GimGraphNode | null {
    if (depth > PARSER_LIMITS.maxRecursionDepth) {
      throw new Error(`线路 CBM 引用递归深度超过 ${PARSER_LIMITS.maxRecursionDepth}`);
    }
    const actualPath = cache.resolveOriginalPath(nodePath);
    if (!actualPath) return null;
    const visitKey = normalizeGimPath(actualPath).toLowerCase();
    if (visited.has(visitKey)) return null;
    visited.add(visitKey);
    nodeBudget.count++;
    if (nodeBudget.count > PARSER_LIMITS.maxLineNodes) {
      throw new Error(`线路 CBM 节点数超过安全上限 ${PARSER_LIMITS.maxLineNodes}`);
    }
    const kv = parseKv(actualPath);
    if (!kv) {
      console.warn('[GIM] 读取 CBM 文件失败:', actualPath);
      return null;
    }

    const entityName = normalizeEntityName(kv['ENTITYNAME'] || '');
    const classifyName = kv['GROUPTYPE'] || kv['WIRETYPE'] || kv['DEVICETYPE'] || kv['SYSCLASSIFYNAME'] || kv['PARTNAME'] || '';
    const fileName = normalizeGimPath(actualPath).split('/').pop() || actualPath;
    const name = classifyName || entityName || fileName;
    const refs: GimGraphNode['refs'] = {
      cbmFiles: [], devFiles: [], famFiles: [], phmFiles: [],
      modFiles: [], stlFiles: [], wireFiles: [], ifcFiles: [], rawRefs: {},
    };
    const children: GimGraphNode[] = [];

    function recordRef(value: string, rawKey?: string): void {
      const fn = extractFileName(value);
      if (!fn) return;
      const suffix = suffixOf(fn);
      if (suffix && REF_SUFFIX_MAP[suffix]) {
        const field = REF_SUFFIX_MAP[suffix];
        if (!refs[field].includes(fn)) refs[field].push(fn);
      }
      if (rawKey) {
        if (!refs.rawRefs[rawKey]) refs.rawRefs[rawKey] = [];
        if (!refs.rawRefs[rawKey].includes(value)) refs.rawRefs[rawKey].push(value);
      }
    }

    const subSystemVal = kv['SUBSYSTEM'];
    if (subSystemVal) {
      recordRef(subSystemVal, 'SUBSYSTEM');
      const child = build(subSystemVal, depth + 1);
      if (child) children.push(child);
    }
    for (const key of NON_RECURSIVE_SINGLE_KEYS) {
      const v = kv[key];
      if (v) recordRef(v, key);
    }
    for (const spec of ARRAY_REF_SPECS) {
      const num = parseBoundedCount(kv[spec.num], spec.num);
      for (let i = 0; i < num; i++) {
        const v = kv[`${spec.prefix}${i}`];
        if (!v) continue;
        recordRef(v, `${spec.prefix}${i}`);
        if (spec.recursive) {
          const child = build(v, depth + 1);
          if (child) children.push(child);
        }
      }
    }
    const stringsNum = parseBoundedCount(kv[STRING_NUM_KEY], STRING_NUM_KEY);
    for (let i = 0; i < stringsNum; i++) {
      const strVal = kv[`STRING${i}.STRING`];
      const gpoint = kv[`STRING${i}.GPOINT`];
      if (strVal) {
        recordRef(strVal, `STRING${i}.STRING`);
        const child = build(strVal, depth + 1);
        if (child) children.push(child);
      }
      if (gpoint) {
        if (!refs.rawRefs[`STRING${i}.GPOINT`]) refs.rawRefs[`STRING${i}.GPOINT`] = [];
        refs.rawRefs[`STRING${i}.GPOINT`].push(gpoint);
      }
    }
    const nonRecursiveKeysList = NON_RECURSIVE_SINGLE_KEYS as readonly string[];
    const arrayPrefixes = ARRAY_REF_SPECS.map((s) => s.prefix);
    for (const [k, v] of Object.entries(kv)) {
      if (!v) continue;
      if (k === 'SUBSYSTEM' || nonRecursiveKeysList.includes(k)) continue;
      if (ARRAY_REF_SPECS.some((s) => s.num === k)) continue;
      if (arrayPrefixes.some((p) => k.startsWith(p))) continue;
      if (k === STRING_NUM_KEY || k.startsWith('STRING')) continue;
      const suffix = suffixOf(v);
      if (suffix) {
        const fn = extractFileName(v);
        const field = REF_SUFFIX_MAP[suffix];
        if (fn && !refs[field].includes(fn)) {
          refs[field].push(fn);
          if (!refs.rawRefs[k]) refs.rawRefs[k] = [v];
          else if (!refs.rawRefs[k].includes(v)) refs.rawRefs[k].push(v);
        }
      }
    }
    if (entityName === 'CROSS') {
      const code = resolveCrossCode(kv['OBJECTMODELPOINTER'] || '');
      if (code) kv['CODE'] = code;
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

  const root = build(entryPath);
  stats.CBM = filesByType.cbm.length;
  stats.DEV = filesByType.dev.length;
  stats.FAM = filesByType.fam.length;
  stats.PHM = filesByType.phm.length;
  stats.MOD = filesByType.mod.length;
  stats.STL = filesByType.stl.length;
  stats.IFC = filesByType.ifc.length;
  stats.OTHER = filesByType.other.length;
  debugLog(DEBUG_RUNTIME_LOGS, '[GIM] line graph built in parser core:', {
    entry: entryPath,
    totalNodes: stats.total,
    stats,
  });
  return { projectType: 'transmission_line', root, nodesByPath, filesByType, stats };
}
