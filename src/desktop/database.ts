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

/**
 * 查询最近打开的 GIM 项目列表（默认 limit = 20）。
 */
export async function listGimProjects(limit = 20): Promise<GimProjectRecord[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<GimProjectRecord[]>('list_gim_projects', { limit });
}

/**
 * 按 path 查询 GIM 项目记录，不存在返回 null。
 */
export async function getGimProjectByPath(path: string): Promise<GimProjectRecord | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<GimProjectRecord | null>('get_gim_project_by_path', { path });
}

/**
 * 按 sha256 查询 GIM 项目记录（返回数组，同一内容可能在不同路径）。
 */
export async function getGimProjectsBySha256(sha256: string): Promise<GimProjectRecord[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<GimProjectRecord[]>('get_gim_project_by_sha256', { sha256 });
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

export interface GimIndexPayload {
  project_id: number;
  entries: GimEntryPayload[];
  cbm_nodes: CbmNodePayload[];
  ifc_models: IfcModelPayload[];
  file_dev_entries: FileDevEntryPayload[];
}

/**
 * 在 Tauri 环境下保存 GIM 索引（事务：先删后插）。
 */
export async function saveGimIndex(payload: GimIndexPayload): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke<void>('save_gim_index', { payload });
}

// ===== GIM 索引读取 =====

export interface GimIndexStats {
  project_id: number;
  entries_count: number;
  cbm_nodes_count: number;
  ifc_models_count: number;
  file_dev_entries_count: number;
  has_index: boolean;
}

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

/**
 * 获取 GIM 索引统计信息。
 */
export async function getGimIndexStats(projectId: number): Promise<GimIndexStats> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<GimIndexStats>('get_gim_index_stats', { projectId });
}

/**
 * 列出 ifc_model 表记录。
 */
export async function listIfcModels(projectId: number): Promise<IfcModelRecord[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<IfcModelRecord[]>('list_ifc_models', { projectId });
}

/**
 * 列出 cbm_node 表记录（默认 limit = 50，仅调试用）。
 */
export async function listCbmNodes(projectId: number, limit = 50): Promise<CbmNodeRecord[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<CbmNodeRecord[]>('list_cbm_nodes', { projectId, limit });
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
 * 在 Tauri 环境下从 local_cache_path 读取缓存文件。
 */
export async function readCacheFile(path: string): Promise<Uint8Array> {
  const { invoke } = await import('@tauri-apps/api/core');
  const bytes = await invoke<number[]>('read_cache_file', { path });
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

export interface GimIndexResult {
  entries: GimEntryRecord[];
  cbm_nodes: CbmNodeRecord[];
  ifc_models: IfcModelRecord[];
  file_dev_entries: FileDevEntryRecord[];
}

export interface GimCacheValidation {
  project_id: number;
  has_index: boolean;
  ifc_models_count: number;
  ifc_entry_count: number;
  cached_ifc_count: number;
  missing_cache_paths: string[];
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
