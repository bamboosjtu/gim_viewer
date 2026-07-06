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

/**
 * 获取节点显示名称。
 *
 * 优先级链：
 * 1. 若节点有 ifcFile + ifcGuid → 查询 IFC 名称索引（最精确）
 * 2. 若节点是 DEV 虚拟子节点（devSymbolName 非空）→ 用 devSymbolName（SYMBOLNAME）
 * 3. 回退到 node.name（CBM 的 SYSTEMNAME 拼接 / PARTNAME / SYSCLASSIFYNAME / ENTITYNAME / 文件名）
 *
 * 注意：node.name 已在 buildCbmTree 中通过 extractDisplayName 提取最优名称，
 * 此函数仅在有 IFC 名称或 DEV SYMBOLNAME 覆盖时返回覆盖值。
 */
export function getNodeDisplayName(node: CbmNode, ifcGuidToName: Map<string, string>): string {
  // 1. IFC 名称索引最高优先
  if (node.ifcFile && node.ifcGuid) {
    const modelId = node.ifcFile.replace(/\.ifc$/i, '');
    const ifcName = ifcGuidToName.get(`${modelId}:${node.ifcGuid}`);
    if (ifcName) return ifcName;
  }

  // 2. DEV 虚拟子节点的 devSymbolName 覆盖
  if (node.devSymbolName) {
    return node.devSymbolName;
  }

  // 3. 回退到 node.name（已含 SYSTEMNAME 优先级链）
  return node.name;
}
