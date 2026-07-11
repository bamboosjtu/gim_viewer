import type { FileInfo } from './fileReader.js';

/** 数据库中的 GIM 项目完整记录 */
export interface GimProjectRecord {
  id: number;
  path: string;
  name: string;
  size: number;
  modified_ms: number;
  sha256: string;
  created_at_ms: number;
  updated_at_ms: number;
  last_opened_at_ms: number;
}

/**
 * 在 Tauri 环境下 upsert GIM 项目记录到本地 SQLite。
 * 仅在 Tauri 环境可用，浏览器环境不应调用此函数。
 */
export async function upsertGimProject(info: FileInfo): Promise<GimProjectRecord> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<GimProjectRecord>('upsert_gim_project', { info });
}

// ===== GIM 索引入库 =====

export interface GimEntryPayload {
  entry_path: string;
  file_name: string;
  entry_type: string;
  file_size: number;
  local_cache_path?: string | null;
}

export interface CbmNodePayload {
  node_key: string;
  parent_key: string | null;
  path: string;
  name: string;
  entity_name: string | null;
  classify_name: string | null;
  fam_path: string | null;
  dev_path: string | null;
  ifc_file: string | null;
  ifc_guid: string | null;
  transform_matrix: string | null;
  sort_order: number;
}

export interface IfcModelPayload {
  model_id: string;
  name: string;
  entry_path: string;
}

export interface FileDevEntryPayload {
  model_id: string;
  ifc_name: string;
  ifc_file: string;
  device_count: number;
  device_cbm: string;
  sort_order: number;
}

export interface FamPropertyPayload {
  source_path: string;
  section_name: string;
  prop_key: string;
  prop_value: string | null;
  sort_order: number;
}

export interface DevPropertyPayload {
  dev_path: string;
  prop_key: string;
  prop_value: string | null;
}

export interface GimIndexPayload {
  project_id: number;
  entries: GimEntryPayload[];
  cbm_nodes: CbmNodePayload[];
  ifc_models: IfcModelPayload[];
  file_dev_entries: FileDevEntryPayload[];
  fam_properties: FamPropertyPayload[];
  dev_properties: DevPropertyPayload[];
}

/**
 * 在 Tauri 环境下保存 GIM 索引（事务：先删后插）。
 */
export async function saveGimIndex(payload: GimIndexPayload): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke<void>('save_gim_index', { payload });
}

// ===== GIM 索引读取 =====

export interface IfcModelRecord {
  id: number;
  project_id: number;
  model_id: string;
  name: string;
  entry_path: string;
  created_at_ms: number;
}

export interface CbmNodeRecord {
  id: number;
  project_id: number;
  node_key: string;
  parent_key: string | null;
  path: string;
  name: string;
  entity_name: string | null;
  classify_name: string | null;
  fam_path: string | null;
  dev_path: string | null;
  ifc_file: string | null;
  ifc_guid: string | null;
  transform_matrix: string | null;
  sort_order: number;
  created_at_ms: number;
}

// ===== 缓存文件落盘 =====

/**
 * 在 Tauri 环境下写入缓存文件到 app_data_dir/extracted/{projectId}/{entryPath}。
 * 返回本地缓存路径 local_cache_path。
 */
export async function writeCacheFile(projectId: number, entryPath: string, bytes: Uint8Array): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('write_cache_file', {
    projectId,
    entryPath,
    bytes: Array.from(bytes),
  });
}

/**
 * 在 Tauri 环境下从缓存读取 IFC 文件（路径由 projectId + entryPath 计算，不接受任意路径）。
 */
export async function readCachedIfc(projectId: number, entryPath: string): Promise<Uint8Array> {
  const { invoke } = await import('@tauri-apps/api/core');
  const bytes = await invoke<number[]>('read_cached_ifc', { projectId, entryPath });
  return new Uint8Array(bytes);
}

/** 批量读取缓存文件的结果项 */
export interface BatchCacheFileItem {
  entry_path: string;
  bytes: number[] | null;
}

/**
 * 批量读取缓存文件（一次 IPC 替代 N 次 read_cached_ifc）。
 * 用于缓存命中时批量加载 DEV/PHM/MOD/STL，避免数千次 IPC。
 */
