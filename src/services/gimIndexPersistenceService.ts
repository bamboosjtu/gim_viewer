import type { CbmNode, FileDevEntry, IfcEntry } from '../gim/types.js';
import type {
  GimIndexPayload,
  GimEntryPayload,
  CbmNodePayload,
  IfcModelPayload,
  FileDevEntryPayload,
  FamPropertyPayload,
  DevPropertyPayload,
  GeometryRefsPayload,
  DevSolidModelPayload,
  DevSubDevicePayload,
  PhmSolidModelPayload,
} from '../desktop/database.js';
import { parseFamSections } from '../gim/famParser.js';
import { parseKeyValue } from '../gim/cbmParser.js';
import { parseDev } from '../gim/geometry/devParser.js';
import { parsePhm } from '../gim/geometry/phmParser.js';

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

/** 递归遍历 CBM 树，收集所有非空的 famPath / devPath 引用 */
function collectFamDevRefs(node: CbmNode | null, out: { famPaths: Set<string>; devPaths: Set<string> }): void {
  if (!node) return;
  if (node.famPath) out.famPaths.add(`CBM/${node.famPath}`);
  if (node.devPath) out.devPaths.add(`DEV/${node.devPath}`);
  for (const child of node.children) collectFamDevRefs(child, out);
}

/**
 * 构造 GIM 索引 payload，用于 save_gim_index。
 *
 * 包含 CBM/FAM/DEV 基础属性缓存（不缓存 IFC 原生属性）：
 * - fam_property：FAM 分节属性（CBM/{famPath} 和 DEV/{BASEFAMILY}）
 * - dev_property：DEV 关键属性（DEV/{devPath} 的全部键值对）
 *
 * @param projectId 数据库 gim_project.id
 * @param files GIM 解压后的文件集合
 * @param ifcEntries 发现的 IFC 文件条目
 * @param cbmTree CBM 层级树根节点（可为 null）
 * @param fileDevRelations FileDevRelation 解析结果
 * @param localCachePathMap IFC 文件的本地缓存路径映射（entry_path -> local_cache_path）
 */
