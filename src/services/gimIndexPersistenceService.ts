import type { CbmNode, FileDevEntry, IfcEntry } from '../gim/types.js';
import type { GimIndexPayload, GimEntryPayload, CbmNodePayload, IfcModelPayload, FileDevEntryPayload } from '../desktop/database.js';

/** 根据路径判断 entry_type */
function classifyEntryType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.ifc')) return 'IFC';
  const top = path.split('/')[0]?.toUpperCase() || '';
  if (top === 'CBM' || top === 'DEV' || top === 'PHM' || top === 'MOD') return top;
  return 'OTHER';
}

/** 递归遍历 CBM 树，扁平化为 payload 列表 */
function flattenCbmTree(
  node: CbmNode,
  parentKey: string | null,
  sortOrder: number,
  out: CbmNodePayload[],
): void {
  out.push({
    node_key: node.path,
    parent_key: parentKey,
    path: node.path,
    name: node.name,
    entity_name: node.entityName || null,
    classify_name: node.classifyName || null,
    fam_path: node.famPath || null,
    dev_path: node.devPath || null,
    ifc_file: node.ifcFile || null,
    ifc_guid: node.ifcGuid || null,
    transform_matrix: node.transformMatrix || null,
    sort_order: sortOrder,
  });
  for (let i = 0; i < node.children.length; i++) {
    flattenCbmTree(node.children[i], node.path, i, out);
  }
}

/**
 * 构造 GIM 索引 payload，用于 save_gim_index。
 *
 * @param projectId 数据库 gim_project.id
 * @param files GIM 解压后的文件集合
 * @param ifcEntries 发现的 IFC 文件条目
 * @param cbmTree CBM 层级树根节点（可为 null）
 * @param fileDevRelations FileDevRelation 解析结果
 */
export function buildGimIndexPayload(
  projectId: number,
  files: Map<string, File>,
  ifcEntries: IfcEntry[],
  cbmTree: CbmNode | null,
  fileDevRelations: FileDevEntry[],
): GimIndexPayload {
  // 1. entries
  const entries: GimEntryPayload[] = [];
  for (const [entryPath, file] of files) {
    entries.push({
      entry_path: entryPath,
      file_name: entryPath.split('/').pop() || entryPath,
      entry_type: classifyEntryType(entryPath),
      file_size: file.size,
    });
  }

  // 2. cbm_nodes
  const cbmNodes: CbmNodePayload[] = [];
  if (cbmTree) {
    flattenCbmTree(cbmTree, null, 0, cbmNodes);
  }

  // 3. ifc_models
  const ifcModels: IfcModelPayload[] = ifcEntries.map((e) => ({
    model_id: e.modelId,
    name: e.name,
    entry_path: e.path,
  }));

  // 4. file_dev_entries：每个 deviceCbm 生成一行
  const fileDevEntries: FileDevEntryPayload[] = [];
  for (const entry of fileDevRelations) {
    for (let i = 0; i < entry.deviceCbms.length; i++) {
      fileDevEntries.push({
        model_id: entry.modelId,
        ifc_name: entry.ifcName,
        ifc_file: entry.ifcFile,
        device_count: entry.deviceCount,
        device_cbm: entry.deviceCbms[i],
        sort_order: i,
      });
    }
  }

  return {
    project_id: projectId,
    entries,
    cbm_nodes: cbmNodes,
    ifc_models: ifcModels,
    file_dev_entries: fileDevEntries,
  };
}