export async function batchReadCachedFiles(
  projectId: number,
  entryPaths: string[],
): Promise<Map<string, Uint8Array | null>> {
  const { invoke } = await import('@tauri-apps/api/core');
  const results = await invoke<BatchCacheFileItem[]>('batch_read_cached_files', {
    projectId,
    entryPaths,
  });
  const map = new Map<string, Uint8Array | null>();
  for (const item of results) {
    map.set(
      item.entry_path,
      item.bytes ? new Uint8Array(item.bytes) : null,
    );
  }
  return map;
}

// ===== GLB 几何缓存（方案 C：MOD → glTF 离线预序列化） =====

/**
 * 在 Tauri 环境下写入 GLB 缓存文件（方案 C：序列化后的 glTF 二进制）。
 * 路径由 projectId + entryPath 计算，存储在 app_data_dir/glbcache/{projectId}/ 下。
 */
export async function writeGlbFile(projectId: number, entryPath: string, bytes: Uint8Array): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('write_glb_file', {
    projectId,
    entryPath,
    bytes: Array.from(bytes),
  });
}

/**
 * 在 Tauri 环境下读取 GLB 缓存文件。
 *
 * Rust 侧返回 `tauri::ipc::Response`（原始二进制），JS 侧 `invoke` 返回 `ArrayBuffer`，
 * 避免 `Vec<u8>` 经 JSON 序列化为数字数组带来的 3x 体积膨胀和解析开销。
 */
export async function readGlbFile(projectId: number, entryPath: string): Promise<Uint8Array> {
  const { invoke } = await import('@tauri-apps/api/core');
  const buffer = await invoke<ArrayBuffer>('read_glb_file', { projectId, entryPath });
  return new Uint8Array(buffer);
}

/**
 * 检查 GLB 缓存文件是否存在。
 */
export async function glbFileExists(projectId: number, entryPath: string): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('glb_file_exists', { projectId, entryPath });
}

/** 批量读取 GLB 缓存文件的结果项 */
export interface BatchGlbFileItem {
  entry_path: string;
  bytes: number[] | null;
}

/**
 * 批量读取 GLB 缓存文件（一次 IPC 替代 N 次 readGlbFile）。
 * 用于缓存命中时批量加载序列化几何，避免数千次 IPC 往返。
 */
export async function batchReadGlbFiles(
  projectId: number,
  entryPaths: string[],
): Promise<Map<string, Uint8Array | null>> {
  const { invoke } = await import('@tauri-apps/api/core');
  const results = await invoke<BatchGlbFileItem[]>('batch_read_glb_files', {
    projectId,
    entryPaths,
  });
  const map = new Map<string, Uint8Array | null>();
  for (const item of results) {
    map.set(
      item.entry_path,
      item.bytes ? new Uint8Array(item.bytes) : null,
    );
  }
  return map;
}

/**
 * 方案 C：写入 GLB 几何缓存版本标记文件。
 *
 * 在 cacheGlbFiles 完成所有 MOD/STL → .glb 序列化后调用一次，
 * 把当前 GEOMETRY_CACHE_VERSION 写入 glbcache/{projectId}/_version.txt。
 * 下次 validateGimCache 时读取此文件并比较，版本不匹配则整体失效。
 */
export async function writeGeometryCacheVersion(projectId: number): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('write_geometry_cache_version', { projectId });
}

/**
 * 删除指定项目的 GLB 几何缓存目录（仅 glbcache/{projectId}/，不影响 SQLite/IFC/Fragments）。
 *
 * 用于缓存校验失败时清理陈旧 GLB 文件（如 _version.txt 缺失）。
 */
export async function deleteGlbCache(projectId: number): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<void>('delete_glb_cache', { projectId });
}

// ===== 几何引用链（v6） =====

export interface DevSolidModelPayload {
  dev_path: string;
  solid_model_path: string;
  transform_matrix: string | null;
  sort_order: number;
}

export interface DevSubDevicePayload {
  dev_path: string;
  child_dev_path: string;
  transform_matrix: string | null;
  sort_order: number;
}

export interface PhmSolidModelPayload {
  phm_path: string;
  solid_model_path: string;
  transform_matrix: string | null;
  color: string | null;
  sort_order: number;
}

