import type { CbmNode } from '../gim/types.js';

/**
 * 判断 IFC Name 是否为占位符（无意义名称）。
 *
 * GIM/IFC 中部分构件的 Name 是 "&其他" / "其他" / "Other" 等占位符，
 * 这些名称对用户无意义，应回退到更可读的名称源。
 */
export function isPlaceholderName(name: string): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (trimmed === '') return true;
  if (trimmed === '&其他' || trimmed === '其他') return true;
  if (trimmed.toLowerCase() === 'other' || trimmed.toLowerCase() === 'others') return true;
  return false;
}

/**
 * 获取节点显示名称。
 *
 * 优先级链：
 * 1. 若节点有 ifcFile + ifcGuid → 查询 IFC 名称索引（跳过占位符"&其他"）
 * 2. 若节点有 devSymbolName → 用 DEV SYMBOLNAME（设备名称）
 * 3. 回退到 node.name（CBM 的 SYSTEMNAME 拼接 / PARTNAME / SYSCLASSIFYNAME / ENTITYNAME / 文件名）
 *
 * 注意：node.name 已在 buildCbmTree 中通过 extractDisplayName 提取最优名称，
 * 对 F4System/PARTINDEX 设备层节点，node.name 已被 DEV SYMBOLNAME 覆盖。
 */
export function getNodeDisplayName(node: CbmNode, ifcGuidToName: Map<string, string>): string {
  // 1. IFC 名称索引（跳过占位符）
  if (node.ifcFile && node.ifcGuid) {
    const modelId = node.ifcFile.replace(/\.ifc$/i, '');
    const ifcName = ifcGuidToName.get(`${modelId}:${node.ifcGuid}`);
    if (ifcName && !isPlaceholderName(ifcName)) return ifcName;
  }

  // 2. DEV SYMBOLNAME（设备名称）
  if (node.devSymbolName) {
    return node.devSymbolName;
  }

  // 3. 回退到 node.name
  return node.name;
}
