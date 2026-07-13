/**
 * STD/SLD/CBM 双向 gridId 索引。
 *
 * GIM 工程中 STD（拓扑）、SLD（单线图）、CBM（结构层级）三方通过 gridId 关联：
 *
 * - **STD**：`Bay.gridId`、`ConductingEquipment.gridId`（virtual=false 时才有非空 gridId）
 * - **SLD**：`<g gridId="..." type="Bay">`（与 STD 一一对应）
 * - **CBM**：`SYSCLASSIFYNAME=0AEC*002` ↔ STD/SLD `gridId=A0AEC*002`（多前缀 A）
 *
 * 三向匹配规则：
 * 1. STD gridId ↔ SLD gridId：完全相等（同源 ID）
 * 2. CBM SYSCLASSIFYNAME ↔ STD/SLD gridId：
 *    - CBM `0AEC*002` → STD/SLD `A0AEC*002`（CBM 前加 `A`）
 *    - 反向：STD/SLD `A0AEC*002` → CBM `0AEC*002`（去首字符 `A`）
 *
 * 关联文档：[05-cbm-tree-structure.md](../../docs/schema/05-cbm-tree-structure.md)
 */

import type { CbmNode } from './types.js';
import type { StdDocument, StdNode } from './stdParser.js';
import type { SldDocument, SldNode } from './sldParser.js';

/**
 * 三向关联索引：CBM ↔ STD ↔ SLD。
 *
 * 索引键为 gridId（STD/SLD 原生格式，含前缀 `A`），CBM 节点通过 `classifyName` 转换后匹配。
 */
export interface StdSldIndex {
  /** gridId → STD 节点 */
  stdByGridId: Map<string, StdNode>;
  /** gridId → SLD 节点 */
  sldByGridId: Map<string, SldNode>;
  /** gridId → CBM 节点列表（同一 gridId 可能对应多个 CBM 节点，例如不同 IFC 文件中的同型号设备） */
  cbmByGridId: Map<string, CbmNode[]>;
  /** CBM 节点 path → gridId（反向索引，便于从节点点击查 gridId） */
  gridIdByCbmPath: Map<string, string>;
  /** STD 中存在但 SLD 中缺失的 gridId 列表（仅 virtual=false 的设备） */
  stdOnlyGridIds: string[];
  /** SLD 中存在但 STD 中缺失的 gridId 列表 */
  sldOnlyGridIds: string[];
}

/**
 * 把 CBM SYSCLASSIFYNAME 转换为 STD/SLD gridId。
 *
 * 转换规则：
 * - 简单 gridId（单 `*`）：`0AEC*002` → `A0AEC*002`（**前置** `A`，不替换首字符）
 * - 复合 gridId（多 `*`，如 `0AEC*002GSK*010`）：保持原值不变（CBM 中本就不存在此值，无需转换）
 * - 非 gridId 格式（无 `*` 或非 `0` 开头）：原样返回，避免污染 entityName 等字段
 *
 * 注意：CBM 中 SYSCLASSIFYNAME 的首个字符代表工程类型：
 * - `0` → 主网工程
 * - `1` → 配网工程（极少见，本工程未涉及）
 * STD/SLD 统一加前缀 `A`（国家标准编码）。
 *
 * @param classifyName CBM SYSCLASSIFYNAME 字段（如 `0AEC*002`）
 * @returns 转换后的 gridId（如 `A0AEC*002`）
 */
export function cbmClassifyNameToGridId(classifyName: string): string {
  if (!classifyName) return '';
  // 仅对符合 SYSCLASSIFYNAME 模式的值做转换：首字符为 0 且仅含 1 个 *
  // 多 * 的复合 gridId（如 0AEC*002GSK*010）CBM 中不存在，保持原值即可
  const starCount = (classifyName.match(/\*/g) || []).length;
  if (classifyName.startsWith('0') && starCount === 1) {
    return 'A' + classifyName; // 前置 A，不替换首字符
  }
  return classifyName;
}

/**
 * 把 STD/SLD gridId 转换为 CBM SYSCLASSIFYNAME。
 *
 * 转换规则：
 * - 简单 gridId（单 `*`，以 `A0` 开头）：`A0AEC*002` → `0AEC*002`（**去除**前缀 `A`）
 * - 复合 gridId（多 `*`，如 `A0AEC*002GSK*010`）：保持原值不变（CBM 中无对应值，仅 STD/SLD 内部使用）
 * - 其他格式：原样返回
 *
 * @param gridId STD/SLD 中的 gridId
 * @returns 转换后的 CBM SYSCLASSIFYNAME
 */
export function gridIdToCbmClassifyName(gridId: string): string {
  if (!gridId) return '';
  const starCount = (gridId.match(/\*/g) || []).length;
  if (gridId.startsWith('A0') && starCount === 1) {
    return gridId.slice(1); // 去除前缀 A
  }
  return gridId;
}