export interface GeometryRefsPayload {
  project_id: number;
  dev_solid_models: DevSolidModelPayload[];
  dev_sub_devices: DevSubDevicePayload[];
  phm_solid_models: PhmSolidModelPayload[];
}

/** 批量写入 DEV/PHM 几何引用链 */
export async function saveGeometryRefs(payload: GeometryRefsPayload): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('save_geometry_refs', { payload });
}

export interface ReachableGeometry {
  geometry_path: string;
  instance_key: string;
  placement_transform_matrix: string | null;
  dev_transform_matrix: string | null;
  phm_transform_matrix: string | null;
  phm_color: string | null;
}

/** 查询项目中可从 CBM 到达的 MOD/STL 几何源（一次 SQL 查询） */
export async function getReachableGeometry(
  projectId: number,
  options?: { includeMod?: boolean; includeStl?: boolean },
): Promise<ReachableGeometry[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ReachableGeometry[]>('get_reachable_geometry', {
    projectId,
    includeMod: options?.includeMod ?? true,
    includeStl: options?.includeStl ?? false,
  });
}

// ===== GIM 索引完整读取 + 缓存校验 =====

export interface GimEntryRecord {
  id: number;
  project_id: number;
  entry_path: string;
  file_name: string;
  entry_type: string;
  file_size: number;
  local_cache_path: string | null;
  created_at_ms: number;
}

export interface FileDevEntryRecord {
  id: number;
  project_id: number;
  model_id: string;
  ifc_name: string;
  ifc_file: string;
  device_count: number;
  device_cbm: string;
  sort_order: number;
  created_at_ms: number;
}

export interface FamPropertyRecord {
  id: number;
  project_id: number;
  source_path: string;
  section_name: string;
  prop_key: string;
  prop_value: string | null;
  sort_order: number;
  created_at_ms: number;
}

export interface DevPropertyRecord {
  id: number;
  project_id: number;
  dev_path: string;
  prop_key: string;
  prop_value: string | null;
  created_at_ms: number;
}

export interface GimIndexResult {
  entries: GimEntryRecord[];
  cbm_nodes: CbmNodeRecord[];
  ifc_models: IfcModelRecord[];
  file_dev_entries: FileDevEntryRecord[];
  fam_properties: FamPropertyRecord[];
  dev_properties: DevPropertyRecord[];
}

export interface GimCacheValidation {
  project_id: number;
  has_index: boolean;
  ifc_models_count: number;
  ifc_entry_count: number;
  cached_ifc_count: number;
  cbm_nodes_count: number;
  file_dev_entries_count: number;
  missing_cache_paths: string[];
  stored_parser_version: string | null;
  current_parser_version: string;
  parser_version_match: boolean;
  valid: boolean;
  /** v4: 工程类型（substation / transmission_line / hybrid / unknown），决定缓存校验分支 */
  project_type: string | null;
  /** v4: line_cbm_node 表行数（transmission_line 缓存校验用） */
  line_cbm_node_count: number;
  /** v5: line_fam_property 不同 file_name_lower 的去重数量 */
  line_fam_source_count: number;
  /** v5: line_dev_property 不同 file_name_lower 的去重数量 */
  line_dev_source_count: number;
  /** v5: line_cbm_ref 中 ref_kind=famFiles 的 file_name_lower 去重数量 */
  line_expected_fam_ref_count: number;
  /** v5: line_cbm_ref 中 ref_kind=devFiles 的 file_name_lower 去重数量 */
  line_expected_dev_ref_count: number;
  /** v5: 图引用中存在但 line_fam_property 缺失的 file_name_lower 列表 */
  missing_line_fam_sources: string[];
  /** v5: 图引用中存在但 line_dev_property 缺失的 file_name_lower 列表 */
  missing_line_dev_sources: string[];
  /** v6（方案 C）: GLB 几何缓存版本是否匹配（读取 glbcache/{projectId}/_version.txt 比较） */
  geometry_cache_version_match: boolean;
  /** v6（方案 C）: 当前 GEOMETRY_CACHE_VERSION（供前端诊断显示） */
  current_geometry_cache_version: string;
}

/**
 * 完整读取 GIM 索引（只读）。
 */
