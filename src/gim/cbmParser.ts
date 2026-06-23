import type { CbmNode } from './types.js';

/** 解析 KEY=VALUE 格式文本 */
export function parseKeyValue(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

/** 从文件集合递归构建 CBM 层级树 */
export async function buildCbmTree(files: Map<string, File>): Promise<CbmNode | null> {
  const visited = new Set<string>();
  async function build(p: string): Promise<CbmNode | null> {
    if (visited.has(p)) return null; visited.add(p);
    const f = files.get(p); if (!f) return null;
    const kv = parseKeyValue(await f.text());
    const en = kv['ENTITYNAME'] || '';
    const cn = kv['SYSCLASSIFYNAME'] || kv['PARTNAME'] || '';
    const dn = cn || en || p.split('/').pop()!;
    const children: CbmNode[] = [];
    const sg = kv['SUBSYSTEM']; if (sg) { const c = await build(`CBM/${sg}`); if (c) children.push(c); }
    const sn = parseInt(kv['SUBSYSTEMS.NUM'] || '0', 10);
    for (let i = 0; i < sn; i++) { const s = kv[`SUBSYSTEM${i}`]; if (s) { const c = await build(`CBM/${s}`); if (c) children.push(c); } }
    const dn2 = parseInt(kv['SUBDEVICES.NUM'] || '0', 10);
    for (let i = 0; i < dn2; i++) { const s = kv[`SUBDEVICE${i}`]; if (s) { const c = await build(`CBM/${s}`); if (c) children.push(c); } }
    return { path: p, name: dn, entityName: en, children, famPath: kv['BASEFAMILY'] || '', devPath: kv['OBJECTMODELPOINTER'] || '', ifcFile: kv['IFCFILE'] || '', ifcGuid: (kv['IFCGUID'] || '').replace(/\$+$/, '').trim(), classifyName: cn, transformMatrix: kv['TRANSFORMMATRIX'] || '' };
  }
  if (!files.has('CBM/project.cbm')) return null;
  return build('CBM/project.cbm');
}

/** 构建 CBM 文件名 → CbmNode 索引 */
export function buildCbmNodeIndex(node: CbmNode | null): Map<string, CbmNode> {
  const index = new Map<string, CbmNode>();
  function walk(n: CbmNode) {
    const fileName = n.path.split('/').pop() || '';
    if (fileName) index.set(fileName, n);
    for (const child of n.children) walk(child);
  }
  if (node) walk(node);
  return index;
}

/** 收集节点及其后代的所有 IFC 引用 → Map<modelId, Set<ifcGuid>> */
export function collectIfcRefs(node: CbmNode): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  function walk(n: CbmNode) {
    if (n.ifcFile && n.ifcGuid) {
      const modelId = n.ifcFile.replace(/\.ifc$/i, '');
      if (!refs.has(modelId)) refs.set(modelId, new Set());
      refs.get(modelId)!.add(n.ifcGuid);
    }
    for (const child of n.children) walk(child);
  }
  walk(node);
  return refs;
}
