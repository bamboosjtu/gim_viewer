use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::fs as stdfs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// GIM 文件元信息（从前端传入，需 Deserialize）
#[derive(Debug, Deserialize)]
pub struct FileInfoInput {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    pub sha256: String,
}

/// 数据库中的完整项目记录
#[derive(Debug, Serialize)]
pub struct GimProjectRecord {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    pub sha256: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_opened_at_ms: u64,
}

/// 应用级数据库连接
pub struct DbState(pub Mutex<Connection>);

/// 获取数据库文件路径：app_data_dir/gim_cache.db
fn db_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    stdfs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("gim_cache.db"))
}

/// 初始化数据库（建表 + 索引）
pub fn init_db(app_handle: &tauri::AppHandle) -> Result<Connection, String> {
    let path = db_path(app_handle)?;
    let conn = Connection::open(&path).map_err(|e| format!("打开数据库失败: {}", e))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS gim_project (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            modified_ms INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            last_opened_at_ms INTEGER NOT NULL,
            UNIQUE(path)
        );
        CREATE INDEX IF NOT EXISTS idx_gim_project_sha256 ON gim_project(sha256);
        CREATE INDEX IF NOT EXISTS idx_gim_project_path ON gim_project(path);

        CREATE TABLE IF NOT EXISTS gim_entry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            entry_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            entry_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, entry_path)
        );
        CREATE INDEX IF NOT EXISTS idx_gim_entry_project ON gim_entry(project_id);
        CREATE INDEX IF NOT EXISTS idx_gim_entry_type ON gim_entry(project_id, entry_type);

        CREATE TABLE IF NOT EXISTS cbm_node (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            node_key TEXT NOT NULL,
            parent_key TEXT,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            entity_name TEXT,
            classify_name TEXT,
            fam_path TEXT,
            dev_path TEXT,
            ifc_file TEXT,
            ifc_guid TEXT,
            transform_matrix TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, node_key)
        );
        CREATE INDEX IF NOT EXISTS idx_cbm_node_project_parent ON cbm_node(project_id, parent_key);
        CREATE INDEX IF NOT EXISTS idx_cbm_node_ifc ON cbm_node(project_id, ifc_file, ifc_guid);

        CREATE TABLE IF NOT EXISTS ifc_model (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            model_id TEXT NOT NULL,
            name TEXT NOT NULL,
            entry_path TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, model_id)
        );
        CREATE INDEX IF NOT EXISTS idx_ifc_model_project ON ifc_model(project_id);

        CREATE TABLE IF NOT EXISTS file_dev_entry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            model_id TEXT NOT NULL,
            ifc_name TEXT NOT NULL,
            ifc_file TEXT NOT NULL,
            device_count INTEGER NOT NULL,
            device_cbm TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_file_dev_project ON file_dev_entry(project_id);
        CREATE INDEX IF NOT EXISTS idx_file_dev_model ON file_dev_entry(project_id, model_id);
        CREATE INDEX IF NOT EXISTS idx_file_dev_device ON file_dev_entry(project_id, device_cbm);",
    )
    .map_err(|e| format!("初始化数据库表失败: {}", e))?;

    // 兼容旧库：给 gim_entry 增加 local_cache_path 列（已存在则忽略）
    let _ = conn.execute("ALTER TABLE gim_entry ADD COLUMN local_cache_path TEXT", []);

    Ok(conn)
}

/// 当前时间戳（毫秒，UNIX_EPOCH 起）
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Tauri command：upsert GIM 项目记录
#[tauri::command]
pub fn upsert_gim_project(
    state: tauri::State<'_, DbState>,
    info: FileInfoInput,
) -> Result<GimProjectRecord, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let now = now_ms();

    // 检查是否已存在
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM gim_project WHERE path = ?1",
            params![info.path],
            |row| row.get(0),
        )
        .ok();

    if let Some(id) = existing {
        // 更新已有记录
        conn.execute(
            "UPDATE gim_project SET name = ?1, size = ?2, modified_ms = ?3, sha256 = ?4, updated_at_ms = ?5, last_opened_at_ms = ?6 WHERE id = ?7",
            params![info.name, info.size, info.modified_ms, info.sha256, now, now, id],
        )
        .map_err(|e| format!("更新项目记录失败: {}", e))?;

        query_record(&conn, id)
    } else {
        // 插入新记录
        conn.execute(
            "INSERT INTO gim_project (path, name, size, modified_ms, sha256, created_at_ms, updated_at_ms, last_opened_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![info.path, info.name, info.size, info.modified_ms, info.sha256, now, now, now],
        )
        .map_err(|e| format!("插入项目记录失败: {}", e))?;

        query_record(&conn, conn.last_insert_rowid())
    }
}