export async function getGimIndex(projectId: number): Promise<GimIndexResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<GimIndexResult>('get_gim_index', { projectId });
}

/**
 * 校验 GIM 缓存完整性（只读，不修复）。
 */
export async function validateGimCache(projectId: number): Promise<GimCacheValidation> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<GimCacheValidation>('validate_gim_cache', { projectId });
}

// ==================== 诊断 ====================

export interface IfcCacheFileDiagnostic {
  entry_path: string;
  local_cache_path: string | null;
  exists: boolean;
  file_size: number | null;
}

export interface FragmentCacheFileDiagnostic {
  entry_path: string;
  model_id: string;
  source_ifc_size: number;
  fragment_file_size_stored: number;
  fragment_file_size_actual: number;
  stored_fragments_version: string;
  current_fragments_cache_version: string;
  fragments_version_match: boolean;
  fragment_file_exists: boolean;
  valid: boolean;
}

export interface ProjectCacheDiagnostic {
  project_id: number;
  path: string;
  name: string;
  size: number;
  modified_ms: number;
  sha256: string;

  entries_count: number;
  cbm_nodes_count: number;
  ifc_models_count: number;
  file_dev_entries_count: number;
  fam_properties_count: number;
  dev_properties_count: number;

  ifc_entry_count: number;
  cached_ifc_count: number;
  missing_cache_paths: string[];
  stored_parser_version: string | null;
  current_parser_version: string;
  parser_version_match: boolean;
  valid: boolean;

  ifc_cache_files: IfcCacheFileDiagnostic[];

  // Fragments 缓存诊断
  fragment_cache_count: number;
  valid_fragment_cache_count: number;
  missing_fragment_cache_paths: string[];
  current_fragments_cache_version: string;
  fragment_cache_files: FragmentCacheFileDiagnostic[];

  // v4: 线路工程图缓存诊断
  project_type: string | null;
  line_cbm_node_count: number;
  line_cbm_child_count: number;
  line_cbm_ref_count: number;
  line_file_stat_count: number;

  // v5: 线路工程 FAM/DEV 属性缓存诊断
  line_fam_property_count: number;
  line_dev_property_count: number;
  line_fam_source_count: number;
  line_dev_source_count: number;
  line_expected_fam_ref_count: number;
  line_expected_dev_ref_count: number;
  missing_line_fam_sources: string[];
  missing_line_dev_sources: string[];
}

/** 返回当前 SQLite 文件路径 */
export async function getDbPath(): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('get_db_path');
}

/** 获取最近打开项目的缓存诊断 */
export async function getLatestProjectCacheDiagnostic(): Promise<ProjectCacheDiagnostic | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ProjectCacheDiagnostic | null>('get_latest_project_cache_diagnostic');
}

// ==================== Fragments 缓存 ====================

/** fragment_cache 表记录 */
export interface FragmentCacheRecord {
  id: number;
  project_id: number;
  entry_path: string;
  model_id: string;
  source_ifc_size: number;
  fragment_file_size: number;
  fragments_version: string;
  created_at_ms: number;
  updated_at_ms: number;
}

/** Fragments 缓存校验结果 */
export interface FragmentCacheValidation {
  project_id: number;
  entry_path: string;
  has_record: boolean;
  stored_fragments_version: string | null;
  current_fragments_version: string;
  fragments_version_match: boolean;
  source_ifc_size_match: boolean;
  fragment_file_exists: boolean;
  fragment_file_size: number;
  valid: boolean;
}

/** 写入 Fragments 缓存文件的结果 */
export interface FragmentCacheWriteResult {
  path: string;
  size: number;
}

/**
 * 写入 Fragments 缓存文件到 app_data_dir/fragments/{projectId}/{entryPath}.frag。
 * 路径由 Rust 侧根据 project_id + entry_path 计算，不接受前端传入的绝对路径。
 */
export async function writeFragmentCacheFile(
  projectId: number,
  entryPath: string,
  bytes: Uint8Array,
): Promise<FragmentCacheWriteResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<FragmentCacheWriteResult>('write_fragment_cache_file', {
    projectId,
    entryPath,
    bytes: Array.from(bytes),
  });
}

/**
 * 读取 Fragments 缓存文件（路径由 projectId + entryPath 计算）。
 */
