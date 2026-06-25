use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::fs as stdfs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

/// 当前解析器版本（变更解析逻辑时递增，用于缓存失效）
/// v2: 增加 fam_property / dev_property 表，缓存 CBM/FAM/DEV 基础属性
/// v3: validate cache requires cbm_node index; rebuild incomplete v2 cache
/// v4: adds transmission_line graph cache (line_cbm_node/child/ref/file_stat)
pub const PARSER_VERSION: &str = "gim-parser-v4";

/// Fragments 缓存版本（独立于 GIM parser_version，变更缓存格式时递增）
/// v2: 修复旧 v1 缓存可能加载不全的问题，强制失效重建
pub const FRAGMENTS_CACHE_VERSION: &str = "fragments-cache-v2";

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
        CREATE INDEX IF NOT EXISTS idx_file_dev_device ON file_dev_entry(project_id, device_cbm);

        CREATE TABLE IF NOT EXISTS fam_property (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            source_path TEXT NOT NULL,
            section_name TEXT NOT NULL,
            prop_key TEXT NOT NULL,
            prop_value TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, source_path, section_name, prop_key)
        );
        CREATE INDEX IF NOT EXISTS idx_fam_property_source ON fam_property(project_id, source_path);

        CREATE TABLE IF NOT EXISTS dev_property (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            dev_path TEXT NOT NULL,
            prop_key TEXT NOT NULL,
            prop_value TEXT,
            created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, dev_path, prop_key)
        );
        CREATE INDEX IF NOT EXISTS idx_dev_property_path ON dev_property(project_id, dev_path);

        CREATE TABLE IF NOT EXISTS fragment_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            entry_path TEXT NOT NULL,
            model_id TEXT NOT NULL,
            source_ifc_size INTEGER NOT NULL,
            fragment_file_size INTEGER NOT NULL,
            fragments_version TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, entry_path)
        );
        CREATE INDEX IF NOT EXISTS idx_fragment_cache_project ON fragment_cache(project_id);
        CREATE INDEX IF NOT EXISTS idx_fragment_cache_entry ON fragment_cache(project_id, entry_path);",
    )
    .map_err(|e| format!("初始化数据库表失败: {}", e))?;

    // 兼容旧库：给 gim_entry 增加 local_cache_path 列（已存在则忽略）
    let _ = conn.execute("ALTER TABLE gim_entry ADD COLUMN local_cache_path TEXT", []);

    // 兼容旧库：给 gim_project 增加 parser_version 列（已存在则忽略）
    let _ = conn.execute("ALTER TABLE gim_project ADD COLUMN parser_version TEXT", []);

    // v4: 给 gim_project 增加 project_type 列（substation / transmission_line / hybrid / unknown）
    let _ = conn.execute("ALTER TABLE gim_project ADD COLUMN project_type TEXT", []);

    // v4: 线路工程图缓存表
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS line_cbm_node (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            path TEXT NOT NULL,
            name TEXT,
            entity_name TEXT,
            classify_name TEXT,
            raw_props_json TEXT NOT NULL,
            sort_order INTEGER,
            created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_line_cbm_node_project ON line_cbm_node(project_id);

        CREATE TABLE IF NOT EXISTS line_cbm_child (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            parent_path TEXT NOT NULL,
            child_path TEXT NOT NULL,
            sort_order INTEGER,
            ref_type TEXT NOT NULL,
            extra TEXT,
            created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, parent_path, child_path, ref_type)
        );
        CREATE INDEX IF NOT EXISTS idx_line_cbm_child_parent ON line_cbm_child(project_id, parent_path);

        CREATE TABLE IF NOT EXISTS line_cbm_ref (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            node_path TEXT NOT NULL,
            ref_kind TEXT NOT NULL,
            ref_key TEXT,
            ref_value TEXT NOT NULL,
            sort_order INTEGER,
            created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_line_cbm_ref_node ON line_cbm_ref(project_id, node_path);

        CREATE TABLE IF NOT EXISTS line_file_stat (
            project_id INTEGER NOT NULL,
            file_type TEXT NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY(project_id, file_type)
        );",
    )
    .map_err(|e| format!("初始化线路工程缓存表失败: {}", e))?;

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
        // 更新已有记录（不更新 parser_version —— 它只表示已持久化索引的版本，由 save_gim_index 维护）
        conn.execute(
            "UPDATE gim_project SET name = ?1, size = ?2, modified_ms = ?3, sha256 = ?4, updated_at_ms = ?5, last_opened_at_ms = ?6 WHERE id = ?7",
            params![info.name, info.size, info.modified_ms, info.sha256, now, now, id],
        )
        .map_err(|e| format!("更新项目记录失败: {}", e))?;

        query_record(&conn, id)
    } else {
        // 插入新记录（parser_version = NULL，表示尚无索引）
        conn.execute(
            "INSERT INTO gim_project (path, name, size, modified_ms, sha256, parser_version, created_at_ms, updated_at_ms, last_opened_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8)",
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
pub struct FamPropertyPayload {
    pub source_path: String,
    pub section_name: String,
    pub prop_key: String,
    pub prop_value: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Deserialize)]
pub struct DevPropertyPayload {
    pub dev_path: String,
    pub prop_key: String,
    pub prop_value: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GimIndexPayload {
    pub project_id: i64,
    pub entries: Vec<GimEntryPayload>,
    pub cbm_nodes: Vec<CbmNodePayload>,
    pub ifc_models: Vec<IfcModelPayload>,
    pub file_dev_entries: Vec<FileDevEntryPayload>,
    pub fam_properties: Vec<FamPropertyPayload>,
    pub dev_properties: Vec<DevPropertyPayload>,
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
    tx.execute("DELETE FROM fam_property WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 fam_property 失败: {}", e))?;
    tx.execute("DELETE FROM dev_property WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 dev_property 失败: {}", e))?;

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

    // fam_property
    for fp in &payload.fam_properties {
        tx.execute(
            "INSERT INTO fam_property (project_id, source_path, section_name, prop_key, prop_value, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![pid, fp.source_path, fp.section_name, fp.prop_key, fp.prop_value, fp.sort_order, now],
        )
        .map_err(|e| format!("插入 fam_property 失败: {}", e))?;
    }

    // dev_property
    for dp in &payload.dev_properties {
        tx.execute(
            "INSERT INTO dev_property (project_id, dev_path, prop_key, prop_value, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![pid, dp.dev_path, dp.prop_key, dp.prop_value, now],
        )
        .map_err(|e| format!("插入 dev_property 失败: {}", e))?;
    }

    // 索引完整写入后，更新 gim_project.parser_version 和 project_type 为当前版本
    // 只有事务成功提交后，缓存版本才会升级
    tx.execute(
        "UPDATE gim_project SET parser_version = ?1, project_type = 'substation', updated_at_ms = ?2 WHERE id = ?3",
        params![PARSER_VERSION, now, pid],
    )
    .map_err(|e| format!("更新 parser_version 失败: {}", e))?;

    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

// ===== GIM 索引读取 =====

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

// ===== 缓存文件落盘 =====

use std::io::Write as _;

/// 校验 entry_path：只允许 Normal 组件，拒绝 ParentDir / RootDir / Prefix。
/// 同时处理 "/" 和 Windows "\" 语义下的路径穿越。
/// 返回由 Normal 组件拼接的相对 PathBuf。
fn validate_entry_path(entry_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(entry_path);
    let mut components = Vec::new();
    for comp in path.components() {
        match comp {
            Component::Normal(s) => components.push(s),
            Component::ParentDir => return Err("entry_path 包含 .. 路径穿越".to_string()),
            Component::RootDir => return Err("entry_path 包含根目录".to_string()),
            Component::Prefix(_) => return Err("entry_path 包含盘符前缀".to_string()),
            Component::CurDir => { /* 跳过 . 当前目录 */ }
        }
    }
    if components.is_empty() {
        return Err("entry_path 无效：无有效路径组件".to_string());
    }
    let mut result = PathBuf::new();
    for c in components {
        result.push(c);
    }
    Ok(result)
}

/// 计算缓存文件路径：app_data_dir/extracted/{project_id}/{entry_path}
/// entry_path 通过组件级校验（只允许 Normal 组件），防止 ../ 和 \..\ 穿越。
/// 最终路径必须位于 app_data_dir/extracted/{project_id}/ 下。
fn cache_file_path(app_handle: &tauri::AppHandle, project_id: i64, entry_path: &str) -> Result<PathBuf, String> {
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;

    let safe_rel = validate_entry_path(entry_path)?;

    // 构建预期根目录：app_data_dir/extracted/{project_id}
    let root = base.join("extracted").join(project_id.to_string());
    stdfs::create_dir_all(&root).map_err(|e| format!("创建缓存目录失败: {}", e))?;

    // 规范化根目录用于 containment 校验（此时 root 已存在，canonicalize 必成功）
    let canonical_root = root.canonicalize().map_err(|e| format!("规范化缓存根目录失败: {}", e))?;

    // 拼接最终路径（safe_rel 仅含 Normal 组件，join 不会逃逸 canonical_root）
    let full = canonical_root.join(&safe_rel);

    // defense-in-depth：校验最终路径仍在 canonical_root 之下
    if !full.starts_with(&canonical_root) {
        return Err("路径越界".to_string());
    }

    // 创建文件父目录（如 DEV/subdir/）
    if let Some(parent) = full.parent() {
        stdfs::create_dir_all(parent).map_err(|e| format!("创建缓存子目录失败: {}", e))?;
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

/// Tauri command：读取缓存的 IFC 文件（路径由 project_id + entry_path 计算，不接受任意路径）
#[tauri::command]
pub fn read_cached_ifc(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
) -> Result<Vec<u8>, String> {
    let path = cache_file_path(&app_handle, project_id, &entry_path)?;
    stdfs::read(&path).map_err(|e| format!("读取缓存文件失败: {}", e))
}

// ===== Fragments 缓存 =====

/// 计算 Fragments 缓存文件路径：app_data_dir/fragments/{project_id}/{safe_entry_path}.frag
/// entry_path 通过组件级校验（只允许 Normal 组件），防止 ../ 和 \..\ 穿越。
/// 最终路径必须位于 app_data_dir/fragments/{project_id}/ 下。
fn fragment_cache_file_path(app_handle: &tauri::AppHandle, project_id: i64, entry_path: &str) -> Result<PathBuf, String> {
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;

    let safe_rel = validate_entry_path(entry_path)?;

    // 追加 .frag 后缀到文件名（保持与原实现一致：file.ifc → file.ifc.frag）
    let mut frag_rel = safe_rel;
    let file_name = frag_rel
        .file_name()
        .map(|n| format!("{}.frag", n.to_string_lossy()))
        .ok_or("无法获取 fragments 文件名")?;
    frag_rel.set_file_name(file_name);

    // 构建预期根目录：app_data_dir/fragments/{project_id}
    let root = base.join("fragments").join(project_id.to_string());
    stdfs::create_dir_all(&root).map_err(|e| format!("创建 fragments 缓存目录失败: {}", e))?;

    // 规范化根目录用于 containment 校验（此时 root 已存在，canonicalize 必成功）
    let canonical_root = root.canonicalize().map_err(|e| format!("规范化 fragments 根目录失败: {}", e))?;

    // 拼接最终路径（frag_rel 仅含 Normal 组件，join 不会逃逸 canonical_root）
    let full = canonical_root.join(&frag_rel);

    // defense-in-depth：校验最终路径仍在 canonical_root 之下
    if !full.starts_with(&canonical_root) {
        return Err("路径越界".to_string());
    }

    // 创建文件父目录（如 DEV/subdir/）
    if let Some(parent) = full.parent() {
        stdfs::create_dir_all(parent).map_err(|e| format!("创建 fragments 缓存子目录失败: {}", e))?;
    }

    Ok(full)
}

/// fragment_cache 表记录
#[derive(Debug, Serialize)]
pub struct FragmentCacheRecord {
    pub id: i64,
    pub project_id: i64,
    pub entry_path: String,
    pub model_id: String,
    pub source_ifc_size: i64,
    pub fragment_file_size: i64,
    pub fragments_version: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// Fragments 缓存校验结果
#[derive(Debug, Serialize)]
pub struct FragmentCacheValidation {
    pub project_id: i64,
    pub entry_path: String,
    pub has_record: bool,
    pub stored_fragments_version: Option<String>,
    pub current_fragments_version: String,
    pub fragments_version_match: bool,
    pub source_ifc_size_match: bool,
    pub fragment_file_exists: bool,
    pub fragment_file_size: u64,
    pub valid: bool,
}

/// Tauri command：写入 Fragments 缓存文件
#[tauri::command]
pub fn write_fragment_cache_file(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
    bytes: Vec<u8>,
) -> Result<serde_json::Value, String> {
    let path = fragment_cache_file_path(&app_handle, project_id, &entry_path)?;
    let size = bytes.len();
    let mut file = stdfs::File::create(&path).map_err(|e| format!("创建 fragments 缓存文件失败: {}", e))?;
    file.write_all(&bytes).map_err(|e| format!("写入 fragments 缓存文件失败: {}", e))?;
    Ok(serde_json::json!({ "path": path.to_string_lossy(), "size": size }))
}

/// Tauri command：读取 Fragments 缓存文件
#[tauri::command]
pub fn read_fragment_cache_file(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
) -> Result<Vec<u8>, String> {
    let path = fragment_cache_file_path(&app_handle, project_id, &entry_path)?;
    stdfs::read(&path).map_err(|e| format!("读取 fragments 缓存文件失败: {}", e))
}

/// Tauri command：upsert fragment_cache 记录
#[tauri::command]
pub fn upsert_fragment_cache_record(
    state: tauri::State<'_, DbState>,
    project_id: i64,
    entry_path: String,
    model_id: String,
    source_ifc_size: i64,
    fragment_file_size: i64,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO fragment_cache (project_id, entry_path, model_id, source_ifc_size, fragment_file_size, fragments_version, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(project_id, entry_path) DO UPDATE SET
           model_id = ?3, source_ifc_size = ?4, fragment_file_size = ?5, fragments_version = ?6, updated_at_ms = ?8",
        params![project_id, entry_path, model_id, source_ifc_size, fragment_file_size, FRAGMENTS_CACHE_VERSION, now, now],
    )
    .map_err(|e| format!("upsert fragment_cache 失败: {}", e))?;
    Ok(())
}

/// Tauri command：查询 fragment_cache 记录
#[tauri::command]
pub fn get_fragment_cache_record(
    state: tauri::State<'_, DbState>,
    project_id: i64,
    entry_path: String,
) -> Result<Option<FragmentCacheRecord>, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let res = conn.query_row(
        "SELECT id, project_id, entry_path, model_id, source_ifc_size, fragment_file_size, fragments_version, created_at_ms, updated_at_ms
         FROM fragment_cache
         WHERE project_id = ?1 AND entry_path = ?2",
        params![project_id, entry_path],
        |row| Ok(FragmentCacheRecord {
            id: row.get(0)?,
            project_id: row.get(1)?,
            entry_path: row.get(2)?,
            model_id: row.get(3)?,
            source_ifc_size: row.get(4)?,
            fragment_file_size: row.get(5)?,
            fragments_version: row.get(6)?,
            created_at_ms: row.get(7)?,
            updated_at_ms: row.get(8)?,
        }),
    );
    match res {
        Ok(r) => Ok(Some(r)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("查询 fragment_cache 失败: {}", e)),
    }
}

/// Tauri command：校验 Fragments 缓存有效性
#[tauri::command]
pub fn validate_fragment_cache(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    project_id: i64,
    entry_path: String,
    source_ifc_size: i64,
) -> Result<FragmentCacheValidation, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;

    // 查询记录
    let res = conn.query_row(
        "SELECT id, project_id, entry_path, model_id, source_ifc_size, fragment_file_size, fragments_version, created_at_ms, updated_at_ms
         FROM fragment_cache
         WHERE project_id = ?1 AND entry_path = ?2",
        params![project_id, entry_path],
        |row| Ok(FragmentCacheRecord {
            id: row.get(0)?,
            project_id: row.get(1)?,
            entry_path: row.get(2)?,
            model_id: row.get(3)?,
            source_ifc_size: row.get(4)?,
            fragment_file_size: row.get(5)?,
            fragments_version: row.get(6)?,
            created_at_ms: row.get(7)?,
            updated_at_ms: row.get(8)?,
        }),
    );
    drop(conn);

    let record = match res {
        Ok(r) => Some(r),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("查询 fragment_cache 失败: {}", e)),
    };

    let has_record = record.is_some();
    let stored_version = record.as_ref().map(|r| r.fragments_version.clone());
    let stored_ifc_size = record.as_ref().map(|r| r.source_ifc_size);

    let version_match = stored_version
        .as_ref()
        .map(|v| v == FRAGMENTS_CACHE_VERSION)
        .unwrap_or(false);
    // source_ifc_size = 0 表示跳过大小校验（Fragments 缓存命中路径不读 IFC buffer）
    let size_match = if source_ifc_size == 0 {
        true
    } else {
        stored_ifc_size.map(|s| s == source_ifc_size).unwrap_or(false)
    };

    // 检查 fragments 文件是否存在且大小 > 0
    let (file_exists, file_size) = match fragment_cache_file_path(&app_handle, project_id, &entry_path) {
        Ok(path) => match stdfs::metadata(&path) {
            Ok(meta) => (true, meta.len()),
            Err(_) => (false, 0),
        },
        Err(_) => (false, 0),
    };

    let valid = has_record && version_match && size_match && file_exists && file_size > 0;

    Ok(FragmentCacheValidation {
        project_id,
        entry_path,
        has_record,
        stored_fragments_version: stored_version,
        current_fragments_version: FRAGMENTS_CACHE_VERSION.to_string(),
        fragments_version_match: version_match,
        source_ifc_size_match: size_match,
        fragment_file_exists: file_exists,
        fragment_file_size: file_size,
        valid,
    })
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

/// fam_property 表完整记录
#[derive(Debug, Serialize)]
pub struct FamPropertyRecord {
    pub id: i64,
    pub project_id: i64,
    pub source_path: String,
    pub section_name: String,
    pub prop_key: String,
    pub prop_value: Option<String>,
    pub sort_order: i64,
    pub created_at_ms: u64,
}

/// dev_property 表完整记录
#[derive(Debug, Serialize)]
pub struct DevPropertyRecord {
    pub id: i64,
    pub project_id: i64,
    pub dev_path: String,
    pub prop_key: String,
    pub prop_value: Option<String>,
    pub created_at_ms: u64,
}

/// get_gim_index 返回结构
#[derive(Debug, Serialize)]
pub struct GetGimIndexResult {
    pub entries: Vec<GimEntryRecord>,
    pub cbm_nodes: Vec<CbmNodeRecord>,
    pub ifc_models: Vec<IfcModelRecord>,
    pub file_dev_entries: Vec<FileDevEntryRecord>,
    pub fam_properties: Vec<FamPropertyRecord>,
    pub dev_properties: Vec<DevPropertyRecord>,
}

/// 缓存校验结果
#[derive(Debug, Serialize)]
pub struct GimCacheValidation {
    pub project_id: i64,
    pub has_index: bool,
    pub ifc_models_count: u64,
    pub ifc_entry_count: u64,
    pub cached_ifc_count: u64,
    pub cbm_nodes_count: u64,
    pub file_dev_entries_count: u64,
    pub missing_cache_paths: Vec<String>,
    pub stored_parser_version: Option<String>,
    pub current_parser_version: String,
    pub parser_version_match: bool,
    pub valid: bool,
    /// v4: 工程类型（substation / transmission_line / hybrid / unknown）
    pub project_type: Option<String>,
    /// v4: line_cbm_node 表行数（transmission_line 缓存校验用）
    pub line_cbm_node_count: u64,
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

fn row_to_fam_property(row: &rusqlite::Row<'_>) -> rusqlite::Result<FamPropertyRecord> {
    Ok(FamPropertyRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        source_path: row.get(2)?,
        section_name: row.get(3)?,
        prop_key: row.get(4)?,
        prop_value: row.get(5)?,
        sort_order: row.get(6)?,
        created_at_ms: row.get(7)?,
    })
}

fn row_to_dev_property(row: &rusqlite::Row<'_>) -> rusqlite::Result<DevPropertyRecord> {
    Ok(DevPropertyRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        dev_path: row.get(2)?,
        prop_key: row.get(3)?,
        prop_value: row.get(4)?,
        created_at_ms: row.get(5)?,
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

    // 5. fam_property
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, source_path, section_name, prop_key, prop_value, sort_order, created_at_ms
             FROM fam_property
             WHERE project_id = ?1
             ORDER BY source_path ASC, sort_order ASC, id ASC",
        )
        .map_err(|e| format!("预处理 fam_property 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_fam_property)
        .map_err(|e| format!("查询 fam_property 失败: {}", e))?;
    let mut fam_properties = Vec::new();
    for r in rows {
        fam_properties.push(r.map_err(|e| format!("读取 fam_property 失败: {}", e))?);
    }

    // 6. dev_property
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, dev_path, prop_key, prop_value, created_at_ms
             FROM dev_property
             WHERE project_id = ?1
             ORDER BY dev_path ASC, id ASC",
        )
        .map_err(|e| format!("预处理 dev_property 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_dev_property)
        .map_err(|e| format!("查询 dev_property 失败: {}", e))?;
    let mut dev_properties = Vec::new();
    for r in rows {
        dev_properties.push(r.map_err(|e| format!("读取 dev_property 失败: {}", e))?);
    }

    Ok(GetGimIndexResult {
        entries,
        cbm_nodes,
        ifc_models,
        file_dev_entries,
        fam_properties,
        dev_properties,
    })
}

// ===== 线路工程图缓存（v4） =====

#[derive(Debug, Deserialize)]
pub struct LineCbmNodePayload {
    pub path: String,
    pub name: Option<String>,
    pub entity_name: Option<String>,
    pub classify_name: Option<String>,
    pub raw_props_json: String,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct LineCbmChildPayload {
    pub parent_path: String,
    pub child_path: String,
    pub sort_order: Option<i64>,
    pub ref_type: String,
    pub extra: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LineCbmRefPayload {
    pub node_path: String,
    pub ref_kind: String,
    pub ref_key: Option<String>,
    pub ref_value: String,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct LineFileStatPayload {
    pub file_type: String,
    pub count: i64,
}

#[derive(Debug, Deserialize)]
pub struct LineGraphPayload {
    pub project_id: i64,
    pub project_type: String,
    pub nodes: Vec<LineCbmNodePayload>,
    pub children: Vec<LineCbmChildPayload>,
    pub refs: Vec<LineCbmRefPayload>,
    pub file_stats: Vec<LineFileStatPayload>,
}

/// Tauri command：保存线路工程图缓存（事务：先删后插 + 更新 project_type）
#[tauri::command]
pub fn save_line_gim_graph(
    state: tauri::State<'_, DbState>,
    payload: LineGraphPayload,
) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    let pid = payload.project_id;

    // 先删除旧线路索引
    tx.execute("DELETE FROM line_cbm_node WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 line_cbm_node 失败: {}", e))?;
    tx.execute("DELETE FROM line_cbm_child WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 line_cbm_child 失败: {}", e))?;
    tx.execute("DELETE FROM line_cbm_ref WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 line_cbm_ref 失败: {}", e))?;
    tx.execute("DELETE FROM line_file_stat WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 line_file_stat 失败: {}", e))?;

    // line_cbm_node
    for n in &payload.nodes {
        tx.execute(
            "INSERT INTO line_cbm_node (project_id, path, name, entity_name, classify_name, raw_props_json, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![pid, n.path, n.name, n.entity_name, n.classify_name, n.raw_props_json, n.sort_order, now],
        )
        .map_err(|e| format!("插入 line_cbm_node 失败: {}", e))?;
    }

    // line_cbm_child
    for c in &payload.children {
        tx.execute(
            "INSERT INTO line_cbm_child (project_id, parent_path, child_path, sort_order, ref_type, extra, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![pid, c.parent_path, c.child_path, c.sort_order, c.ref_type, c.extra, now],
        )
        .map_err(|e| format!("插入 line_cbm_child 失败: {}", e))?;
    }

    // line_cbm_ref
    for r in &payload.refs {
        tx.execute(
            "INSERT INTO line_cbm_ref (project_id, node_path, ref_kind, ref_key, ref_value, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![pid, r.node_path, r.ref_kind, r.ref_key, r.ref_value, r.sort_order, now],
        )
        .map_err(|e| format!("插入 line_cbm_ref 失败: {}", e))?;
    }

    // line_file_stat
    for f in &payload.file_stats {
        tx.execute(
            "INSERT INTO line_file_stat (project_id, file_type, count)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(project_id, file_type) DO UPDATE SET count = ?3",
            params![pid, f.file_type, f.count],
        )
        .map_err(|e| format!("插入 line_file_stat 失败: {}", e))?;
    }

    // 更新 gim_project.parser_version 和 project_type
    tx.execute(
        "UPDATE gim_project SET parser_version = ?1, project_type = ?2, updated_at_ms = ?3 WHERE id = ?4",
        params![PARSER_VERSION, payload.project_type, now, pid],
    )
    .map_err(|e| format!("更新 project_type 失败: {}", e))?;

    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

// ===== 线路工程图读取 =====

#[derive(Debug, Serialize)]
pub struct LineCbmNodeRecord {
    pub path: String,
    pub name: Option<String>,
    pub entity_name: Option<String>,
    pub classify_name: Option<String>,
    pub raw_props_json: String,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct LineCbmChildRecord {
    pub parent_path: String,
    pub child_path: String,
    pub sort_order: Option<i64>,
    pub ref_type: String,
    pub extra: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LineCbmRefRecord {
    pub node_path: String,
    pub ref_kind: String,
    pub ref_key: Option<String>,
    pub ref_value: String,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct LineFileStatRecord {
    pub file_type: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct LineGraphResult {
    pub project_type: Option<String>,
    pub nodes: Vec<LineCbmNodeRecord>,
    pub children: Vec<LineCbmChildRecord>,
    pub refs: Vec<LineCbmRefRecord>,
    pub file_stats: Vec<LineFileStatRecord>,
}

/// Tauri command：读取线路工程图缓存
#[tauri::command]
pub fn get_line_gim_graph(
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<LineGraphResult, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;

    // 读取 project_type
    let project_type: Option<String> = conn
        .query_row(
            "SELECT project_type FROM gim_project WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    // 1. line_cbm_node
    let mut stmt = conn
        .prepare("SELECT path, name, entity_name, classify_name, raw_props_json, sort_order FROM line_cbm_node WHERE project_id = ?1 ORDER BY sort_order ASC, id ASC")
        .map_err(|e| format!("预处理 line_cbm_node 失败: {}", e))?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(LineCbmNodeRecord {
            path: row.get(0)?,
            name: row.get(1)?,
            entity_name: row.get(2)?,
            classify_name: row.get(3)?,
            raw_props_json: row.get(4)?,
            sort_order: row.get(5)?,
        })
    }).map_err(|e| format!("查询 line_cbm_node 失败: {}", e))?;
    let mut nodes = Vec::new();
    for r in rows { nodes.push(r.map_err(|e| format!("读取 line_cbm_node 失败: {}", e))?); }

    // 2. line_cbm_child
    let mut stmt = conn
        .prepare("SELECT parent_path, child_path, sort_order, ref_type, extra FROM line_cbm_child WHERE project_id = ?1 ORDER BY parent_path ASC, sort_order ASC, id ASC")
        .map_err(|e| format!("预处理 line_cbm_child 失败: {}", e))?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(LineCbmChildRecord {
            parent_path: row.get(0)?,
            child_path: row.get(1)?,
            sort_order: row.get(2)?,
            ref_type: row.get(3)?,
            extra: row.get(4)?,
        })
    }).map_err(|e| format!("查询 line_cbm_child 失败: {}", e))?;
    let mut children = Vec::new();
    for r in rows { children.push(r.map_err(|e| format!("读取 line_cbm_child 失败: {}", e))?); }

    // 3. line_cbm_ref
    let mut stmt = conn
        .prepare("SELECT node_path, ref_kind, ref_key, ref_value, sort_order FROM line_cbm_ref WHERE project_id = ?1 ORDER BY node_path ASC, ref_kind ASC, sort_order ASC, id ASC")
        .map_err(|e| format!("预处理 line_cbm_ref 失败: {}", e))?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(LineCbmRefRecord {
            node_path: row.get(0)?,
            ref_kind: row.get(1)?,
            ref_key: row.get(2)?,
            ref_value: row.get(3)?,
            sort_order: row.get(4)?,
        })
    }).map_err(|e| format!("查询 line_cbm_ref 失败: {}", e))?;
    let mut refs = Vec::new();
    for r in rows { refs.push(r.map_err(|e| format!("读取 line_cbm_ref 失败: {}", e))?); }

    // 4. line_file_stat
    let mut stmt = conn
        .prepare("SELECT file_type, count FROM line_file_stat WHERE project_id = ?1 ORDER BY file_type ASC")
        .map_err(|e| format!("预处理 line_file_stat 失败: {}", e))?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(LineFileStatRecord {
            file_type: row.get(0)?,
            count: row.get(1)?,
        })
    }).map_err(|e| format!("查询 line_file_stat 失败: {}", e))?;
    let mut file_stats = Vec::new();
    for r in rows { file_stats.push(r.map_err(|e| format!("读取 line_file_stat 失败: {}", e))?); }

    Ok(LineGraphResult {
        project_type,
        nodes,
        children,
        refs,
        file_stats,
    })
}

/// Tauri command：校验 GIM 缓存完整性（只读，不修复）
///
/// v4 增强：根据 project_type 分支校验逻辑
/// - transmission_line：valid = parser_version_match && line_cbm_node_count > 0
/// - substation（或 null/unknown）：保持原有 IFC/cache 校验逻辑
#[tauri::command]
pub fn validate_gim_cache(
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<GimCacheValidation, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;

    let cbm_nodes_count = count_rows(&conn, "cbm_node", project_id)?;
    let ifc_models_count = count_rows(&conn, "ifc_model", project_id)?;
    let file_dev_entries_count = count_rows(&conn, "file_dev_entry", project_id)?;
    let line_cbm_node_count = count_rows(&conn, "line_cbm_node", project_id)?;
    let has_index = cbm_nodes_count > 0 || ifc_models_count > 0 || line_cbm_node_count > 0;

    // 读取 parser_version 和 project_type
    let (stored_parser_version, project_type): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT parser_version, project_type FROM gim_project WHERE id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()
        .unwrap_or((None, None));
    let parser_version_match = stored_parser_version
        .as_deref()
        .map(|v| v == PARSER_VERSION)
        .unwrap_or(false);

    // v4: 根据 project_type 分支校验
    // transmission_line：只需 parser_version 匹配 + line_cbm_node_count > 0
    // substation（或 null/unknown）：保持原有 IFC/cache 校验逻辑
    let is_line = project_type.as_deref() == Some("transmission_line");

    let (ifc_entry_count, cached_ifc_count, missing_cache_paths, valid) = if is_line {
        // 线路工程：不检查 IFC 缓存
        let valid = parser_version_match && line_cbm_node_count > 0;
        (0u64, 0u64, Vec::new(), valid)
    } else {
        // 变电工程：保持原有 IFC 缓存校验
        let mut stmt = conn
            .prepare(
                "SELECT entry_path, local_cache_path, file_size
                 FROM gim_entry
                 WHERE project_id = ?1 AND entry_type = 'IFC'",
            )
            .map_err(|e| format!("预处理 IFC entry 失败: {}", e))?;
        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| format!("查询 IFC entry 失败: {}", e))?;

        let mut cached_ifc_count: u64 = 0;
        let mut ifc_entry_count: u64 = 0;
        let mut missing_cache_paths: Vec<String> = Vec::new();
        for r in rows {
            let (entry_path, local_cache_path, expected_size) = r.map_err(|e| format!("读取 IFC entry 失败: {}", e))?;
            ifc_entry_count += 1;
            match local_cache_path {
                Some(p) if !p.is_empty() => {
                    let path = std::path::Path::new(&p);
                    if path.exists() {
                        let actual_size = stdfs::metadata(path).map(|m| m.len()).unwrap_or(0);
                        if actual_size as i64 == expected_size {
                            cached_ifc_count += 1;
                        } else {
                            missing_cache_paths.push(format!("{} (大小不匹配: 期望 {}, 实际 {})", entry_path, expected_size, actual_size));
                        }
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
            && cbm_nodes_count > 0
            && cached_ifc_count == ifc_entry_count
            && missing_cache_paths.is_empty()
            && parser_version_match;

        (ifc_entry_count, cached_ifc_count, missing_cache_paths, valid)
    };

    Ok(GimCacheValidation {
        project_id,
        has_index,
        ifc_models_count: ifc_models_count as u64,
        ifc_entry_count,
        cached_ifc_count,
        cbm_nodes_count: cbm_nodes_count as u64,
        file_dev_entries_count: file_dev_entries_count as u64,
        missing_cache_paths,
        stored_parser_version,
        current_parser_version: PARSER_VERSION.to_string(),
        parser_version_match,
        valid,
        project_type,
        line_cbm_node_count: line_cbm_node_count as u64,
    })
}

// ==================== 诊断 command ====================

/// 单个 IFC 缓存文件诊断
#[derive(Debug, Serialize)]
pub struct IfcCacheFileDiagnostic {
    pub entry_path: String,
    pub local_cache_path: Option<String>,
    pub exists: bool,
    pub file_size: Option<u64>,
}

/// 单个 Fragments 缓存文件诊断
#[derive(Debug, Serialize)]
pub struct FragmentCacheFileDiagnostic {
    pub entry_path: String,
    pub model_id: String,
    pub source_ifc_size: i64,
    pub fragment_file_size_stored: i64,
    pub fragment_file_size_actual: u64,
    pub stored_fragments_version: String,
    pub current_fragments_cache_version: String,
    pub fragments_version_match: bool,
    pub fragment_file_exists: bool,
    pub valid: bool,
}

/// 项目缓存完整诊断
#[derive(Debug, Serialize)]
pub struct ProjectCacheDiagnostic {
    pub project_id: i64,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    pub sha256: String,

    pub entries_count: u64,
    pub cbm_nodes_count: u64,
    pub ifc_models_count: u64,
    pub file_dev_entries_count: u64,
    pub fam_properties_count: u64,
    pub dev_properties_count: u64,

    pub ifc_entry_count: u64,
    pub cached_ifc_count: u64,
    pub missing_cache_paths: Vec<String>,
    pub stored_parser_version: Option<String>,
    pub current_parser_version: String,
    pub parser_version_match: bool,
    pub valid: bool,

    pub ifc_cache_files: Vec<IfcCacheFileDiagnostic>,

    // Fragments 缓存诊断
    pub fragment_cache_count: u64,
    pub valid_fragment_cache_count: u64,
    pub missing_fragment_cache_paths: Vec<String>,
    pub current_fragments_cache_version: String,
    pub fragment_cache_files: Vec<FragmentCacheFileDiagnostic>,
}

/// 返回当前 SQLite 文件路径
#[tauri::command]
pub fn get_db_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = db_path(&app_handle)?;
    Ok(path.to_string_lossy().to_string())
}

/// 获取指定项目的缓存诊断（内部函数，被 get_latest_project_cache_diagnostic 调用）
pub fn get_project_cache_diagnostic(
    app_handle: &tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<ProjectCacheDiagnostic, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;

    // 1. 查询 gim_project 基本信息（含 parser_version）
    let project = conn
        .query_row(
            "SELECT id, path, name, size, modified_ms, sha256, parser_version FROM gim_project WHERE id = ?1",
            params![project_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u64>(3)?,
                    row.get::<_, u64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(|e| format!("查询项目失败: {}", e))?;

    let parser_version_match = project.6.as_deref() == Some(PARSER_VERSION);

    // 2. 统计索引表数量
    let entries_count = count_rows(&conn, "gim_entry", project_id)?;
    let cbm_nodes_count = count_rows(&conn, "cbm_node", project_id)?;
    let ifc_models_count = count_rows(&conn, "ifc_model", project_id)?;
    let file_dev_entries_count = count_rows(&conn, "file_dev_entry", project_id)?;
    let fam_properties_count = count_rows(&conn, "fam_property", project_id)?;
    let dev_properties_count = count_rows(&conn, "dev_property", project_id)?;
    let has_index = cbm_nodes_count > 0 || ifc_models_count > 0;

    // 3. 查询 IFC entry 并诊断每个缓存文件
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

    let mut ifc_entry_count: u64 = 0;
    let mut cached_ifc_count: u64 = 0;
    let mut missing_cache_paths: Vec<String> = Vec::new();
    let mut ifc_cache_files: Vec<IfcCacheFileDiagnostic> = Vec::new();

    for r in rows {
        let (entry_path, local_cache_path) = r.map_err(|e| format!("读取 IFC entry 失败: {}", e))?;
        ifc_entry_count += 1;

        let (exists, file_size) = match &local_cache_path {
            Some(p) if !p.is_empty() => {
                let path = std::path::Path::new(p);
                if path.exists() {
                    let size = stdfs::metadata(path).map(|m| m.len()).ok();
                    cached_ifc_count += 1;
                    (true, size)
                } else {
                    missing_cache_paths.push(entry_path.clone());
                    (false, None)
                }
            }
            _ => {
                missing_cache_paths.push(entry_path.clone());
                (false, None)
            }
        };

        ifc_cache_files.push(IfcCacheFileDiagnostic {
            entry_path,
            local_cache_path,
            exists,
            file_size,
        });
    }

    // 4. 查询 fragment_cache 记录并诊断每个 fragments 缓存文件
    let mut frag_stmt = conn
        .prepare(
            "SELECT entry_path, model_id, source_ifc_size, fragment_file_size, fragments_version
             FROM fragment_cache
             WHERE project_id = ?1
             ORDER BY entry_path ASC",
        )
        .map_err(|e| format!("预处理 fragment_cache 失败: {}", e))?;
    let frag_rows = frag_stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| format!("查询 fragment_cache 失败: {}", e))?;

    let mut fragment_cache_count: u64 = 0;
    let mut valid_fragment_cache_count: u64 = 0;
    let mut missing_fragment_cache_paths: Vec<String> = Vec::new();
    let mut fragment_cache_files: Vec<FragmentCacheFileDiagnostic> = Vec::new();

    for r in frag_rows {
        let (entry_path, model_id, source_ifc_size, frag_size_stored, stored_version) =
            r.map_err(|e| format!("读取 fragment_cache 失败: {}", e))?;
        fragment_cache_count += 1;

        let version_match = stored_version == FRAGMENTS_CACHE_VERSION;
        let (file_exists, file_size_actual) = match fragment_cache_file_path(app_handle, project_id, &entry_path) {
            Ok(path) => match stdfs::metadata(&path) {
                Ok(meta) => (true, meta.len()),
                Err(_) => (false, 0),
            },
            Err(_) => (false, 0),
        };

        let frag_valid = version_match && file_exists && file_size_actual > 0;
        if frag_valid {
            valid_fragment_cache_count += 1;
        } else {
            missing_fragment_cache_paths.push(entry_path.clone());
        }

        fragment_cache_files.push(FragmentCacheFileDiagnostic {
            entry_path,
            model_id,
            source_ifc_size,
            fragment_file_size_stored: frag_size_stored,
            fragment_file_size_actual: file_size_actual,
            stored_fragments_version: stored_version,
            current_fragments_cache_version: FRAGMENTS_CACHE_VERSION.to_string(),
            fragments_version_match: version_match,
            fragment_file_exists: file_exists,
            valid: frag_valid,
        });
    }

    let valid = has_index
        && ifc_models_count > 0
        && ifc_entry_count > 0
        && cached_ifc_count == ifc_entry_count
        && missing_cache_paths.is_empty()
        && parser_version_match;

    Ok(ProjectCacheDiagnostic {
        project_id: project.0,
        path: project.1,
        name: project.2,
        size: project.3,
        modified_ms: project.4,
        sha256: project.5,
        entries_count: entries_count as u64,
        cbm_nodes_count: cbm_nodes_count as u64,
        ifc_models_count: ifc_models_count as u64,
        file_dev_entries_count: file_dev_entries_count as u64,
        fam_properties_count: fam_properties_count as u64,
        dev_properties_count: dev_properties_count as u64,
        ifc_entry_count,
        cached_ifc_count,
        missing_cache_paths,
        stored_parser_version: project.6.clone(),
        current_parser_version: PARSER_VERSION.to_string(),
        parser_version_match,
        valid,
        ifc_cache_files,
        fragment_cache_count,
        valid_fragment_cache_count,
        missing_fragment_cache_paths,
        current_fragments_cache_version: FRAGMENTS_CACHE_VERSION.to_string(),
        fragment_cache_files,
    })
}

/// 获取最近打开项目的缓存诊断
#[tauri::command]
pub fn get_latest_project_cache_diagnostic(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
) -> Result<Option<ProjectCacheDiagnostic>, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;

    let latest_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM gim_project ORDER BY last_opened_at_ms DESC LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .ok();

    match latest_id {
        Some(id) => {
            drop(conn);
            // 重新获取锁调用 get_project_cache_diagnostic
            get_project_cache_diagnostic(&app_handle, state, id).map(Some)
        }
        None => Ok(None),
    }
}
