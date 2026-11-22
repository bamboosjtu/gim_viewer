import { DESKTOP_COMMANDS } from './contracts.js';
import type {
  GimProjectRecord,
  GimIndexPayload,
  ProcessMemorySnapshot,
  GeometryRefsPayload,
  GimIndexResult,
  GimCacheValidation,
  ProjectCacheDiagnostic,
  LineGraphPayload,
  LineGraphResult,
  LineAttributeResult,
  CachedProjectSummary,
} from './contracts.js';
export type {
  GimProjectRecord,
  GimEntryPayload,
  CbmNodePayload,
  IfcModelPayload,
  FileDevEntryPayload,
  GimIndexPayload,
  IfcModelRecord,
  CbmNodeRecord,
  ProcessMemorySnapshot,
  DevSolidModelPayload,
  DevSubDevicePayload,
  PhmSolidModelPayload,
  GeometryRefsPayload,
  GimEntryRecord,
  FileDevEntryRecord,
  GimIndexResult,
  GimCacheValidation,
  IfcCacheFileDiagnostic,
  ProjectCacheDiagnostic,
  LineCbmNodePayload,
  LineCbmChildPayload,
  LineCbmRefPayload,
  LineFileStatPayload,
  LineGraphPayload,
  LineCbmNodeRecord,
  LineCbmChildRecord,
  LineCbmRefRecord,
  LineFileStatRecord,
  LineGraphResult,
  LineAttributeResult,
  CachedProjectSummary,
} from './contracts.js';
import type {
  FamPropertyRecord,
  LineFamPropertyPayload,
  LineDevPropertyPayload,
} from './contracts.js';
export type {
  FamPropertyPayload,
  DevPropertyPayload,
  FamPropertyRecord,
  DevPropertyRecord,
  LineFamPropertyPayload,
  LineDevPropertyPayload,
  LineFamPropertyRecord,
  LineDevPropertyRecord,
} from './contracts.js';
import type { FileInfo } from './contracts.js';
import { invokeTimed } from '../src/infrastructure/native/invokeTimed.js';

/** 数据库中的 GIM 项目完整记录 */

/**
 * 在 Tauri 环境下 upsert GIM 项目记录到本地 SQLite。
 * 仅在 Tauri 环境可用，浏览器环境不应调用此函数。
 */
export async function upsertGimProject(info: FileInfo): Promise<GimProjectRecord> {
  return invokeTimed<GimProjectRecord>(DESKTOP_COMMANDS.upsert_gim_project, { info });
}

// ===== GIM 索引入库 =====

/**
 * 在 Tauri 环境下保存 GIM 索引（事务：先删后插）。
 */
export async function saveGimIndex(payload: GimIndexPayload): Promise<void> {
  await invokeTimed<void>(DESKTOP_COMMANDS.save_gim_index, { payload });
}

/**
 * 两阶段发布第二阶段：几何引用 + FAM/DEV 属性。
 * 单事务替换并重算 receipt，成功后置 `substation_properties_complete=1`。
 */
export async function saveSubstationSemanticRest(
  payload: import('./contracts.js').SubstationSemanticRestPayload,
): Promise<void> {
  await invokeTimed<void>(DESKTOP_COMMANDS.save_substation_semantic_rest, { payload });
}

/**
 * 获取 Tauri 后端进程及可测 WebView2 descendant process-tree RSS。
 * processTreeRssBytes 为 null 时必须结合 processTreeAvailable/reason 解读，
 * 不能把后端 rssBytes 当作完整桌面进程树内存。
 */

export async function getProcessMemory(): Promise<ProcessMemorySnapshot> {
  return invokeTimed<ProcessMemorySnapshot>(DESKTOP_COMMANDS.get_process_memory);
}

// ===== 几何引用链（v6） =====

/** 批量写入 DEV/PHM 几何引用链 */
export async function saveGeometryRefs(payload: GeometryRefsPayload): Promise<void> {
  await invokeTimed(DESKTOP_COMMANDS.save_geometry_refs, { payload });
}

// ===== GIM 索引完整读取 + 缓存校验 =====

/**
 * 完整读取 GIM 索引（只读）。
 */
export async function getGimIndex(
  projectId: number,
  includeFamProperties = true,
): Promise<GimIndexResult> {
  return invokeTimed<GimIndexResult>(DESKTOP_COMMANDS.get_gim_index, {
    projectId,
    includeFamProperties,
  });
}

export async function getGimFamProperties(
  projectId: number,
  sourceSha256: string | null,
  sourcePaths: readonly string[],
): Promise<FamPropertyRecord[]> {
  return invokeTimed<FamPropertyRecord[]>(DESKTOP_COMMANDS.get_gim_fam_properties, {
    projectId,
    sourceSha256,
    sourcePaths,
  });
}

/**
 * 校验 GIM 缓存完整性（只读，不修复）。
 */
export async function validateGimCache(
  projectId: number,
  expectedProjectType: 'substation' | 'transmission_line',
): Promise<GimCacheValidation> {
  return invokeTimed<GimCacheValidation>(DESKTOP_COMMANDS.validate_gim_cache, {
    projectId,
    expectedProjectType,
  });
}

// ==================== 诊断 ====================

/** 返回当前 SQLite 文件路径 */
export async function getDbPath(): Promise<string> {
  return invokeTimed<string>(DESKTOP_COMMANDS.get_db_path);
}