export async function readFragmentCacheFile(projectId: number, entryPath: string): Promise<Uint8Array> {
  const { invoke } = await import('@tauri-apps/api/core');
  const bytes = await invoke<number[]>('read_fragment_cache_file', { projectId, entryPath });
  return new Uint8Array(bytes);
}

/**
 * upsert fragment_cache 记录（版本由 Rust 侧写入当前 FRAGMENTS_CACHE_VERSION）。
 */
export async function upsertFragmentCacheRecord(
  projectId: number,
  entryPath: string,
  modelId: string,
  sourceIfcSize: number,
  fragmentFileSize: number,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke<void>('upsert_fragment_cache_record', {
    projectId,
    entryPath,
    modelId,
    sourceIfcSize,
    fragmentFileSize,
  });
}

/**
 * 校验 Fragments 缓存有效性（只读，不修复）。
 * 检查项：记录存在、版本匹配、source_ifc_size 匹配、fragments 文件存在且大小 > 0。
 */
export async function validateFragmentCache(
  projectId: number,
  entryPath: string,
  sourceIfcSize: number,
): Promise<FragmentCacheValidation> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<FragmentCacheValidation>('validate_fragment_cache', {
    projectId,
    entryPath,
    sourceIfcSize,
  });
}

// ==================== 线路工程图缓存（v4） ====================

/** line_cbm_node 写入 payload（对应 GimGraphNode） */
export interface LineCbmNodePayload {
  path: string;
  name: string | null;
  entity_name: string | null;
  classify_name: string | null;
  raw_props_json: string;
  sort_order: number | null;
}

/** line_cbm_child 写入 payload（父→子关系） */
export interface LineCbmChildPayload {
  parent_path: string;
  child_path: string;
  sort_order: number | null;
  ref_type: string;
  extra: string | null;
}

/** line_cbm_ref 写入 payload（节点引用清单） */
export interface LineCbmRefPayload {
  node_path: string;
  ref_kind: string;
  ref_key: string | null;
  ref_value: string;
  sort_order: number | null;
  /** v5: 归一化后的引用值（路径统一为 / 分隔，去空段），仅作存储与排查用途 */
  normalized_ref_value: string | null;
  /** v5: 引用值的文件名小写（如 "x.fam"），诊断时以此键空间匹配 FAM/DEV 文件 */
  file_name_lower: string | null;
}

/** line_file_stat 写入 payload（文件类型统计） */
export interface LineFileStatPayload {
  file_type: string;
  count: number;
}

/** 线路工程图完整写入 payload */
export interface LineGraphPayload {
  project_id: number;
  project_type: string;
  nodes: LineCbmNodePayload[];
  children: LineCbmChildPayload[];
  refs: LineCbmRefPayload[];
  file_stats: LineFileStatPayload[];
}

/**
 * 在 Tauri 环境下保存线路工程图缓存（事务：先删后插 + 更新 project_type）。
 */
export async function saveLineGraph(payload: LineGraphPayload): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke<void>('save_line_gim_graph', { payload });
}

// ===== v5: 线路工程 FAM/DEV 属性缓存 =====

/** line_fam_property 写入 payload
 *  FAM 行格式：`中文展示键=ENGLISH_KEY=值`（值可能含 =，前端已 rejoin）
 */
export interface LineFamPropertyPayload {
  source_path: string;
  normalized_path: string;
  file_name_lower: string;
  display_key: string | null;
  prop_key: string;
  prop_value: string | null;
  raw_line: string | null;
  sort_order: number;
}

/** line_dev_property 写入 payload（普通 KEY=VALUE） */
export interface LineDevPropertyPayload {
  source_path: string;
  normalized_path: string;
  file_name_lower: string;
  prop_key: string;
  prop_value: string | null;
  raw_line: string | null;
  sort_order: number;
}

/**
 * v5: 在 Tauri 环境下统一保存线路工程缓存（图 + FAM/DEV 属性，单事务）。
 *
 * 生产线路首次导入路径应调用此命令，不得再单独调用 saveLineGraph。
 * 事务内：删除 6 张表旧数据 → 插入 graph + fam + dev → 更新
 * parser_version = PARSER_VERSION（当前 gim-parser-v13）, project_type = transmission_line。
 */
