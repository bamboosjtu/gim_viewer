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
  missing_cache_paths: string[];
  stored_parser_version: string | null;
  current_parser_version: string;
  parser_version_match: boolean;
  valid: boolean;
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