/** 获取最近打开项目的缓存诊断 */
export async function getLatestProjectCacheDiagnostic(): Promise<ProjectCacheDiagnostic | null> {
  return invokeTimed<ProjectCacheDiagnostic | null>(
    DESKTOP_COMMANDS.get_latest_project_cache_diagnostic,
  );
}

// ==================== 线路工程图缓存（v4） ====================

/** line_cbm_node 写入 payload（对应 GimGraphNode） */

/** line_cbm_child 写入 payload（父→子关系） */

/** line_cbm_ref 写入 payload（节点引用清单） */

/** line_file_stat 写入 payload（文件类型统计） */

/** 线路工程图完整写入 payload */

// ===== v5: 线路工程 FAM/DEV 属性缓存 =====

/** line_fam_property 写入 payload
 *  FAM 行格式：`中文展示键=ENGLISH_KEY=值`（值可能含 =，前端已 rejoin）
 */

/** line_dev_property 写入 payload（普通 KEY=VALUE） */

/**
 * v5: 在 Tauri 环境下统一保存线路工程缓存（图 + FAM/DEV 属性，单事务）。
 *
 * 生产线路首次导入路径应调用此命令，不得再单独调用 saveLineGraph。
 * 事务内：删除 6 张表旧数据 → 插入 graph + fam + dev → 更新
 * line_parser_version = LINE_PARSER_VERSION（当前 gim-line-parser-v1），同时保留
 * parser_version 作为当前数据库发布标记，project_type = transmission_line。
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
 * 3. finish：写入 line_parser_version（提交点），缓存生效
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
  const sessionId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  await invokeTimed<void>(
    DESKTOP_COMMANDS.save_line_graph_begin,
    {
      projectId,
      sessionId,
      graphPayload,
      sourceSha256: sourceSha256 ?? graphPayload.source_sha256 ?? null,
      expectedFamProperties: famProps.length,
      expectedDevProperties: devProps.length,
    },
    graphPayloadBytes === undefined ? {} : { requestBytes: graphPayloadBytes },
  );

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
    await invokeTimed<void>(DESKTOP_COMMANDS.save_line_attrs_chunk, {
      projectId,
      sessionId,
      famProps: famChunk,
      devProps: devChunk,
    });
    done += famChunk.length + devChunk.length;
    onProgress?.(done, total);
  }

  await invokeTimed<void>(DESKTOP_COMMANDS.save_line_project_finish, { projectId, sessionId });
}

// ===== 线路工程图读取 =====

/** line_cbm_node 读取记录 */

/** line_cbm_child 读取记录 */

/** line_cbm_ref 读取记录 */

/** line_file_stat 读取记录 */

/** 线路工程图完整读取结果 */

/**
 * 完整读取线路工程图缓存（只读）。
 */
export async function getLineGraph(projectId: number): Promise<LineGraphResult> {
  return invokeTimed<LineGraphResult>(DESKTOP_COMMANDS.get_line_gim_graph, { projectId });
}

// ===== v5: 线路工程 FAM/DEV 属性读取 =====

/** line_fam_property 读取记录 */

/** line_dev_property 读取记录 */

/** 线路工程 FAM/DEV 属性读取结果 */

/**
 * v5: 读取线路工程 FAM/DEV 属性缓存（只读）。
 *
 * 二次打开线路 GIM（缓存命中）时调用，配合 getLineGraph 恢复全部状态。
 */
export async function getLineAttributes(projectId: number): Promise<LineAttributeResult> {
  return invokeTimed<LineAttributeResult>(DESKTOP_COMMANDS.get_line_attributes, { projectId });
}

/**
 * 缓存项目摘要（list_cached_projects 返回）。
 */

/**
 * 列出所有缓存的项目（只读，按最近打开排序）。
 * 供缓存管理 UI 使用。
 */
export async function listCachedProjects(): Promise<CachedProjectSummary[]> {
  return invokeTimed<CachedProjectSummary[]>(DESKTOP_COMMANDS.list_cached_projects);
}

/** 读取应用设置（本地 SQLite app_setting 表）。 */
export async function getAppSettings(): Promise<Record<string, string>> {
  return invokeTimed<Record<string, string>>(DESKTOP_COMMANDS.get_app_settings);
}

/** 写入单个应用设置；value 为空字符串表示清除。 */
export async function setAppSetting(key: string, value: string): Promise<void> {
  await invokeTimed<void>(DESKTOP_COMMANDS.set_app_setting, { key, value });
}

/** 打开成功后异步更新最近打开时间。 */
export async function touchGimProjectOpened(projectId: number): Promise<void> {
  await invokeTimed<void>(DESKTOP_COMMANDS.touch_gim_project_opened, { projectId });
}

/**
 * 删除指定项目的全部缓存（DB 记录 + 磁盘文件）。
 * 返回操作摘要文本。
 */
export async function deleteProjectCache(projectId: number): Promise<string> {
  return invokeTimed<string>(DESKTOP_COMMANDS.delete_project_cache, { projectId });
}

/**
 * 获取指定项目的缓存诊断（供缓存管理 UI 的"复制诊断"按钮使用）。
 * 返回与 getLatestProjectCacheDiagnostic 相同结构的 ProjectCacheDiagnostic。
 */
export async function getProjectDiagnostic(projectId: number): Promise<ProjectCacheDiagnostic> {
  return invokeTimed<ProjectCacheDiagnostic>(DESKTOP_COMMANDS.get_project_diagnostic, {
    projectId,
  });
}