export async function saveLineProjectCache(
  projectId: number,
  graphPayload: LineGraphPayload,
  famProps: LineFamPropertyPayload[],
  devProps: LineDevPropertyPayload[],
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke<void>('save_line_project_cache', {
    projectId,
    graphPayload,
    famProps,
    devProps,
  });
}

// ===== 线路工程图读取 =====

/** line_cbm_node 读取记录 */
export interface LineCbmNodeRecord {
  path: string;
  name: string | null;
  entity_name: string | null;
  classify_name: string | null;
  raw_props_json: string;
  sort_order: number | null;
}

/** line_cbm_child 读取记录 */
export interface LineCbmChildRecord {
  parent_path: string;
  child_path: string;
  sort_order: number | null;
  ref_type: string;
  extra: string | null;
}

/** line_cbm_ref 读取记录 */
export interface LineCbmRefRecord {
  node_path: string;
  ref_kind: string;
  ref_key: string | null;
  ref_value: string;
  sort_order: number | null;
  /** v5: 归一化后的引用值 */
  normalized_ref_value: string | null;
  /** v5: 引用值的文件名小写 */
  file_name_lower: string | null;
}

/** line_file_stat 读取记录 */
export interface LineFileStatRecord {
  file_type: string;
  count: number;
}

/** 线路工程图完整读取结果 */
export interface LineGraphResult {
  project_type: string | null;
  nodes: LineCbmNodeRecord[];
  children: LineCbmChildRecord[];
  refs: LineCbmRefRecord[];
  file_stats: LineFileStatRecord[];
}

/**
 * 完整读取线路工程图缓存（只读）。
 */
export async function getLineGraph(projectId: number): Promise<LineGraphResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<LineGraphResult>('get_line_gim_graph', { projectId });
}

// ===== v5: 线路工程 FAM/DEV 属性读取 =====

/** line_fam_property 读取记录 */
export interface LineFamPropertyRecord {
  source_path: string;
  normalized_path: string;
  file_name_lower: string;
  display_key: string | null;
  prop_key: string;
  prop_value: string | null;
  raw_line: string | null;
  sort_order: number;
}

/** line_dev_property 读取记录 */
export interface LineDevPropertyRecord {
  source_path: string;
  normalized_path: string;
  file_name_lower: string;
  prop_key: string;
  prop_value: string | null;
  raw_line: string | null;
  sort_order: number;
}

/** 线路工程 FAM/DEV 属性读取结果 */
export interface LineAttributeResult {
  fam_properties: LineFamPropertyRecord[];
  dev_properties: LineDevPropertyRecord[];
}

/**
 * v5: 读取线路工程 FAM/DEV 属性缓存（只读）。
 *
 * 二次打开线路 GIM（缓存命中）时调用，配合 getLineGraph 恢复全部状态。
 */
export async function getLineAttributes(projectId: number): Promise<LineAttributeResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<LineAttributeResult>('get_line_attributes', { projectId });
}

/**
 * 缓存项目摘要（list_cached_projects 返回）。
 */
export interface CachedProjectSummary {
  id: number;
  name: string;
  path: string;
  project_type: string | null;
  parser_version: string | null;
  size: number;
  modified_ms: number;
  updated_at_ms: number;
}

/**
 * 列出所有缓存的项目（只读，按最近打开排序）。
 * 供缓存管理 UI 使用。
 */
export async function listCachedProjects(): Promise<CachedProjectSummary[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<CachedProjectSummary[]>('list_cached_projects');
}

/**
 * 删除指定项目的全部缓存（DB 记录 + 磁盘文件）。
 * 返回操作摘要文本。
 */
export async function deleteProjectCache(projectId: number): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('delete_project_cache', { projectId });
}

/**
 * 获取指定项目的缓存诊断（供缓存管理 UI 的"复制诊断"按钮使用）。
 * 返回与 getLatestProjectCacheDiagnostic 相同结构的 ProjectCacheDiagnostic。
 */
export async function getProjectDiagnostic(projectId: number): Promise<ProjectCacheDiagnostic> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ProjectCacheDiagnostic>('get_project_diagnostic', { projectId });
}