/// 根据 id 查询完整记录
fn query_record(conn: &Connection, id: i64) -> Result<GimProjectRecord, String> {
    conn.query_row(
        "SELECT id, path, name, size, modified_ms, sha256, created_at_ms, updated_at_ms, last_opened_at_ms FROM gim_project WHERE id = ?1",
        params![id],
        row_to_record,
    )
    .map_err(|e| format!("查询项目记录失败: {}", e))
}

/// 从行解析为 GimProjectRecord
fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<GimProjectRecord> {
    Ok(GimProjectRecord {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        size: row.get(3)?,
        modified_ms: row.get(4)?,
        sha256: row.get(5)?,
        created_at_ms: row.get(6)?,
        updated_at_ms: row.get(7)?,
        last_opened_at_ms: row.get(8)?,
    })
}

/// Tauri command：查询最近打开的项目（默认 limit = 20）
#[tauri::command]
pub fn list_gim_projects(
    state: tauri::State<'_, DbState>,
    limit: Option<u32>,
) -> Result<Vec<GimProjectRecord>, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let limit = limit.unwrap_or(20);
    let mut stmt = conn
        .prepare(
            "SELECT id, path, name, size, modified_ms, sha256, created_at_ms, updated_at_ms, last_opened_at_ms
             FROM gim_project
             ORDER BY last_opened_at_ms DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("预处理查询失败: {}", e))?;
    let rows = stmt
        .query_map(params![limit], row_to_record)
        .map_err(|e| format!("查询项目列表失败: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取项目记录失败: {}", e))?);
    }
    Ok(out)
}

/// Tauri command：按 path 查询项目
#[tauri::command]
pub fn get_gim_project_by_path(
    state: tauri::State<'_, DbState>,
    path: String,
) -> Result<Option<GimProjectRecord>, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let res = conn
        .query_row(
            "SELECT id, path, name, size, modified_ms, sha256, created_at_ms, updated_at_ms, last_opened_at_ms
             FROM gim_project
             WHERE path = ?1",
            params![path],
            row_to_record,
        );
    match res {
        Ok(r) => Ok(Some(r)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("按 path 查询失败: {}", e)),
    }
}

/// Tauri command：按 sha256 查询项目（返回数组，同一内容可能在不同路径）
#[tauri::command]
pub fn get_gim_project_by_sha256(
    state: tauri::State<'_, DbState>,
    sha256: String,
) -> Result<Vec<GimProjectRecord>, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, path, name, size, modified_ms, sha256, created_at_ms, updated_at_ms, last_opened_at_ms
             FROM gim_project
             WHERE sha256 = ?1",
        )
        .map_err(|e| format!("预处理查询失败: {}", e))?;
    let rows = stmt
        .query_map(params![sha256], row_to_record)
        .map_err(|e| format!("按 sha256 查询失败: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取项目记录失败: {}", e))?);
    }
    Ok(out)
}

// ===== GIM 索引入库 =====

#[derive(Debug, Deserialize)]
pub struct GimEntryPayload {
    pub entry_path: String,
    pub file_name: String,
    pub entry_type: String,
    pub file_size: u64,
    pub local_cache_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CbmNodePayload {
    pub node_key: String,
    pub parent_key: Option<String>,
    pub path: String,
    pub name: String,
    pub entity_name: Option<String>,
    pub classify_name: Option<String>,
    pub fam_path: Option<String>,
    pub dev_path: Option<String>,
    pub ifc_file: Option<String>,
    pub ifc_guid: Option<String>,
    pub transform_matrix: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Deserialize)]
