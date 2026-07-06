import type { AppState } from '../app/state.js';
import type { CbmNode, FileDevEntry, IfcEntry } from '../gim/types.js';
import type { GimIndexResult } from '../desktop/database.js';
import { buildIfcGuidIndex } from '../gim/gimIndexer.js';
import { buildCbmNodeIndex } from '../gim/cbmParser.js';

/**
 * 从 SQLite 读取的 GIM 索引恢复到 AppState。
 *
 * 恢复内容：
 * - currentFiles = null（缓存命中时不持有原始文件）
 * - currentIfcEntries
 * - cachedIfcPaths
 * - currentCbmTree（从扁平节点重建树形）
 * - ifcGuidIndex / cbmNodeIndex
 * - fileDevRelations
 * - deviceToIfcFile
 * - cachedFamProperties / cachedDevProperties（基础属性缓存）
 */
export function restoreGimIndexToState(state: AppState, index: GimIndexResult): void {
  // 1. currentFiles = null
  state.currentFiles = null;

  // 2. 恢复 currentIfcEntries
  const ifcEntries: IfcEntry[] = index.ifc_models.map((m) => ({
    name: m.name,
    path: m.entry_path,
    modelId: m.model_id,
  }));
  state.currentIfcEntries = ifcEntries;

  // 3. 恢复 cachedIfcPaths
  state.cachedIfcPaths.clear();
  for (const entry of index.entries) {
    if (entry.entry_type === 'IFC' && entry.local_cache_path) {
      state.cachedIfcPaths.set(entry.entry_path, entry.local_cache_path);
    }
  }

  // 4. 恢复 CBM 树
  state.currentCbmTree = rebuildCbmTree(index);

  // 5. 重建索引
  state.ifcGuidIndex = buildIfcGuidIndex(state.currentCbmTree);
  state.cbmNodeIndex = buildCbmNodeIndex(state.currentCbmTree);

  // 6. 恢复 fileDevRelations
  state.fileDevRelations = rebuildFileDevRelations(index);

  // 7. 重建 deviceToIfcFile
  state.deviceToIfcFile.clear();
  for (const entry of state.fileDevRelations) {
    for (const devCbm of entry.deviceCbms) {
      state.deviceToIfcFile.set(devCbm, entry.modelId);
    }
  }

  // 8. 恢复 cachedFamProperties: sourcePath → sectionName → key → value
  state.cachedFamProperties.clear();
  for (const fp of index.fam_properties) {
    let bySection = state.cachedFamProperties.get(fp.source_path);
    if (!bySection) {
      bySection = new Map();
      state.cachedFamProperties.set(fp.source_path, bySection);
    }
    let byKey = bySection.get(fp.section_name);
    if (!byKey) {
      byKey = new Map();
      bySection.set(fp.section_name, byKey);
    }
    if (fp.prop_value) byKey.set(fp.prop_key, fp.prop_value);
  }

  // 9. 恢复 cachedDevProperties: devPath → key → value
  state.cachedDevProperties.clear();
  for (const dp of index.dev_properties) {
    let kv = state.cachedDevProperties.get(dp.dev_path);
    if (!kv) {
      kv = {};
      state.cachedDevProperties.set(dp.dev_path, kv);
    }
    if (dp.prop_value) kv[dp.prop_key] = dp.prop_value;
  }
}

/** 从扁平 cbm_nodes 重建 CbmNode 树 */
function rebuildCbmTree(index: GimIndexResult): CbmNode | null {
  if (index.cbm_nodes.length === 0) return null;

  // 节点 + parent_key + sort_order
  interface NodeWrap {
    node: CbmNode;
    parentKey: string | null;
    sortOrder: number;
  }

  const map = new Map<string, NodeWrap>();
  for (const r of index.cbm_nodes) {
    const node: CbmNode = {
      path: r.path,
      name: r.name,
      entityName: r.entity_name || '',
      children: [],
      famPath: r.fam_path || '',
      devPath: r.dev_path || '',
      ifcFile: r.ifc_file || '',
      ifcGuid: r.ifc_guid || '',
      classifyName: r.classify_name || '',
      transformMatrix: r.transform_matrix || '',
      // 新增字段（缓存恢复场景未持久化，使用默认值）
      systemNames: [],
      devSymbolName: '',
      devType: '',
      devExpanded: false,
    };
    map.set(r.node_key, {
      node,
      parentKey: r.parent_key,
      sortOrder: r.sort_order,
    });
  }

  // 挂载 children
  let rootCandidate: CbmNode | null = null;
  const rootlessNodes: CbmNode[] = [];
  for (const wrap of map.values()) {
    if (wrap.parentKey && map.has(wrap.parentKey)) {
      map.get(wrap.parentKey)!.node.children.push(wrap.node);
    } else {
      // parent_key 为 null 或找不到父节点 → 作为根候选
      rootlessNodes.push(wrap.node);
    }
  }

  // 同级 children 按 sort_order 排序
  for (const wrap of map.values()) {
    wrap.node.children.sort((a, b) => {
      const aWrap = map.get(a.path);
      const bWrap = map.get(b.path);
      return (aWrap?.sortOrder ?? 0) - (bWrap?.sortOrder ?? 0);
    });
  }

  // root 优先 path === 'CBM/project.cbm'
  for (const n of rootlessNodes) {
    if (n.path === 'CBM/project.cbm') {
      rootCandidate = n;
      break;
    }
  }
  if (!rootCandidate && rootlessNodes.length > 0) {
    rootCandidate = rootlessNodes[0];
  }

  return rootCandidate;
}

/** 从扁平 file_dev_entries 重建 FileDevEntry[] */
function rebuildFileDevRelations(index: GimIndexResult): FileDevEntry[] {
  // 按 model_id + ifc_name + ifc_file 分组
  const groupMap = new Map<string, {
    modelId: string;
    ifcName: string;
    ifcFile: string;
    deviceCount: number;
    deviceCbms: { cbm: string; sortOrder: number }[];
  }>();

  for (const r of index.file_dev_entries) {
    const key = `${r.model_id}\u0000${r.ifc_name}\u0000${r.ifc_file}`;
    let g = groupMap.get(key);
    if (!g) {
      g = {
        modelId: r.model_id,
        ifcName: r.ifc_name,
        ifcFile: r.ifc_file,
        deviceCount: r.device_count,
        deviceCbms: [],
      };
      groupMap.set(key, g);
    }
    g.deviceCbms.push({ cbm: r.device_cbm, sortOrder: r.sort_order });
  }

  const result: FileDevEntry[] = [];
  for (const g of groupMap.values()) {
    g.deviceCbms.sort((a, b) => a.sortOrder - b.sortOrder);
    result.push({
      modelId: g.modelId,
      ifcName: g.ifcName,
      ifcFile: g.ifcFile,
      deviceCount: g.deviceCount,
      deviceCbms: g.deviceCbms.map((d) => d.cbm),
    });
  }
  return result;
}
