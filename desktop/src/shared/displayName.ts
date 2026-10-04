import type { CbmNode, IfcEntry } from '../gim/types.js';
import { resolveIfcModelId } from '../gim/modelIdentity.js';
import { resolveBaseFamilyReferences } from '../gim/gimValueSemantics.js';

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
 * 0. 变电节点已有 source-backed SYSTEMNAME / FAM 名称时使用该名称
 * 1. 若节点有 ifcFile + ifcGuid → 查询 IFC 名称索引（跳过占位符"&其他"）
 * 2. 若节点有 devSymbolName → 用 DEV SYMBOLNAME（设备名称）
 * 3. 回退到 node.name（CBM 的 SYSTEMNAME 拼接 / PARTNAME / SYSCLASSIFYNAME / ENTITYNAME / 文件名）
 *
 * 注意：node.name 已在 buildCbmTree 中通过 extractDisplayName 提取最优名称，
 * 缺失可读系统/FAM 名称时，设备层 node.name 才回退到 DEV SYMBOLNAME。
 */
export function getNodeDisplayName(
  node: CbmNode,
  ifcGuidToName: Map<string, string>,
  ifcEntries: readonly IfcEntry[] = [],
): string {
  // Source-backed substation names survive generic IFC/DEV type-name fallbacks.
  // Legacy nodes (including line projections) keep their existing priority.
  if (node.rawProperties && node.name && !isPlaceholderName(node.name)
    && (node.systemNames.length > 0 || (resolveBaseFamilyReferences(node.rawProperties).length > 0
      && node.name !== node.classifyName && node.name !== node.entityName))) return node.name;

  // 1. IFC 名称索引（跳过占位符）
  if (node.ifcFile && node.ifcGuid) {
    const modelId = resolveIfcModelId(node.ifcFile, ifcEntries)
      ?? (node.ifcFile.startsWith('ifc_') ? node.ifcFile : '');
    const ifcName = modelId ? ifcGuidToName.get(`${modelId}:${node.ifcGuid}`) : undefined;
    if (ifcName && !isPlaceholderName(ifcName)) return ifcName;
  }

  // 2. DEV SYMBOLNAME（设备名称）
  if (node.devSymbolName) {
    return node.devSymbolName;
  }

  // 3. 回退到 node.name
  return node.name;
}
