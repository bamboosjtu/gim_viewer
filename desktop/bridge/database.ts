import type { FileInfo } from './fileReader.js';
import { invokeTimed } from './invokeTimed.js';
import { perfCurrentSession, perfRecordBatchRead } from '../src/utils/perfTimings.js';

const utf8Encoder = new TextEncoder();

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
  return invokeTimed<GimProjectRecord>('upsert_gim_project', { info });
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
  /** 源 GIM 内容身份；后端提交前会与 gim_project.sha256 比较。 */
  source_sha256?: string | null;
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
  await invokeTimed<void>('save_gim_index', { payload });
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
 * 将缓存写入请求封装为 Tauri Raw IPC envelope。
 * 头部：`GIMB` + version(u8) + metadata 长度(u32 LE) + JSON metadata + bytes。
 * 这样大型 IFC/MOD/Fragments 不再经过 JSON 数字数组序列化。
 */
function packBinaryCacheWrite(
  projectId: number,
  entryPath: string,
  bytes: Uint8Array,
  sourceGimSha256?: string,
): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify({
    project_id: projectId,
    entry_path: entryPath,
    ...(sourceGimSha256 ? { source_gim_sha256: sourceGimSha256 } : {}),
  }));
  if (metadata.byteLength > 16 * 1024) throw new Error('缓存写入 metadata 过大');
  const output = new Uint8Array(9 + metadata.byteLength + bytes.byteLength);
  output.set([0x47, 0x49, 0x4d, 0x42, 1], 0); // GIMB + version
  new DataView(output.buffer).setUint32(5, metadata.byteLength, true);
  output.set(metadata, 9);
  output.set(bytes, 9 + metadata.byteLength);
  return output;
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array
    ? value
    : new Uint8Array(value);
}

/**
 * 在 Tauri 环境下写入缓存文件到 app_data_dir/extracted/{projectId}/{entryPath}。
 * 返回本地缓存路径 local_cache_path。
 */
export async function writeCacheFile(projectId: number, entryPath: string, bytes: Uint8Array): Promise<string> {
  return invokeTimed<string>('write_cache_file_binary', packBinaryCacheWrite(projectId, entryPath, bytes));
}

/**
 * 在 Tauri 环境下从缓存读取 IFC 文件（路径由 projectId + entryPath 计算，不接受任意路径）。
 */
export async function readCachedIfc(projectId: number, entryPath: string): Promise<Uint8Array> {
  const bytes = await invokeTimed<ArrayBuffer>('read_cached_ifc', { projectId, entryPath });
  return toUint8Array(bytes);
}

/**
 * 按 GIM entry_path 从 extracted/{projectId} 读取任意缓存条目。
 * 路径由 Rust 侧重新计算并校验，前端不传绝对路径。
 */
export async function readCachedEntry(projectId: number, entryPath: string): Promise<Uint8Array> {
  const bytes = await invokeTimed<ArrayBuffer>('read_cached_entry', { projectId, entryPath });
  return toUint8Array(bytes);
}

/** 批量读取缓存文件的结果项 */
export interface BatchCacheFileItem {
  entry_path: string;
  bytes: Uint8Array | null;
}

/** Rust GIMR v2 envelope 的内部阶段计时。 */
export interface BatchReadRustProfile {
  readMs: number;
  resolveMs: number;
  encodeMs: number;
  totalMs: number;
  bytes: number;
  entryCount: number;
  hitCount: number;
}

/**
 * 批量读取缓存文件（一次 IPC 替代 N 次 read_cached_ifc）。
 * 用于缓存命中时批量加载 DEV/PHM/MOD/STL，避免数千次 IPC。
 */
