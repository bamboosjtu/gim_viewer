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
