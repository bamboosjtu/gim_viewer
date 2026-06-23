import type { IfcEntry, CbmNode } from './types.js';
import { parseKeyValue } from './cbmParser.js';

/** 扫描 DEV/ 目录下的 IFC 文件 */
export function scanIfcFiles(files: Map<string, File>): IfcEntry[] {
  const entries: IfcEntry[] = [];
  for (const [path] of files) {
    if (path.startsWith('DEV/') && path.toLowerCase().endsWith('.ifc')) {
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
  async function walk(p: string) {
    if (visited.has(p)) return; visited.add(p);
    const f = files.get(p); if (!f) return;
    const kv = parseKeyValue(await f.text());
    const n = parseInt(kv['IFC.NUM'] || '0', 10);
    for (let i = 0; i < n; i++) { const r = kv[`IFC${i}`]; if (r) { const nm = r.replace(/\.ifc$/i, ''); ifcSet.set(nm, { name: nm, path: `DEV/${r}`, modelId: nm }); } }
    const sn = parseInt(kv['SUBSYSTEMS.NUM'] || '0', 10);
    for (let i = 0; i < sn; i++) { const s = kv[`SUBSYSTEM${i}`]; if (s) await walk(`CBM/${s}`); }
    const sg = kv['SUBSYSTEM']; if (sg) await walk(`CBM/${sg}`);
  }
  if (files.has('CBM/project.cbm')) await walk('CBM/project.cbm');
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

/** 获取节点显示名称：优先 IFC 名称索引，其次分类名称 */
export function getNodeDisplayName(node: CbmNode, ifcGuidToName: Map<string, string>): string {
  if (node.ifcFile && node.ifcGuid) {
    const modelId = node.ifcFile.replace(/\.ifc$/i, '');
    const ifcName = ifcGuidToName.get(`${modelId}:${node.ifcGuid}`);
    if (ifcName) return ifcName;
  }
  return node.name;
}