pub struct IfcModelPayload {
    pub model_id: String,
    pub name: String,
    pub entry_path: String,
}

#[derive(Debug, Deserialize)]
pub struct FileDevEntryPayload {
    pub model_id: String,
    pub ifc_name: String,
    pub ifc_file: String,
    pub device_count: i64,
    pub device_cbm: String,
    pub sort_order: i64,
}

#[derive(Debug, Deserialize)]
pub struct GimIndexPayload {
    pub project_id: i64,
    pub entries: Vec<GimEntryPayload>,
    pub cbm_nodes: Vec<CbmNodePayload>,
    pub ifc_models: Vec<IfcModelPayload>,
    pub file_dev_entries: Vec<FileDevEntryPayload>,
}

/// Tauri command：保存 GIM 索引（事务：先删后插）
#[tauri::command]
pub fn save_gim_index(
    state: tauri::State<'_, DbState>,
    payload: GimIndexPayload,
) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    let pid = payload.project_id;

    // 先删除旧索引
    tx.execute("DELETE FROM gim_entry WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 gim_entry 失败: {}", e))?;
    tx.execute("DELETE FROM cbm_node WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 cbm_node 失败: {}", e))?;
    tx.execute("DELETE FROM ifc_model WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 ifc_model 失败: {}", e))?;
    tx.execute("DELETE FROM file_dev_entry WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 file_dev_entry 失败: {}", e))?;

    // gim_entry
    for e in &payload.entries {
        tx.execute(
            "INSERT INTO gim_entry (project_id, entry_path, file_name, entry_type, file_size, created_at_ms, local_cache_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![pid, e.entry_path, e.file_name, e.entry_type, e.file_size, now, e.local_cache_path],
        )
        .map_err(|e| format!("插入 gim_entry 失败: {}", e))?;
    }

    // cbm_node
    for n in &payload.cbm_nodes {
        tx.execute(
            "INSERT INTO cbm_node (project_id, node_key, parent_key, path, name, entity_name, classify_name, fam_path, dev_path, ifc_file, ifc_guid, transform_matrix, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                pid,
                n.node_key,
                n.parent_key,
                n.path,
                n.name,
                n.entity_name,
                n.classify_name,
                n.fam_path,
                n.dev_path,
                n.ifc_file,
                n.ifc_guid,
                n.transform_matrix,
                n.sort_order,
                now,
            ],
        )
        .map_err(|e| format!("插入 cbm_node 失败: {}", e))?;
    }

    // ifc_model
    for m in &payload.ifc_models {
        tx.execute(
            "INSERT INTO ifc_model (project_id, model_id, name, entry_path, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![pid, m.model_id, m.name, m.entry_path, now],
        )
        .map_err(|e| format!("插入 ifc_model 失败: {}", e))?;
    }

    // file_dev_entry
    for f in &payload.file_dev_entries {
        tx.execute(
            "INSERT INTO file_dev_entry (project_id, model_id, ifc_name, ifc_file, device_count, device_cbm, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![pid, f.model_id, f.ifc_name, f.ifc_file, f.device_count, f.device_cbm, f.sort_order, now],
        )
        .map_err(|e| format!("插入 file_dev_entry 失败: {}", e))?;
    }

    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

// ===== GIM 索引读取 =====

/// 索引统计信息
#[derive(Debug, Serialize)]
pub struct GimIndexStats {
    pub project_id: i64,
    pub entries_count: i64,
    pub cbm_nodes_count: i64,
    pub ifc_models_count: i64,
    pub file_dev_entries_count: i64,
    pub has_index: bool,
}

/// ifc_model 表完整记录
#[derive(Debug, Serialize)]
pub struct IfcModelRecord {
    pub id: i64,
    pub project_id: i64,
    pub model_id: String,
    pub name: String,
    pub entry_path: String,
    pub created_at_ms: u64,
}

