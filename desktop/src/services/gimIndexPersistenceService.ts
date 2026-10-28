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
} from '@desktop/database.js';
import { inspectSubstationCapabilities } from '../gim/substationEvidence.js';
import { parseFamSectionsWithDiagnostics } from '../gim/famParser.js';

/** 属性文件文本读取并发数（acc-plan P2-3） */
const PARSE_CONCURRENCY = 32;
import { parseKeyValue } from '../gim/cbmParser.js';
import { getFileByPath, normalizeFilePath } from '../gim/fileLookup.js';
import { isGimEmptyValue, resolveBaseFamilyReferences } from '../gim/gimValueSemantics.js';

/** 根据路径判断 entry_type */
function classifyEntryType(path: string): string {
  const normalized = normalizeFilePath(path);
  const lower = normalized.toLowerCase();
  if (lower.endsWith('.ifc')) return 'IFC';
  const top = normalized.split('/')[0]?.toUpperCase() || '';
  // A few exporters may expose a separate GL/ directory; it is still the
  // same XML geometry role as MOD for cache/index purposes.
  if (top === 'CBM' || top === 'DEV' || top === 'PHM' || top === 'MOD') return top;
  if (top === 'GL') return 'MOD';
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
    raw_properties_json: node.rawProperties ? JSON.stringify(node.rawProperties) : null,
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
  if (!isGimEmptyValue(node.famPath)) out.famPaths.add(withEntryPrefix('CBM', node.famPath));
  if (!isGimEmptyValue(node.devPath)) out.devPaths.add(withEntryPrefix('DEV', node.devPath));
  for (const child of node.children) collectFamDevRefs(child, out);
}

/**
 * 从已解析的 CBM 节点原始键值中补充 BASEFAMILY1..N / BASEFAMILYPOINTER 引用。
 *
 * 这些键不在 CbmNode.famPath 的单一主引用里；直接复用树上的 rawProperties，
 * 避免为 1.7 万个 CBM 文件重新读取/解码文本（第二阶段的主要耗时）。
 */
function collectExtraFamRefs(node: CbmNode | null, out: Set<string>): void {
  if (!node) return;
  const props = node.rawProperties;
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (!/^BASEFAMILY(?:POINTER|\d*)$/i.test(key) || isGimEmptyValue(value)) continue;
      out.add(withEntryPrefix('CBM', value));
    }
  }
  for (const child of node.children) collectExtraFamRefs(child, out);
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
/** 工程会话已切换时中止索引构建，避免把旧工程的解析继续跑完。 */
export class IndexBuildCancelledError extends Error {
  constructor() {
    super('索引构建已取消');
    this.name = 'AbortError';
  }
}

/**
 * 解析 CBM/DEV/FAM 属性行（两阶段发布的第二阶段）。
 *
 * 只做属性扫描：CBM 的额外 BASEFAMILY 引用、DEV 键值与 BASEFAMILY、
 * FAM 分节属性。核心阶段不调用它，避免把首屏后的发布窗口拖长。
 */
async function collectSubstationProperties(
  files: Map<string, File>,
  cbmTree: CbmNode | null,
  isCancelled: () => boolean,
): Promise<{ famProperties: FamPropertyPayload[]; devProperties: DevPropertyPayload[] }> {
  const famProperties: FamPropertyPayload[] = [];
  const devProperties: DevPropertyPayload[] = [];

  const refs = { famPaths: new Set<string>(), devPaths: new Set<string>() };
  collectFamDevRefs(cbmTree, refs);

  // CbmNode.famPath intentionally exposes the primary family reference only.
  // Some exporters also keep additional BASEFAMILY1..N fields on grouping
  // nodes; include those persistence references without widening the runtime
  // tree model.  This also handles BASEFAMILYPOINTER when it is not the first
  // value selected for a node.
  if (isCancelled()) throw new IndexBuildCancelledError();
  collectExtraFamRefs(cbmTree, refs.famPaths);

  // 5a. 读取 DEV 文件，解析键值对 → dev_property，同时收集 BASEFAMILY 引用
  const devFamRefs = new Set<string>();
  const devPathsArr = Array.from(refs.devPaths);
  for (let i = 0; i < devPathsArr.length; i += PARSE_CONCURRENCY) {
    if (isCancelled()) throw new IndexBuildCancelledError();
    const chunkPaths = devPathsArr.slice(i, i + PARSE_CONCURRENCY);
    const texts = await Promise.all(
      chunkPaths.map((p) => getFileByPath(files, p)?.text().catch(() => null) ?? Promise.resolve(null)),
    );
    for (let j = 0; j < chunkPaths.length; j++) {
      const text = texts[j];
      if (!text) continue;
      const kv = parseKeyValue(text);
      const devPath = chunkPaths[j];
      for (const [key, val] of Object.entries(kv)) {
        if (!isGimEmptyValue(val)) devProperties.push({ dev_path: devPath, prop_key: key, prop_value: val });
      }
      // 收集 BASEFAMILY / BASEFAMILYPOINTER 引用；空 sentinel 不进入
      // persistence，否则 warm restore 会留下不可点击的伪来源。
      for (const ref of resolveBaseFamilyReferences(kv)) devFamRefs.add(withEntryPrefix('DEV', ref.path));
    }
  }

  // 5b. 合并 FAM 引用：CBM FAM + DEV BASEFAMILY FAM
  for (const p of devFamRefs) refs.famPaths.add(p);

  // 5c. 读取 FAM 文件，解析分节 → fam_property（同样分批并行读取）
  const famPathsArr = Array.from(refs.famPaths);
  for (let i = 0; i < famPathsArr.length; i += PARSE_CONCURRENCY) {
    if (isCancelled()) throw new IndexBuildCancelledError();
    const chunkPaths = famPathsArr.slice(i, i + PARSE_CONCURRENCY);
    const texts = await Promise.all(
      chunkPaths.map((p) => getFileByPath(files, p)?.text().catch(() => null) ?? Promise.resolve(null)),
    );
    for (let j = 0; j < chunkPaths.length; j++) {
      const text = texts[j];
      if (!text) continue;
      const famPath = chunkPaths[j];
      try {
        const parsed = parseFamSectionsWithDiagnostics(text, famPath);
        for (const [sortOrder, property] of parsed.properties.entries()) {
          famProperties.push({ source_path: famPath, section_name: property.section,
            source_line: property.sourceLine,
            prop_key: property.label, prop_value: property.rawValue,
            raw_property_json: JSON.stringify(property), sort_order: sortOrder });
        }
      } catch { continue; }
    }
  }
  return { famProperties, devProperties };
}