export async function buildGimIndexPayload(
  projectId: number,
  files: Map<string, File>,
  ifcEntries: IfcEntry[],
  cbmTree: CbmNode | null,
  fileDevRelations: FileDevEntry[],
  localCachePathMap?: Map<string, string>,
): Promise<GimIndexPayload> {
  // 1. entries
  const entries: GimEntryPayload[] = [];
  for (const [entryPath, file] of files) {
    entries.push({
      entry_path: entryPath,
      file_name: entryPath.split('/').pop() || entryPath,
      entry_type: classifyEntryType(entryPath),
      file_size: file.size,
      local_cache_path: localCachePathMap?.get(entryPath) ?? null,
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

  // 5. fam_properties + dev_properties：遍历 CBM 树收集引用，读取并解析文件
  const famProperties: FamPropertyPayload[] = [];
  const devProperties: DevPropertyPayload[] = [];

  const refs = { famPaths: new Set<string>(), devPaths: new Set<string>() };
  collectFamDevRefs(cbmTree, refs);

  // 5a. 读取 DEV 文件，解析键值对 → dev_property，同时收集 BASEFAMILY 引用
  const devFamRefs = new Set<string>();
  for (const devPath of refs.devPaths) {
    const f = files.get(devPath);
    if (!f) continue;
    let kv: Record<string, string>;
    try {
      kv = parseKeyValue(await f.text());
    } catch {
      continue;
    }
    for (const [key, val] of Object.entries(kv)) {
      if (val) devProperties.push({ dev_path: devPath, prop_key: key, prop_value: val });
    }
    // 收集 BASEFAMILY 引用
    const baseFamily = kv['BASEFAMILY'];
    if (baseFamily) devFamRefs.add(`DEV/${baseFamily}`);
  }

  // 5b. 合并 FAM 引用：CBM FAM + DEV BASEFAMILY FAM
  for (const p of devFamRefs) refs.famPaths.add(p);

  // 5c. 读取 FAM 文件，解析分节 → fam_property
  for (const famPath of refs.famPaths) {
    const f = files.get(famPath);
    if (!f) continue;
    let sections: Map<string, Map<string, string>>;
    try {
      sections = parseFamSections(await f.text());
    } catch {
      continue;
    }
    let sortOrder = 0;
    for (const [secName, props] of sections) {
      for (const [key, val] of props) {
        if (val) {
          famProperties.push({
            source_path: famPath,
            section_name: secName,
            prop_key: key,
            prop_value: val,
            sort_order: sortOrder,
          });
        }
      }
      sortOrder++;
    }
  }

  return {
    project_id: projectId,
    entries,
    cbm_nodes: cbmNodes,
    ifc_models: ifcModels,
    file_dev_entries: fileDevEntries,
    fam_properties: famProperties,
    dev_properties: devProperties,
  };
}

// ===== 几何引用链索引（v6） =====

/**
 * 构建几何引用链 payload：解析所有 DEV/PHM 文件的 SOLIDMODEL / SUBDEVICE 引用。
 *
 * 设计动机：缓存命中时无需逐文件读取数千个 DEV/PHM，
 * 直接查询 SQLite 即可得到所有可达的 MOD/STL 几何源路径。
 *
 * @param projectId 数据库 gim_project.id
 * @param files GIM 解压后的文件集合
 */
export async function buildGeometryRefsPayload(
  projectId: number,
  files: Map<string, File>,
): Promise<GeometryRefsPayload> {
  const devSolidModels: DevSolidModelPayload[] = [];
  const devSubDevices: DevSubDevicePayload[] = [];
  const phmSolidModels: PhmSolidModelPayload[] = [];

  // 收集所有 DEV 和 PHM 文件
  const devFiles: Array<{ path: string; file: File }> = [];
  const phmFiles: Array<{ path: string; file: File }> = [];

  for (const [entryPath, file] of files) {
    const lower = entryPath.toLowerCase();
    if (lower.startsWith('dev/') && lower.endsWith('.dev')) {
      devFiles.push({ path: entryPath, file });
    } else if (lower.startsWith('phm/') && lower.endsWith('.phm')) {
      phmFiles.push({ path: entryPath, file });
    }
  }

  // 1. 解析 DEV → SOLIDMODEL (→ PHM) + SUBDEVICE (→ child DEV)
  for (const { path, file } of devFiles) {
    try {
      const text = await file.text();
      const doc = parseDev(text, path);

      let smOrder = 0;
      for (const sm of doc.solidModels) {
        devSolidModels.push({
          dev_path: path,
          solid_model_path: sm.solidModelPath,
          transform_matrix: sm.transformMatrix.length === 16
            ? sm.transformMatrix.join(',') : null,
          sort_order: smOrder++,
        });
      }

      let sdOrder = 0;
      for (const sd of doc.subDevices) {
        devSubDevices.push({
          dev_path: path,
          child_dev_path: sd.devPath,
          transform_matrix: sd.transformMatrix.length === 16
            ? sd.transformMatrix.join(',') : null,
          sort_order: sdOrder++,
        });
      }
    } catch (err) {
      console.warn(`[index] DEV 解析失败，跳过: ${path}`, err);
    }
  }

  // 2. 解析 PHM → SOLIDMODEL (→ MOD/STL)
  for (const { path, file } of phmFiles) {
    try {
      const text = await file.text();
      const doc = parsePhm(text, path);

      let smOrder = 0;
      for (const sm of doc.solidModels) {
        phmSolidModels.push({
          phm_path: path,
          solid_model_path: sm.solidModelPath,
          transform_matrix: sm.transformMatrix.length === 16
            ? sm.transformMatrix.join(',') : null,
          color: sm.color
            ? `${sm.color.r},${sm.color.g},${sm.color.b},${sm.color.a}`
            : null,
          sort_order: smOrder++,
        });
      }
    } catch (err) {
      console.warn(`[index] PHM 解析失败，跳过: ${path}`, err);
    }
  }

  return {
    project_id: projectId,
    dev_solid_models: devSolidModels,
    dev_sub_devices: devSubDevices,
    phm_solid_models: phmSolidModels,
  };
}