/// cbm_node 表完整记录
#[derive(Debug, Serialize)]
pub struct CbmNodeRecord {
    pub id: i64,
    pub project_id: i64,
    pub node_key: String,
    pub parent_key: Option<String>,
    pub path: String,
    pub name: String,
    pub entity_name: Option<String>,
    pub classify_name: Option<String>,
    pub fam_path: Option<String>,
    pub dev_path: Option<String>,
    pub ifc_file: Option<String>,
    pub ifc_guid: Option<String>,
    pub transform_matrix: Option<String>,
    pub sort_order: i64,
    pub created_at_ms: u64,
}

fn count_rows(conn: &Connection, table: &str, project_id: i64) -> Result<i64, String> {
    let sql = format!("SELECT COUNT(*) FROM {} WHERE project_id = ?1", table);
    conn.query_row(&sql, params![project_id], |row| row.get(0))
        .map_err(|e| format!("统计 {} 失败: {}", table, e))
}

/// Tauri command：获取 GIM 索引统计
#[tauri::command]
pub fn get_gim_index_stats(
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<GimIndexStats, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let entries_count = count_rows(&conn, "gim_entry", project_id)?;
    let cbm_nodes_count = count_rows(&conn, "cbm_node", project_id)?;
    let ifc_models_count = count_rows(&conn, "ifc_model", project_id)?;
    let file_dev_entries_count = count_rows(&conn, "file_dev_entry", project_id)?;
    let has_index = cbm_nodes_count > 0 || ifc_models_count > 0;
    Ok(GimIndexStats {
        project_id,
        entries_count,
        cbm_nodes_count,
        ifc_models_count,
        file_dev_entries_count,
        has_index,
    })
}

fn row_to_ifc_model(row: &rusqlite::Row<'_>) -> rusqlite::Result<IfcModelRecord> {
    Ok(IfcModelRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        model_id: row.get(2)?,
        name: row.get(3)?,
        entry_path: row.get(4)?,
        created_at_ms: row.get(5)?,
    })
}

fn row_to_cbm_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<CbmNodeRecord> {
    Ok(CbmNodeRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        node_key: row.get(2)?,
        parent_key: row.get(3)?,
        path: row.get(4)?,
        name: row.get(5)?,
        entity_name: row.get(6)?,
        classify_name: row.get(7)?,
        fam_path: row.get(8)?,
        dev_path: row.get(9)?,
        ifc_file: row.get(10)?,
        ifc_guid: row.get(11)?,
        transform_matrix: row.get(12)?,
        sort_order: row.get(13)?,
        created_at_ms: row.get(14)?,
    })
}

/// Tauri command：列出 ifc_model 表记录
#[tauri::command]
pub fn list_ifc_models(
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<Vec<IfcModelRecord>, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, model_id, name, entry_path, created_at_ms
             FROM ifc_model
             WHERE project_id = ?1",
        )
        .map_err(|e| format!("预处理查询失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_ifc_model)
        .map_err(|e| format!("查询 ifc_model 失败: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取 ifc_model 失败: {}", e))?);
    }
    Ok(out)
}

/// Tauri command：列出 cbm_node 表记录（默认 limit = 50，仅调试用）
#[tauri::command]
pub fn list_cbm_nodes(
    state: tauri::State<'_, DbState>,
    project_id: i64,
    limit: Option<u32>,
) -> Result<Vec<CbmNodeRecord>, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let limit = limit.unwrap_or(50);
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, node_key, parent_key, path, name, entity_name, classify_name, fam_path, dev_path, ifc_file, ifc_guid, transform_matrix, sort_order, created_at_ms
             FROM cbm_node
             WHERE project_id = ?1
             ORDER BY sort_order ASC
             LIMIT ?2",
        )
        .map_err(|e| format!("预处理查询失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id, limit], row_to_cbm_node)
        .map_err(|e| format!("查询 cbm_node 失败: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取 cbm_node 失败: {}", e))?);
    }
    Ok(out)
}

// ===== 缓存文件落盘 =====

use std::io::Write as _;