export async function batchReadCachedFiles(
  projectId: number,
  entryPaths: string[],
): Promise<Map<string, Uint8Array | null>> {
  const perfSession = perfCurrentSession();
  // The request is a small JSON object, but serializing it a second time only
  // to measure IPC would distort the very batch-read timing we are collecting.
  // Account for the known UTF-8 path bytes plus a conservative fixed envelope
  // estimate instead. The response is an ArrayBuffer and is measured exactly
  // by invokeTimed.
  const pathBytes = entryPaths.reduce((sum, path) => sum + utf8Encoder.encode(path).byteLength, 0);
  const requestBytes = pathBytes + entryPaths.length * 6 + String(projectId).length + 32;
  const payload = await invokeTimed<ArrayBuffer>('batch_read_cached_files', {
    projectId,
    entryPaths,
  }, { requestBytes });
  const parsed = parseBatchCachePayload(payload);
  if (parsed.profile) perfRecordBatchRead(parsed.profile, perfSession.id);
  const map = new Map<string, Uint8Array | null>();
  for (const item of parsed.items) {
    map.set(
      item.entry_path,
      item.bytes,
    );
  }
  return map;
}

/**
 * 一次读取 native 线路 semantic pack。响应仍使用 GIMR v2 envelope，
 * 因而 Rust 内部 read/resolve/encode 计时会和普通 batch 统一进入诊断。
 */
export async function readLineSemanticPack(
  projectId: number,
  entryPaths: string[],
): Promise<Map<string, Uint8Array | null>> {
  const perfSession = perfCurrentSession();
  const pathBytes = entryPaths.reduce((sum, path) => sum + utf8Encoder.encode(path).byteLength, 0);
  const requestBytes = pathBytes + entryPaths.length * 6 + String(projectId).length + 32;
  const payload = await invokeTimed<ArrayBuffer>('read_line_semantic_pack', {
    projectId,
    entryPaths,
  }, { requestBytes });
  const parsed = parseBatchCachePayload(payload);
  if (parsed.profile) perfRecordBatchRead(parsed.profile, perfSession.id);
  const map = new Map<string, Uint8Array | null>();
  for (const item of parsed.items) map.set(item.entry_path, item.bytes);
  return map;
}