/**
 * 从 CBM 树构建 gridId → CbmNode[] 索引。
 *
 * 遍历 CBM 树，对每个节点的 `classifyName` 字段执行 `cbmClassifyNameToGridId` 转换，
 * 累积到 `Map<gridId, CbmNode[]>`。
 *
 * 同一 gridId 可能对应多个 CBM 节点：
 * - 同一间隔下的多个设备（如 Bay.gridId 是 A0AEC*002，Bay 内的多个设备 CBM 节点也用此 classifyName）
 * - 多版本/多 IFC 文件中的同名设备
 *
 * @param cbmRoot CBM 根节点
 * @returns gridId → CbmNode[] 索引（空树返回空 Map）
 */
export function buildCbmGridIdIndex(cbmRoot: CbmNode | null): {
  cbmByGridId: Map<string, CbmNode[]>;
  gridIdByCbmPath: Map<string, string>;
} {
  const cbmByGridId = new Map<string, CbmNode[]>();
  const gridIdByCbmPath = new Map<string, string>();
  if (!cbmRoot) return { cbmByGridId, gridIdByCbmPath };

  function walk(node: CbmNode) {
    const gridId = cbmClassifyNameToGridId(node.classifyName);
    if (gridId && gridId !== node.classifyName) {
      // 仅写入转换后的 gridId（避免无 * 的 entityName 误判为 gridId）
      const arr = cbmByGridId.get(gridId);
      if (arr) arr.push(node);
      else cbmByGridId.set(gridId, [node]);
      gridIdByCbmPath.set(node.path, gridId);
    }
    for (const child of node.children) walk(child);
  }
  walk(cbmRoot);
  return { cbmByGridId, gridIdByCbmPath };
}

/**
 * 构建三向关联索引（CBM ↔ STD ↔ SLD）。
 *
 * 比对三个索引，输出：
 * - 三方共同存在的 gridId（无单独字段，可直接通过 stdByGridId + sldByGridId + cbmByGridId 取交集）
 * - STD-only（virtual=false 的设备缺失 SLD 渲染）：可能数据问题
 * - SLD-only（SLD 有图但 STD 无拓扑定义）：可能图形冗余
 *
 * @param cbmRoot CBM 根节点（可为 null）
 * @param stdDoc STD 文档（可为 null）
 * @param sldDoc SLD 文档（可为 null）
 */
export function buildStdSldIndex(
  cbmRoot: CbmNode | null,
  stdDoc: StdDocument | null,
  sldDoc: SldDocument | null,
): StdSldIndex {
  const stdByGridId = stdDoc?.gridIdIndex ?? new Map<string, StdNode>();
  const sldByGridId = sldDoc?.gridIdIndex ?? new Map<string, SldNode>();
  const { cbmByGridId, gridIdByCbmPath } = buildCbmGridIdIndex(cbmRoot);

  const stdOnlyGridIds: string[] = [];
  const sldOnlyGridIds: string[] = [];

  for (const [gridId, stdNode] of stdByGridId) {
    if (!sldByGridId.has(gridId)) {
      // 仅当 STD 节点为非虚拟设备或非虚拟间隔时才视为缺失（virtual 设备本就无图形）
      const isVirtual = (stdNode as StdNode & { virtual?: boolean }).virtual === true;
      if (!isVirtual) stdOnlyGridIds.push(gridId);
    }
  }
  for (const [gridId] of sldByGridId) {
    if (!stdByGridId.has(gridId)) sldOnlyGridIds.push(gridId);
  }

  return {
    stdByGridId,
    sldByGridId,
    cbmByGridId,
    gridIdByCbmPath,
    stdOnlyGridIds,
    sldOnlyGridIds,
  };
}

/**
 * 从 CBM 节点路径反查 gridId。
 *
 * 节点点击联动：用户点击 CBM 树节点 → 查 gridId → 在 SLD 中高亮对应 `<g>`。
 *
 * @param index 三向索引
 * @param cbmPath CBM 节点 path
 * @returns gridId（无匹配返回空字符串）
 */
export function getGridIdByCbmPath(index: StdSldIndex, cbmPath: string): string {
  return index.gridIdByCbmPath.get(cbmPath) || '';
}

/**
 * 从 gridId 反查 CBM 节点列表。
 *
 * SLD 高亮联动：用户在 SLD 中点击 `<g gridId="...">` → 查 CBM 节点 → 高亮 3D 模型。
 *
 * @param index 三向索引
 * @param gridId STD/SLD gridId
 * @returns CbmNode 列表（可能为空）
 */
export function getCbmNodesByGridId(index: StdSldIndex, gridId: string): CbmNode[] {
  return index.cbmByGridId.get(gridId) || [];
}
