/**
 * 线路工程图缓存持久化服务。
 *
 * 将内存中的 GimGraph 扁平化为可写入 SQLite 的 LineGraphPayload，
 * 并通过 Tauri command save_line_gim_graph 落库。
 *
 * 设计参考 gimIndexPersistenceService.ts（变电工程索引入库），
 * 区别在于线路工程无 IFC/FileDevRelation，采用通用图结构：
 * - nodes：DFS 遍历 root，记录每个节点（sort_order = 兄弟索引）
 * - children：parent → child 关系（ref_type='CHILD'）
 * - refs：节点引用清单（8 个数组字段 + rawRefs 原始引用键）
 * - file_stats：filesByType 各类型文件数量
 *
 * 依据 Line-2 spec：v4 adds transmission_line graph cache
 */

import type { GimGraph, GimGraphNode } from '../gim/gimGraphTypes.js';
import type {
  LineGraphPayload,
  LineCbmNodePayload,
  LineCbmChildPayload,
  LineCbmRefPayload,
  LineFileStatPayload,
} from '../desktop/database.js';
import { saveLineGraph as saveLineGraphToDb } from '../desktop/database.js';
import { LineRefKind } from '../gim/lineRefKind.js';
import { normalizeGimPath, getFileNameLower } from '../gim/linePathNormalize.js';

/** refs 中数组型字段名（对应 GimGraphNode.refs 的 8 个 string[] 字段，排除 rawRefs） */
type ArrayRefField = 'cbmFiles' | 'devFiles' | 'famFiles' | 'phmFiles' | 'modFiles' | 'stlFiles' | 'wireFiles' | 'ifcFiles';

const ARRAY_REF_FIELDS_LIST: readonly ArrayRefField[] = [
  LineRefKind.CBM_FILES,
  LineRefKind.DEV_FILES,
  LineRefKind.FAM_FILES,
  LineRefKind.PHM_FILES,
  LineRefKind.MOD_FILES,
  LineRefKind.STL_FILES,
  LineRefKind.WIRE_FILES,
  LineRefKind.IFC_FILES,
] as readonly ArrayRefField[];

/** filesByType 字段名 → line_file_stat.file_type 映射（小写） */
const FILE_TYPE_KEYS: ReadonlyArray<keyof GimGraph['filesByType']> = [
  'cbm',
  'dev',
  'fam',
  'phm',
  'mod',
  'stl',
  'ifc',
  'other',
];

/** 单个节点 → LineCbmNodePayload */
function toNodePayload(node: GimGraphNode, sortOrder: number | null): LineCbmNodePayload {
  return {
    path: node.path,
    name: node.name || null,
    entity_name: node.entityName || null,
    classify_name: node.classifyName || null,
    raw_props_json: JSON.stringify(node.rawProps),
    sort_order: sortOrder,
  };
}

/** DFS 遍历节点，收集 nodes + children（ref_type='CHILD'） */
function flattenLineNode(
  node: GimGraphNode,
  sortOrder: number,
  nodes: LineCbmNodePayload[],
  children: LineCbmChildPayload[],
): void {
  nodes.push(toNodePayload(node, sortOrder));
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    children.push({
      parent_path: node.path,
      child_path: child.path,
      sort_order: i,
      ref_type: 'CHILD',
      extra: null,
    });
    flattenLineNode(child, i, nodes, children);
  }
}

/** 收集单个节点的引用清单到 refs（v5: 同步写入 normalized_ref_value / file_name_lower） */
function collectRefs(node: GimGraphNode, refs: LineCbmRefPayload[]): void {
  const nodePath = node.path;

  // 数组型引用：ref_kind = 字段名（如 cbmFiles），ref_key = null
  // v5: 对引用值做路径归一化，供诊断时匹配 FAM/DEV 文件
  for (const field of ARRAY_REF_FIELDS_LIST) {
    const arr = node.refs[field];
    for (let i = 0; i < arr.length; i++) {
      const refValue = arr[i];
      refs.push({
        node_path: nodePath,
        ref_kind: field,
        ref_key: null,
        ref_value: refValue,
        sort_order: i,
        normalized_ref_value: normalizeGimPath(refValue),
        file_name_lower: getFileNameLower(refValue),
      });
    }
  }

  // rawRefs：保留原始引用键（如 SUBSYSTEM / SECTION0 / STRING0.GPOINT）
  // rawRefs 值不一定是文件路径，但仍统一归一化（无斜杠时原样返回，不影响匹配）
  for (const [rawKey, vals] of Object.entries(node.refs.rawRefs)) {
    for (let i = 0; i < vals.length; i++) {
      const refValue = vals[i];
      refs.push({
        node_path: nodePath,
        ref_kind: LineRefKind.RAW_REFS,
        ref_key: rawKey,
        ref_value: refValue,
        sort_order: i,
        normalized_ref_value: normalizeGimPath(refValue),
        file_name_lower: getFileNameLower(refValue),
      });
    }
  }
}

/**
 * 构造线路工程图 payload，用于 save_line_gim_graph。
 *
 * @param projectId 数据库 gim_project.id
 * @param graph 已构建的线路工程图
 */
export function buildLineGraphPayload(projectId: number, graph: GimGraph): LineGraphPayload {
  const nodes: LineCbmNodePayload[] = [];
  const children: LineCbmChildPayload[] = [];
  const refs: LineCbmRefPayload[] = [];

  // 1. DFS 遍历 root 收集 nodes + children
  if (graph.root) {
    flattenLineNode(graph.root, 0, nodes, children);
  }
  // 兜底：nodesByPath 中存在未被 root 遍历到的节点（理论上不会发生，防御性写入）
  const visited = new Set(nodes.map((n) => n.path));
  for (const node of graph.nodesByPath.values()) {
    if (!visited.has(node.path)) {
      nodes.push(toNodePayload(node, null));
    }
  }

  // 2. refs：遍历所有节点
  for (const node of graph.nodesByPath.values()) {
    collectRefs(node, refs);
  }

  // 3. file_stats：filesByType 各类型文件数量
  const fileStats: LineFileStatPayload[] = [];
  for (const key of FILE_TYPE_KEYS) {
    const count = graph.filesByType[key].length;
    fileStats.push({ file_type: key, count });
  }

  return {
    project_id: projectId,
    project_type: graph.projectType,
    nodes,
    children,
    refs,
    file_stats: fileStats,
  };
}

/**
 * 保存线路工程图缓存到 SQLite（Tauri 环境）。
 * 构造 payload 并调用 save_line_gim_graph。
 */
export async function saveLineGraph(projectId: number, graph: GimGraph): Promise<void> {
  const payload = buildLineGraphPayload(projectId, graph);
  await saveLineGraphToDb(payload);
  console.log('[Tauri] 线路工程图已写入 SQLite:', {
    project_id: projectId,
    nodes: payload.nodes.length,
    children: payload.children.length,
    refs: payload.refs.length,
    file_stats: payload.file_stats.length,
  });
}