/// 计算缓存文件路径：app_data_dir/extracted/{project_id}/{entry_path}
/// entry_path 只作为相对路径处理，防止 ../ 穿越
fn cache_file_path(app_handle: &tauri::AppHandle, project_id: i64, entry_path: &str) -> Result<PathBuf, String> {
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    // 规范化 entry_path：去掉前导 / 和 ../
    let safe_rel = entry_path
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".." && *s != ".")
        .collect::<Vec<_>>()
        .join("/");
    if safe_rel.is_empty() {
        return Err("entry_path 无效".to_string());
    }
    let full = base.join("extracted").join(project_id.to_string()).join(&safe_rel);
    // 校验最终路径仍在 base 之下
    let canonical_base = base.canonicalize().unwrap_or(base.clone());
    let parent = full.parent().ok_or("无法获取父目录")?;
    let _ = stdfs::create_dir_all(parent).map_err(|e| format!("创建缓存目录失败: {}", e))?;
    let _ = full.canonicalize().unwrap_or(full.clone());
    if !full.starts_with(&canonical_base) {
        return Err("路径越界".to_string());
    }
    Ok(full)
}

/// Tauri command：写入缓存文件
#[tauri::command]
pub fn write_cache_file(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let path = cache_file_path(&app_handle, project_id, &entry_path)?;
    let mut file = stdfs::File::create(&path).map_err(|e| format!("创建缓存文件失败: {}", e))?;
    file.write_all(&bytes).map_err(|e| format!("写入缓存文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Tauri command：读取缓存文件
#[tauri::command]
pub fn read_cache_file(path: String) -> Result<Vec<u8>, String> {
    stdfs::read(&path).map_err(|e| format!("读取缓存文件失败: {}", e))
}

// ===== GIM 索引完整读取 + 缓存校验 =====

/// gim_entry 表完整记录
#[derive(Debug, Serialize)]
pub struct GimEntryRecord {
    pub id: i64,
    pub project_id: i64,
    pub entry_path: String,
    pub file_name: String,
    pub entry_type: String,
    pub file_size: u64,
    pub local_cache_path: Option<String>,
    pub created_at_ms: u64,
}

/// file_dev_entry 表完整记录
#[derive(Debug, Serialize)]
pub struct FileDevEntryRecord {
    pub id: i64,
    pub project_id: i64,
    pub model_id: String,
    pub ifc_name: String,
    pub ifc_file: String,
    pub device_count: i64,
    pub device_cbm: String,
    pub sort_order: i64,
    pub created_at_ms: u64,
}

/// get_gim_index 返回结构
#[derive(Debug, Serialize)]
pub struct GetGimIndexResult {
    pub entries: Vec<GimEntryRecord>,
    pub cbm_nodes: Vec<CbmNodeRecord>,
    pub ifc_models: Vec<IfcModelRecord>,
    pub file_dev_entries: Vec<FileDevEntryRecord>,
}

/// 缓存校验结果
#[derive(Debug, Serialize)]
pub struct GimCacheValidation {
    pub project_id: i64,
    pub has_index: bool,
    pub ifc_models_count: u64,
    pub ifc_entry_count: u64,
    pub cached_ifc_count: u64,
    pub missing_cache_paths: Vec<String>,
    pub valid: bool,
}

fn row_to_gim_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<GimEntryRecord> {
    Ok(GimEntryRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        entry_path: row.get(2)?,
        file_name: row.get(3)?,
        entry_type: row.get(4)?,
        file_size: row.get(5)?,
        local_cache_path: row.get(6)?,
        created_at_ms: row.get(7)?,
    })
}

fn row_to_file_dev_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileDevEntryRecord> {
    Ok(FileDevEntryRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        model_id: row.get(2)?,
        ifc_name: row.get(3)?,
        ifc_file: row.get(4)?,
        device_count: row.get(5)?,
        device_cbm: row.get(6)?,
        sort_order: row.get(7)?,
        created_at_ms: row.get(8)?,
    })
}

/// Tauri command：完整读取 GIM 索引（只读）
#[tauri::command]
pub fn get_gim_index(
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<GetGimIndexResult, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;

    // 1. gim_entry
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, entry_path, file_name, entry_type, file_size, local_cache_path, created_at_ms
             FROM gim_entry
             WHERE project_id = ?1
             ORDER BY entry_path ASC",
        )
        .map_err(|e| format!("预处理 gim_entry 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_gim_entry)
        .map_err(|e| format!("查询 gim_entry 失败: {}", e))?;
    let mut entries = Vec::new();
    for r in rows {
        entries.push(r.map_err(|e| format!("读取 gim_entry 失败: {}", e))?);
    }

    // 2. cbm_node
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, node_key, parent_key, path, name, entity_name, classify_name, fam_path, dev_path, ifc_file, ifc_guid, transform_matrix, sort_order, created_at_ms
             FROM cbm_node
             WHERE project_id = ?1
             ORDER BY COALESCE(parent_key, ''), sort_order ASC, id ASC",
        )
        .map_err(|e| format!("预处理 cbm_node 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_cbm_node)
        .map_err(|e| format!("查询 cbm_node 失败: {}", e))?;
    let mut cbm_nodes = Vec::new();
    for r in rows {
        cbm_nodes.push(r.map_err(|e| format!("读取 cbm_node 失败: {}", e))?);
    }

    // 3. ifc_model
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, model_id, name, entry_path, created_at_ms
             FROM ifc_model
             WHERE project_id = ?1
             ORDER BY model_id ASC",
        )
        .map_err(|e| format!("预处理 ifc_model 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_ifc_model)
        .map_err(|e| format!("查询 ifc_model 失败: {}", e))?;
    let mut ifc_models = Vec::new();
    for r in rows {
        ifc_models.push(r.map_err(|e| format!("读取 ifc_model 失败: {}", e))?);
    }

    // 4. file_dev_entry
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, model_id, ifc_name, ifc_file, device_count, device_cbm, sort_order, created_at_ms
             FROM file_dev_entry
             WHERE project_id = ?1
             ORDER BY model_id ASC, sort_order ASC, id ASC",
        )
        .map_err(|e| format!("预处理 file_dev_entry 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_file_dev_entry)
        .map_err(|e| format!("查询 file_dev_entry 失败: {}", e))?;
    let mut file_dev_entries = Vec::new();
    for r in rows {
        file_dev_entries.push(r.map_err(|e| format!("读取 file_dev_entry 失败: {}", e))?);
    }

    Ok(GetGimIndexResult {
        entries,
        cbm_nodes,
        ifc_models,
        file_dev_entries,
    })
}

/// Tauri command：校验 GIM 缓存完整性（只读，不修复）
#[tauri::command]
pub fn validate_gim_cache(
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<GimCacheValidation, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;

    let cbm_nodes_count = count_rows(&conn, "cbm_node", project_id)?;
    let ifc_models_count = count_rows(&conn, "ifc_model", project_id)?;
    let has_index = cbm_nodes_count > 0 || ifc_models_count > 0;

    // 查询 entry_type='IFC' 的记录
    let mut stmt = conn
        .prepare(
            "SELECT entry_path, local_cache_path
             FROM gim_entry
             WHERE project_id = ?1 AND entry_type = 'IFC'",
        )
        .map_err(|e| format!("预处理 IFC entry 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("查询 IFC entry 失败: {}", e))?;

    let mut cached_ifc_count: u64 = 0;
    let mut ifc_entry_count: u64 = 0;
    let mut missing_cache_paths: Vec<String> = Vec::new();
    for r in rows {
        let (entry_path, local_cache_path) = r.map_err(|e| format!("读取 IFC entry 失败: {}", e))?;
        ifc_entry_count += 1;
        match local_cache_path {
            Some(p) if !p.is_empty() => {
                if std::path::Path::new(&p).exists() {
                    cached_ifc_count += 1;
                } else {
                    missing_cache_paths.push(entry_path);
                }
            }
            _ => {
                missing_cache_paths.push(entry_path);
            }
        }
    }

    let valid = has_index
        && ifc_models_count > 0
        && ifc_entry_count > 0
        && cached_ifc_count == ifc_entry_count
        && missing_cache_paths.is_empty();

    Ok(GimCacheValidation {
        project_id,
        has_index,
        ifc_models_count: ifc_models_count as u64,
        ifc_entry_count,
        cached_ifc_count,
        missing_cache_paths,
        valid,
    })
}
