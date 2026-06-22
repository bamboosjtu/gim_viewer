import type { IfcEntry, CbmNode } from './types.js';
import { parseKeyValue } from './cbmParser.js';
import { PARSER_LIMITS, parseBoundedCount } from './parserLimits.js';
import { findFileByPath, getFileByPath, hasFileByPath } from './fileLookup.js';

/**
 * 解析 CBM IFC 引用值的实际路径。
 *
 * IFC 文件位置随导出软件而异（JinQu 在 DEV/，Bentley 在 CBM/），
 * CBM 中 IFC0..N 只写裸文件名。解析顺序：常见目录拼接 → 全局 basename
 * 大小写不敏感匹配。找不到返回 null（调用方回退 DEV/ 拼接保持旧行为）。
 */
function resolveIfcPath(files: Map<string, File>, ref: string): string | null {
  for (const dir of ['DEV/', 'CBM/']) {
    const p = `${dir}${ref}`;
    const entry = findFileByPath(files, p);
    if (entry) return entry.path;
  }
  const refLower = ref.toLowerCase();
  for (const [path] of files) {
    if (!path.toLowerCase().endsWith('.ifc')) continue;
    const fn = path.split('/').pop()!;
    if (fn.toLowerCase() === refLower) return path;
  }
  return null;
}

/** 扫描全部目录下的 IFC 文件（兼容 DEV/、CBM/ 等不同导出布局） */
export function scanIfcFiles(files: Map<string, File>): IfcEntry[] {
  const entries: IfcEntry[] = [];
  for (const [path] of files) {
    if (path.toLowerCase().endsWith('.ifc')) {
      const fn = path.split('/').pop()!;
      entries.push({ name: fn.replace(/\.ifc$/i, ''), path, modelId: fn.replace(/\.ifc$/i, '') });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 从 CBM 层级递归发现 IFC 文件引用 */
export async function discoverIfcFromCBM(files: Map<string, File>): Promise<IfcEntry[]> {
  const visited = new Set<string>();
  const ifcSet = new Map<string, IfcEntry>();
  const fileByLowerPath = new Map<string, File>();
  for (const [path, file] of files) fileByLowerPath.set(path.replace(/\\/g, '/').toLowerCase(), file);
  let visitedCount = 0;
  async function walk(p: string, depth = 0) {
    if (depth > PARSER_LIMITS.maxRecursionDepth) throw new Error(`CBM IFC 引用递归深度超过 ${PARSER_LIMITS.maxRecursionDepth}`);
    const normalized = p.replace(/\\/g, '/');
    const visitKey = normalized.toLowerCase();
    if (visited.has(visitKey)) return; visited.add(visitKey);
    visitedCount++;
    if (visitedCount > PARSER_LIMITS.maxCbmNodes) throw new Error(`CBM IFC 节点数超过安全上限 ${PARSER_LIMITS.maxCbmNodes}`);
    const f = getFileByPath(files, p) ?? fileByLowerPath.get(visitKey); if (!f) return;
    const kv = parseKeyValue(await f.text());
    const n = parseBoundedCount(kv['IFC.NUM'], 'IFC.NUM');
    for (let i = 0; i < n; i++) { const r = kv[`IFC${i}`]; if (r) { const nm = r.replace(/\.ifc$/i, ''); ifcSet.set(nm, { name: nm, path: resolveIfcPath(files, r) ?? `DEV/${r}`, modelId: nm }); } }
    const sn = parseBoundedCount(kv['SUBSYSTEMS.NUM'], 'SUBSYSTEMS.NUM');
    for (let i = 0; i < sn; i++) { const s = kv[`SUBSYSTEM${i}`]; if (s) await walk(`CBM/${s}`, depth + 1); }
    const sg = kv['SUBSYSTEM']; if (sg) await walk(`CBM/${sg}`, depth + 1);
  }
  const entry = hasFileByPath(files, 'CBM/project.cbm')
    ? 'CBM/project.cbm'
    : Array.from(files.keys()).find((path) => path.replace(/\\/g, '/').toLowerCase() === 'cbm/project.cbm');
  if (entry) await walk(entry);
  return Array.from(ifcSet.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 构建 IFCGUID → CbmNode 反向索引 */
export function buildIfcGuidIndex(node: CbmNode | null): Map<string, CbmNode> {
  const index = new Map<string, CbmNode>();
  function walk(n: CbmNode) {
    if (n.ifcGuid && n.ifcFile) {
      index.set(`${n.ifcFile}:${n.ifcGuid}`, n);
    }
    for (const child of n.children) walk(child);
  }
  if (node) walk(node);
  return index;
}

// getNodeDisplayName / isPlaceholderName 已迁移至 shared/displayName.ts
// 此处保留 re-export 以兼容 viewer/highlight.ts 等已有导入
export { getNodeDisplayName } from '../shared/displayName.js';