/** 解析 Rust 批量缓存读取的二进制响应（兼容 GIMR v1/v2）。 */
export function parseBatchCachePayload(value: ArrayBuffer | Uint8Array): {
  items: BatchCacheFileItem[];
  profile?: BatchReadRustProfile;
} {
  const bytes = toUint8Array(value);
  if (bytes.byteLength < 9 || new TextDecoder().decode(bytes.slice(0, 4)) !== 'GIMR' || ![1, 2].includes(bytes[4])) {
    throw new Error('批量缓存读取响应 envelope 无效');
  }
  const version = bytes[4];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(5, true);
  if (count > 200_000) throw new Error('批量缓存读取条目数超限');
  const results: BatchCacheFileItem[] = [];
  let offset = 9;
  let profile: BatchReadRustProfile | undefined;
  if (version === 2) {
    // readMs/resolveMs/encodeMs/totalMs (4 f64) + bytes (u64) +
    // hitCount/missCount (2 u32) = 48 bytes。
    if (bytes.byteLength < offset + 48) throw new Error('批量缓存读取 profile 越界');
    const readMs = view.getFloat64(offset, true); offset += 8;
    const resolveMs = view.getFloat64(offset, true); offset += 8;
    const encodeMs = view.getFloat64(offset, true); offset += 8;
    const totalMs = view.getFloat64(offset, true); offset += 8;
    const totalBytes = view.getBigUint64(offset, true); offset += 8;
    if (totalBytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('批量缓存读取 profile 字节数过大');
    const hitCount = view.getUint32(offset, true); offset += 4;
    // missCount 保留在 envelope 中用于未来完整性检查；业务 Map 不需要读取。
    offset += 4;
    profile = {
      readMs,
      resolveMs,
      encodeMs,
      totalMs,
      bytes: Number(totalBytes),
      entryCount: count,
      hitCount,
    };
  }
  for (let i = 0; i < count; i++) {
    if (offset + 4 > bytes.byteLength) throw new Error('批量缓存读取路径长度越界');
    const pathLen = view.getUint32(offset, true); offset += 4;
    if (pathLen > 4096 || offset + pathLen + 1 + 8 > bytes.byteLength) throw new Error('批量缓存读取路径或长度无效');
    const entryPath = new TextDecoder().decode(bytes.slice(offset, offset + pathLen)); offset += pathLen;
    const present = bytes[offset++] === 1;
    const sizeBig = view.getBigUint64(offset, true); offset += 8;
    if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('批量缓存读取文件过大');
    const size = Number(sizeBig);
    if (offset + size > bytes.byteLength) throw new Error('批量缓存读取数据越界');
    const data = present ? bytes.slice(offset, offset + size) : null;
    offset += size;
    results.push({ entry_path: entryPath, bytes: data });
  }
  if (offset !== bytes.byteLength) throw new Error('批量缓存读取响应存在尾随数据');
  return { items: results, profile };
}

// ===== GLB 几何缓存（方案 C：MOD → glTF 离线预序列化） =====

/**
 * 在 Tauri 环境下写入 GLB 缓存文件（方案 C：序列化后的 glTF 二进制）。
 * 路径由 projectId + entryPath 计算，存储在 app_data_dir/glbcache/{projectId}/ 下。
 */
export async function writeGlbFile(projectId: number, entryPath: string, bytes: Uint8Array): Promise<string> {
  return invokeTimed<string>('write_glb_file_binary', packBinaryCacheWrite(projectId, entryPath, bytes));
}

/**
 * 在 Tauri 环境下读取 GLB 缓存文件。
 *
 * Rust 侧返回 `tauri::ipc::Response`（原始二进制），JS 侧 `invoke` 返回 `ArrayBuffer`，
 * 避免 `Vec<u8>` 经 JSON 序列化为数字数组带来的 3x 体积膨胀和解析开销。
 */
export async function readGlbFile(projectId: number, entryPath: string): Promise<Uint8Array> {
  const buffer = await invokeTimed<ArrayBuffer>('read_glb_file', { projectId, entryPath });
  return new Uint8Array(buffer);
}

/**
 * 方案 C：写入 GLB 几何缓存版本标记文件。
 *
 * 在渐进式几何管线（progressiveGeometryService）完成所有 MOD/STL → .glb
 * 序列化后调用一次，把当前 GEOMETRY_CACHE_VERSION 写入
 * glbcache/{projectId}/_version.txt。
 * 下次 validateGimCache 时读取此文件并比较，版本不匹配则整体失效。
 */
export async function writeGeometryCacheVersion(projectId: number): Promise<string> {
  return invokeTimed<string>('write_geometry_cache_version', { projectId });
}

export interface GeometryCacheManifestEntry {
  entry_path: string;
  size: number;
}

export async function writeGeometryCacheManifest(
  projectId: number,
  sourceSha256: string,
  entries: GeometryCacheManifestEntry[],
): Promise<string> {
  return invokeTimed<string>('write_geometry_cache_manifest', {
    projectId,
    sourceSha256,
    entries,
  });
}

/**
 * 删除指定项目的 GLB 几何缓存目录（仅 glbcache/{projectId}/，不影响 SQLite/IFC/Fragments）。
 *
 * 用于缓存校验失败时清理陈旧 GLB 文件（如 _version.txt 缺失）。
 */
export async function deleteGlbCache(projectId: number): Promise<void> {
  return invokeTimed<void>('delete_glb_cache', { projectId });
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
  phm_color_max_a?: number | null;
  sort_order: number;
}

export interface GeometryRefsPayload {
  project_id: number;
  /** 源 GIM 内容身份；后端提交前会与 gim_project.sha256 比较。 */
  source_sha256?: string | null;
  dev_solid_models: DevSolidModelPayload[];
  dev_sub_devices: DevSubDevicePayload[];
  phm_solid_models: PhmSolidModelPayload[];
}

/** 批量写入 DEV/PHM 几何引用链 */
export async function saveGeometryRefs(payload: GeometryRefsPayload): Promise<void> {
  await invokeTimed('save_geometry_refs', { payload });
}

export interface ReachableGeometry {
  geometry_path: string;
  instance_key: string;
  placement_transform_matrix: string | null;
  dev_transform_matrix: string | null;
  phm_transform_matrix: string | null;
  phm_color: string | null;
  phm_color_max_a: number | null;
}

/** 查询项目中可从 CBM 到达的 MOD/STL 几何源（一次 SQL 查询） */
export async function getReachableGeometry(
  projectId: number,
  options?: { includeMod?: boolean; includeStl?: boolean },
): Promise<ReachableGeometry[]> {
  return invokeTimed<ReachableGeometry[]>('get_reachable_geometry', {
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
  return invokeTimed<GimIndexResult>('get_gim_index', { projectId });
}

/**
 * 校验 GIM 缓存完整性（只读，不修复）。
 */
export async function validateGimCache(projectId: number): Promise<GimCacheValidation> {
  return invokeTimed<GimCacheValidation>('validate_gim_cache', { projectId });
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
  source_gim_sha256: string;
  source_gim_sha256_match: boolean;
  source_ifc_size: number;
  fragment_file_size_stored: number;
  fragment_file_size_actual: number;
  fragment_file_size_match: boolean;
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
  return invokeTimed<string>('get_db_path');
}

/** 获取最近打开项目的缓存诊断 */
export async function getLatestProjectCacheDiagnostic(): Promise<ProjectCacheDiagnostic | null> {
  return invokeTimed<ProjectCacheDiagnostic | null>('get_latest_project_cache_diagnostic');
}

// ==================== Fragments 缓存 ====================


/** Fragments 缓存校验结果 */
export interface FragmentCacheValidation {
  project_id: number;
  entry_path: string;
  has_record: boolean;
  stored_fragments_version: string | null;
  current_fragments_version: string;
  fragments_version_match: boolean;
  source_gim_sha256: string | null;
  source_gim_sha256_match: boolean;
  source_ifc_size_match: boolean;
  fragment_file_exists: boolean;
  fragment_file_size: number;
  fragment_file_size_match: boolean;
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
  sourceGimSha256: string,
): Promise<FragmentCacheWriteResult> {
  return invokeTimed<FragmentCacheWriteResult>(
    'write_fragment_cache_file_binary',
    packBinaryCacheWrite(projectId, entryPath, bytes, sourceGimSha256),
  );
}

/**
 * 读取 Fragments 缓存文件（路径由 projectId + entryPath 计算）。
 */
export async function readFragmentCacheFile(projectId: number, entryPath: string): Promise<Uint8Array> {
  const bytes = await invokeTimed<ArrayBuffer>('read_fragment_cache_file', { projectId, entryPath });
  return toUint8Array(bytes);
}

/**
 * upsert fragment_cache 记录（版本由前端写入包含 Fragments/web-ifc 实际版本的组合键；
 * Rust 侧会再次核对源 GIM SHA）。
 */
export async function upsertFragmentCacheRecord(
  projectId: number,
  entryPath: string,
  modelId: string,
  sourceIfcSize: number,
  fragmentFileSize: number,
  cacheVersion: string,
  sourceGimSha256: string,
): Promise<void> {
  await invokeTimed<void>('upsert_fragment_cache_record', {
    projectId,
    entryPath,
    modelId,
    sourceIfcSize,
    fragmentFileSize,
    cacheVersion,
    sourceGimSha256,
  });
}

/**
 * 校验 Fragments 缓存有效性（只读，不修复）。
 * 检查项：记录存在、版本匹配、源 GIM SHA 匹配、Fragments 文件存在且实际大小
 * 与记录一致（source_ifc_size 仅作辅助诊断）。
 */
export async function validateFragmentCache(
  projectId: number,
  entryPath: string,
  sourceIfcSize: number,
  cacheVersion: string,
  sourceGimSha256: string,
): Promise<FragmentCacheValidation> {
  return invokeTimed<FragmentCacheValidation>('validate_fragment_cache', {
    projectId,
    entryPath,
    sourceIfcSize,
    cacheVersion,
    sourceGimSha256,
  });
}

/**
 * 删除损坏的 Fragments 缓存记录与 .frag 文件（P0-3 自愈）。
 * 加载/校验失败时调用，避免下次打开继续命中坏缓存。
 */
export async function deleteFragmentCacheRecord(
  projectId: number,
  entryPath: string,
): Promise<void> {
  await invokeTimed<void>('delete_fragment_cache_record', { projectId, entryPath });
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
  /** 源 GIM 内容身份；后端 begin 阶段会与 gim_project.sha256 比较。 */
  source_sha256?: string | null;
  nodes: LineCbmNodePayload[];
  children: LineCbmChildPayload[];
  refs: LineCbmRefPayload[];
  file_stats: LineFileStatPayload[];
}

/**
 * 在 Tauri 环境下保存线路工程图缓存（事务：先删后插 + 更新 project_type）。
 */
export async function saveLineGraph(payload: LineGraphPayload): Promise<void> {
  await invokeTimed<void>('save_line_gim_graph', { payload });
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
 * parser_version = PARSER_VERSION（当前 gim-parser-v20）, project_type = transmission_line。
 */
/** 属性分块大小：每批 IPC 传输的记录数（acc-plan P1-2） */
const LINE_ATTR_CHUNK_SIZE = 4000;

/**
 * 分块保存线路工程缓存（图 + FAM/DEV 属性）。
 *
 * 三阶段协议（对应 Rust save_line_graph_begin / save_line_attrs_chunk /
 * save_line_project_finish）：
 * 1. begin：清空旧表 + 写入 graph（4 张表）
 * 2. attrs_chunk × N：每批 ATTR_CHUNK_SIZE 条，fam/dev 同批交错传输
 * 3. finish：写入 parser_version（提交点），缓存生效
 *
 * 中途失败时版本戳未更新 → 缓存判定无效 → 下次打开完整重建。
 *
 * @param onProgress 可选进度回调 (已写入条数, 总条数)
 */
export async function saveLineProjectCache(
  projectId: number,
  graphPayload: LineGraphPayload,
  famProps: LineFamPropertyPayload[],
  devProps: LineDevPropertyPayload[],
  onProgress?: (done: number, total: number) => void,
  sourceSha256?: string | null,
  /** 已由调用方生成 graphPayload JSON 时复用其 UTF-8 字节数，避免再次序列化。 */
  graphPayloadBytes?: number,
): Promise<void> {
  const sessionId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  await invokeTimed<void>('save_line_graph_begin', {
    projectId,
    sessionId,
    graphPayload,
    sourceSha256: sourceSha256 ?? graphPayload.source_sha256 ?? null,
    expectedFamProperties: famProps.length,
    expectedDevProperties: devProps.length,
  }, graphPayloadBytes === undefined ? {} : { requestBytes: graphPayloadBytes });

  const total = famProps.length + devProps.length;
  let done = 0;
  const maxChunks = Math.max(
    Math.ceil(famProps.length / LINE_ATTR_CHUNK_SIZE),
    Math.ceil(devProps.length / LINE_ATTR_CHUNK_SIZE),
    1,
  );
  for (let i = 0; i < maxChunks; i++) {
    const famChunk = famProps.slice(i * LINE_ATTR_CHUNK_SIZE, (i + 1) * LINE_ATTR_CHUNK_SIZE);
    const devChunk = devProps.slice(i * LINE_ATTR_CHUNK_SIZE, (i + 1) * LINE_ATTR_CHUNK_SIZE);
    await invokeTimed<void>('save_line_attrs_chunk', {
      projectId,
      sessionId,
      famProps: famChunk,
      devProps: devChunk,
    });
    done += famChunk.length + devChunk.length;
    onProgress?.(done, total);
  }

  await invokeTimed<void>('save_line_project_finish', { projectId, sessionId });
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
  return invokeTimed<LineGraphResult>('get_line_gim_graph', { projectId });
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
  return invokeTimed<LineAttributeResult>('get_line_attributes', { projectId });
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
  return invokeTimed<CachedProjectSummary[]>('list_cached_projects');
}

/**
 * 删除指定项目的全部缓存（DB 记录 + 磁盘文件）。
 * 返回操作摘要文本。
 */
export async function deleteProjectCache(projectId: number): Promise<string> {
  return invokeTimed<string>('delete_project_cache', { projectId });
}

/**
 * 获取指定项目的缓存诊断（供缓存管理 UI 的"复制诊断"按钮使用）。
 * 返回与 getLatestProjectCacheDiagnostic 相同结构的 ProjectCacheDiagnostic。
 */
export async function getProjectDiagnostic(projectId: number): Promise<ProjectCacheDiagnostic> {
  return invokeTimed<ProjectCacheDiagnostic>('get_project_diagnostic', { projectId });
}
