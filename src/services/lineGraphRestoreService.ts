/**
 * 线路工程图缓存恢复服务。
 *
 * 从 SQLite 读取的 LineGraphResult 重建 GimGraph 并写入 AppState。
 * 二次打开同一线路 GIM 时，缓存命中（valid=true）直接调用此服务，
 * 不解压、不重新解析 CBM。
 *
 * 恢复内容：
 * - nodesByPath：从 line_cbm_node 重建（含 rawProps JSON 反序列化）
 * - children：从 line_cbm_child 挂载父子关系（按 sort_order 排序）
 * - root：未被引用为 child 的节点，优先 Cbm/project.cbm / CBM/project.cbm
 * - refs：从 line_cbm_ref 重建（数组字段 + rawRefs）
 * - stats：实体类型计数（遍历节点）+ 文件统计（line_file_stat）
 * - filesByType：缓存命中时不持有原始文件，数组置空，计数从 stats 取
 *
 * 设计参考 gimIndexRestoreService.ts（变电工程索引恢复）。
 */

import type { AppState } from '../app/state.js';
import type { GimGraph, GimGraphNode } from '../gim/gimGraphTypes.js';
import type { GimProjectType } from '../gim/projectType.js';
import type { LineGraphResult } from '../desktop/database.js';

/** 数组型引用字段名集合（ref_kind 命中这些时归类到对应 refs 数组） */
const ARRAY_REF_FIELDS = new Set<string>([
  'cbmFiles',
  'devFiles',
  'famFiles',
  'phmFiles',
  'modFiles',
  'stlFiles',
  'wireFiles',
  'ifcFiles',
]);

/** 创建空的 refs 结构 */
function emptyRefs(): GimGraphNode['refs'] {
  return {
    cbmFiles: [],
    devFiles: [],
    famFiles: [],
    phmFiles: [],
    modFiles: [],
    stlFiles: [],
    wireFiles: [],
    ifcFiles: [],
    rawRefs: {},
  };
}

/**
 * 从 SQLite 读取的线路工程图恢复到 AppState。
 *
 * @param state 应用全局状态
 * @param result get_line_gim_graph 返回结果
 * @returns 重建后的 GimGraph（同时已写入 state.currentGimGraph）
 */
export function restoreLineGraphToState(state: AppState, result: LineGraphResult): GimGraph {
  // 1. 重建 nodesByPath（children / refs 暂为空，后续挂载）
  const nodesByPath = new Map<string, GimGraphNode>();
  for (const r of result.nodes) {
    let rawProps: Record<string, string> = {};
    if (r.raw_props_json) {
      try {
        const parsed = JSON.parse(r.raw_props_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rawProps = parsed as Record<string, string>;
        }
      } catch {
        // raw_props_json 损坏时回退空对象，不阻断恢复
        console.warn('[Restore] line_cbm_node.raw_props_json 解析失败:', r.path);
      }
    }
    const node: GimGraphNode = {
      path: r.path,
      name: r.name || '',
      entityName: r.entity_name || '',
      classifyName: r.classify_name || '',
      rawProps,
      children: [],
      refs: emptyRefs(),
    };
    nodesByPath.set(r.path, node);
  }

  // 2. 挂载 children（按 parent_path 分组，按 sort_order 排序）
  const childrenByParent = new Map<string, { child: GimGraphNode; sortOrder: number }[]>();
  for (const c of result.children) {
    const child = nodesByPath.get(c.child_path);
    if (!child) continue; // 子节点缺失，跳过
    let list = childrenByParent.get(c.parent_path);
    if (!list) {
      list = [];
      childrenByParent.set(c.parent_path, list);
    }
    list.push({ child, sortOrder: c.sort_order ?? 0 });
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  for (const [parentPath, list] of childrenByParent) {
    const parent = nodesByPath.get(parentPath);
    if (parent) {
      for (const { child } of list) parent.children.push(child);
    }
  }

  // 3. 确定 root：未被任何 child 关系引用为 child 的节点
  const childPaths = new Set(result.children.map((c) => c.child_path));
  const rootCandidates: GimGraphNode[] = [];
  for (const node of nodesByPath.values()) {
    if (!childPaths.has(node.path)) rootCandidates.push(node);
  }
  let root: GimGraphNode | null = null;
  // 优先 Cbm/project.cbm 或 CBM/project.cbm（不区分大小写）
  for (const n of rootCandidates) {
    if (n.path.toLowerCase() === 'cbm/project.cbm') {
      root = n;
      break;
    }
  }
  if (!root && rootCandidates.length > 0) root = rootCandidates[0];

  // 4. 重建 refs（按 node_path 分组已由 Rust 排序，此处按 ref_kind 归类）
  for (const ref of result.refs) {
    const node = nodesByPath.get(ref.node_path);
    if (!node) continue;
    if (ref.ref_kind === 'rawRefs') {
      const key = ref.ref_key || '';
      if (!node.refs.rawRefs[key]) node.refs.rawRefs[key] = [];
      node.refs.rawRefs[key].push(ref.ref_value);
    } else if (ARRAY_REF_FIELDS.has(ref.ref_kind)) {
      const arr = node.refs[ref.ref_kind as keyof typeof node.refs] as string[] | undefined;
      if (Array.isArray(arr)) arr.push(ref.ref_value);
    }
    // 未知 ref_kind 忽略（向前兼容）
  }

  // 5. 重建 stats：实体类型计数（遍历节点）+ 文件统计（line_file_stat）
  const stats: Record<string, number> = {
    total: nodesByPath.size,
    F1System: 0,
    F2System: 0,
    F3System: 0,
    F4System: 0,
    Tower_Device: 0,
    Wire_Device: 0,
    WIRE: 0,
    CROSS: 0,
  };
  for (const node of nodesByPath.values()) {
    if (node.entityName && node.entityName in stats) {
      stats[node.entityName]++;
    }
  }
  // 文件统计：file_type 小写 → stats 大写键（CBM/DEV/FAM/PHM/MOD/STL/IFC/OTHER）
  for (const fs of result.file_stats) {
    stats[fs.file_type.toUpperCase()] = fs.count;
  }

  // 6. filesByType：缓存命中时不持有原始文件路径，数组置空；
  //    计数已写入 stats，UI 文件摘要从 stats 读取（参见 lineProjectView.renderLineFileSummary）
  const filesByType: GimGraph['filesByType'] = {
    cbm: [],
    dev: [],
    fam: [],
    phm: [],
    mod: [],
    stl: [],
    ifc: [],
    other: [],
  };

  const projectType: GimProjectType =
    (result.project_type as GimProjectType) || 'transmission_line';

  const graph: GimGraph = {
    projectType,
    root,
    nodesByPath,
    filesByType,
    stats,
  };

  // 写入 AppState
  state.currentGimGraph = graph;
  state.currentProjectType = projectType;
  state.currentFiles = null; // 缓存命中，不持有原始文件

  console.log('[Restore] 线路工程图已从 SQLite 恢复:', {
    project_type: projectType,
    root: root?.path || null,
    totalNodes: stats.total,
    stats,
    refs: result.refs.length,
    children: result.children.length,
  });

  return graph;
}