export async function buildGimIndexPayload(
  projectId: number,
  files: Map<string, File>,
  ifcEntries: IfcEntry[],
  cbmTree: CbmNode | null,
  fileDevRelations: FileDevEntry[],
  localCachePathMap?: Map<string, string>,
  sourceSha256?: string | null,
  isCurrent?: () => boolean,
  options: { coreOnly?: boolean } = {},
): Promise<GimIndexPayload> {
  const cancelled = (): boolean => Boolean(isCurrent && !isCurrent());
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
    for (let i = 0; i < Math.max(1, entry.deviceCbms.length); i++) {
      fileDevEntries.push({
        source_design_file: entry.sourceDesignFile ?? null,
        model_id: entry.modelId,
        ifc_name: entry.ifcName,
        ifc_file: entry.ifcFile,
        device_count: entry.deviceCount,
        device_cbm: entry.deviceCbms[i] ?? '',
        sort_order: i,
      });
    }
  }

  // 5. FAM/DEV 属性由第二阶段补写；核心阶段先跳过以缩短暖启动窗口。
  let famProperties: FamPropertyPayload[] = [];
  let devProperties: DevPropertyPayload[] = [];
  if (!options.coreOnly) {
    ({ famProperties, devProperties } = await collectSubstationProperties(files, cbmTree, cancelled));
  }

  return {
    capability_summary_json: options.coreOnly
      ? null
      : JSON.stringify(await inspectSubstationCapabilities(files, cbmTree, ifcEntries)),
    project_id: projectId,
    source_sha256: sourceSha256 ?? null,
    entries,
    cbm_nodes: cbmNodes,
    ifc_models: ifcModels,
    file_dev_entries: fileDevEntries,
    fam_properties: famProperties,
    dev_properties: devProperties,
  };
}

function withEntryPrefix(prefix: string, value: string): string {
  const normalized = normalizeFilePath(value.trim());
  return normalized.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
    ? normalized
    : `${prefix}/${normalized}`;
}

/** 两阶段发布第二阶段负载：几何引用 + FAM/DEV 属性 + 能力摘要。 */
export interface SubstationRestPayload {
  project_id: number;
  source_sha256: string | null;
  refs: GeometryRefsPayload;
  fam_properties: FamPropertyPayload[];
  dev_properties: DevPropertyPayload[];
  capability_summary_json: string | null;
}

export async function buildSubstationRestPayload(
  projectId: number,
  files: Map<string, File>,
  cbmTree: CbmNode | null,
  sourceSha256: string | null,
  isCurrent?: () => boolean,
): Promise<SubstationRestPayload> {
  const cancelled = (): boolean => Boolean(isCurrent && !isCurrent());
  const { famProperties, devProperties } = await collectSubstationProperties(files, cbmTree, cancelled);
  if (cancelled()) throw new IndexBuildCancelledError();
  // 几何引用（DEV→SOLIDMODEL→PHM/MOD）与属性解析重复读取同一批 DEV/PHM；在
  // DEV 几何编译并行时会把第二阶段拖到数分钟。这里只补写属性，引用链留空：
  // 暖启动几何仍按源文件解析，语义与属性不缺失，只是少一层 SQL 加速。
  const refs: GeometryRefsPayload = {
    project_id: projectId,
    source_sha256: sourceSha256 ?? null,
    dev_solid_models: [],
    dev_sub_devices: [],
    phm_solid_models: [],
  };
  return {
    project_id: projectId,
    source_sha256: sourceSha256,
    refs,
    fam_properties: famProperties,
    dev_properties: devProperties,
    capability_summary_json: null,
  };
}
