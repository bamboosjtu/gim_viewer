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
/// v5: adds transmission_line FAM/DEV attribute cache (line_fam_property / line_dev_property)
/// v6: 缓存 DEV/PHM/MOD 几何文件到本地磁盘（缓存命中场景下支持 xml-mod 回放）
/// v7: 几何引用链递归 DEV SUBDEVICE，并保存 SUBDEVICE 变换矩阵
/// v8: 几何查询使用 CBM 父链累计 TRANSFORMMATRIX，并按实例级 placement 去重
/// v9: 层级树名称优化——F1System 根节点用 GIM 头部工程名，F4System/PARTINDEX 设备层用 DEV SYMBOLNAME；过滤 IFC "&其他"占位符
/// v10: F1System 显示工程类型名（变电工程/建筑工程），F2System 按 SYSCLASSIFYNAME 映射专业名（U=建筑工程等）并按 U→A→S→G 排序
/// v11: F3System 命名优化——方案A 过滤 SYSTEMNAME 占位符（- / 其它 / 空），方案B 收集 F4 子节点设备名/IFC文件名生成区分性后缀
/// v12: 修复 DEV SUBDEVICE 虚拟子节点 transformMatrix 为空导致嵌套 DEV 中 MOD 位置错误（丢失 SUBDEVICE 变换）
/// v13: DEV_SUBDEVICE 虚拟节点仅用于层级树/点击，不作为全量几何查询起点，避免与 DEV SUBDEVICES 递归重复
pub const PARSER_VERSION: &str = "gim-parser-v13";

/// Fragments 缓存版本（独立于 GIM parser_version，变更缓存格式时递增）
/// v2: 修复旧 v1 缓存可能加载不全的问题，强制失效重建
/// v3: IFC 加载关闭 COORDINATE_TO_ORIGIN，保留工程原始坐标以对齐 MOD（已废弃）
/// v4: restore IFC coordinateToOrigin=true; MOD/STL alignment handled by project-level sourceToViewer transform
pub const FRAGMENTS_CACHE_VERSION: &str = "fragments-cache-v4";

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
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("设置数据库 busy_timeout 失败: {}", e))?;

    // WAL is an optimization, not a startup requirement. If another dev
    // instance is still holding the database lock, forcing WAL here would make
    // Tauri setup panic before the UI can recover or show cache diagnostics.
    if let Err(e) = conn.pragma_update(None, "journal_mode", "WAL") {
        eprintln!("[db] 跳过 WAL 模式设置: {}", e);
    } else if let Err(e) = conn.pragma_update(None, "synchronous", "NORMAL") {
        eprintln!("[db] 跳过 synchronous=NORMAL 设置: {}", e);
    }

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
        CREATE INDEX IF NOT EXISTS idx_cbm_node_project_dev ON cbm_node(project_id, dev_path);

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

    // v5: line_cbm_ref 补字段（归一化结果，避免诊断时再临时猜路径）
    // 兼容旧库：已存在则忽略
    let _ = conn.execute("ALTER TABLE line_cbm_ref ADD COLUMN normalized_ref_value TEXT", []);
    let _ = conn.execute("ALTER TABLE line_cbm_ref ADD COLUMN file_name_lower TEXT", []);

    // v5: 线路工程 FAM/DEV 属性缓存表
    // line_fam_property：display_key 为中文展示键，prop_key 为英文键，prop_value 可含 =
    // line_dev_property：普通 KEY=VALUE，无 display_key
    // 使用复合 PRIMARY KEY（同 line_file_stat 模式），不设自增 id 列
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS line_fam_property (
            project_id INTEGER NOT NULL,
            source_path TEXT NOT NULL,
            normalized_path TEXT NOT NULL,
            file_name_lower TEXT NOT NULL,
            display_key TEXT,
            prop_key TEXT NOT NULL,
            prop_value TEXT,
            raw_line TEXT,
            sort_order INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(project_id, normalized_path, prop_key, sort_order)
        );
        CREATE INDEX IF NOT EXISTS idx_line_fam_property_project ON line_fam_property(project_id);
        CREATE INDEX IF NOT EXISTS idx_line_fam_property_source ON line_fam_property(project_id, source_path);
        CREATE INDEX IF NOT EXISTS idx_line_fam_property_filename ON line_fam_property(project_id, file_name_lower);

        CREATE TABLE IF NOT EXISTS line_dev_property (
            project_id INTEGER NOT NULL,
            source_path TEXT NOT NULL,
            normalized_path TEXT NOT NULL,
            file_name_lower TEXT NOT NULL,
            prop_key TEXT NOT NULL,
            prop_value TEXT,
            raw_line TEXT,
            sort_order INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(project_id, normalized_path, prop_key, sort_order)
        );
        CREATE INDEX IF NOT EXISTS idx_line_dev_property_project ON line_dev_property(project_id);
        CREATE INDEX IF NOT EXISTS idx_line_dev_property_source ON line_dev_property(project_id, source_path);
        CREATE INDEX IF NOT EXISTS idx_line_dev_property_filename ON line_dev_property(project_id, file_name_lower);",
    )
    .map_err(|e| format!("初始化线路工程 FAM/DEV 属性缓存表失败: {}", e))?;

    // v6: 几何引用链缓存表（DEV → PHM → MOD/STL）
    // 避免缓存命中时逐文件读取数千个 DEV/PHM 来发现几何源
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS dev_solid_model (
            project_id INTEGER NOT NULL,
            dev_path TEXT NOT NULL,
            solid_model_path TEXT NOT NULL,
            transform_matrix TEXT,
            sort_order INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(project_id, dev_path, sort_order)
        );
        CREATE INDEX IF NOT EXISTS idx_dev_sm_project ON dev_solid_model(project_id);
        CREATE INDEX IF NOT EXISTS idx_dev_sm_dev ON dev_solid_model(project_id, dev_path);

        CREATE TABLE IF NOT EXISTS dev_sub_device (
            project_id INTEGER NOT NULL,
            dev_path TEXT NOT NULL,
            child_dev_path TEXT NOT NULL,
            transform_matrix TEXT,
            sort_order INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(project_id, dev_path, sort_order)
        );
        CREATE INDEX IF NOT EXISTS idx_dev_sub_project ON dev_sub_device(project_id);
        CREATE INDEX IF NOT EXISTS idx_dev_sub_dev ON dev_sub_device(project_id, dev_path);
        CREATE INDEX IF NOT EXISTS idx_dev_sub_project_child ON dev_sub_device(project_id, child_dev_path);

        CREATE TABLE IF NOT EXISTS phm_solid_model (
            project_id INTEGER NOT NULL,
            phm_path TEXT NOT NULL,
            solid_model_path TEXT NOT NULL,
            transform_matrix TEXT,
            color TEXT,
            sort_order INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(project_id, phm_path, sort_order)
        );
        CREATE INDEX IF NOT EXISTS idx_phm_sm_project ON phm_solid_model(project_id);
        CREATE INDEX IF NOT EXISTS idx_phm_sm_phm ON phm_solid_model(project_id, phm_path);
        CREATE INDEX IF NOT EXISTS idx_phm_sm_project_solid ON phm_solid_model(project_id, solid_model_path);",
    )
    .map_err(|e| format!("初始化几何引用链缓存表失败: {}", e))?;

    // v7: DEV SUBDEVICE 也有独立 TRANSFORMMATRIXn，旧缓存库需补列。
    let _ = conn.execute("ALTER TABLE dev_sub_device ADD COLUMN transform_matrix TEXT", []);

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
///
/// 缓存失效策略（同一路径 GIM 文件变化检测）：
/// - 更新前读取旧 size / modified_ms / sha256
/// - 若三者任一变化：更新元信息并 SET parser_version = NULL, project_type = NULL，
///   使 validate_gim_cache 返回 invalid，触发完整重建。
///   不删除旧索引表数据；save_gim_index / save_line_gim_graph 会覆盖旧索引。
/// - 若三者完全一致：仅更新访问时间，不碰 parser_version / project_type。
#[tauri::command]
pub fn upsert_gim_project(
    state: tauri::State<'_, DbState>,
    info: FileInfoInput,
) -> Result<GimProjectRecord, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let now = now_ms();

    // 检查是否已存在，同时读取旧元信息判断源 GIM 文件是否变化
    let existing: Option<(i64, u64, u64, String)> = conn
        .query_row(
            "SELECT id, size, modified_ms, sha256 FROM gim_project WHERE path = ?1",
            params![info.path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok();

    if let Some((id, old_size, old_modified_ms, old_sha256)) = existing {
        // 源 GIM 文件是否变化：size / modified_ms / sha256 任一不同即视为变化
        let file_changed = old_size != info.size
            || old_modified_ms != info.modified_ms
            || old_sha256 != info.sha256;

        if file_changed {
            // 源 GIM 文件变化：更新元信息，同时清空 parser_version / project_type，
            // 使 validate_gim_cache 返回 invalid，触发完整重建（不删除旧索引表数据）
            conn.execute(
                "UPDATE gim_project SET name = ?1, size = ?2, modified_ms = ?3, sha256 = ?4, parser_version = NULL, project_type = NULL, updated_at_ms = ?5, last_opened_at_ms = ?6 WHERE id = ?7",
                params![info.name, info.size, info.modified_ms, info.sha256, now, now, id],
            )
            .map_err(|e| format!("更新项目记录失败: {}", e))?;
            println!(
                "[GIM] 源 GIM 文件变化，旧索引失效（path={}, old_size={}, new_size={}, old_sha256={}...）",
                info.path, old_size, info.size, &old_sha256[..old_sha256.len().min(12)]
            );
        } else {
            // 源文件未变化时不要为了 last_opened_at_ms 强制写库。打开 GIM 的
            // 主流程只需要 project_id 和已有 parser_version；若另一个旧实例
            // 暂时持有 SQLite 写锁，非必要写入会阻断缓存命中和后续读取。
            println!(
                "[GIM] 源 GIM 文件未变化，跳过项目访问时间写入（path={}）",
                info.path
            );
        }

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
///
/// 防御：拒绝为空 IFC 索引打 parser_version=v4。
/// 变电工程索引必须包含 IFC 模型与 IFC entry；
/// 否则可能是线路工程被误识别为 substation，应走 save_line_gim_graph 而非本命令。
#[tauri::command]
pub fn save_gim_index(
    state: tauri::State<'_, DbState>,
    payload: GimIndexPayload,
) -> Result<(), String> {
    // 防御校验：变电工程索引必须包含 IFC 模型或 IFC entry
    if payload.ifc_models.is_empty()
        || !payload
            .entries
            .iter()
            .any(|e| e.entry_type == "IFC")
    {
        return Err(
            "拒绝写入 substation 索引：未发现 IFC 模型或 IFC entry（可能为线路工程被误识别，应走 save_line_gim_graph）"
                .to_string(),
        );
    }

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

/// 批量读取缓存文件的返回项
#[derive(Debug, Serialize)]
pub struct BatchCacheFileResult {
    pub entry_path: String,
    /// 成功时包含文件字节，失败时为 null
    pub bytes: Option<Vec<u8>>,
}

/// Tauri command：批量读取缓存文件（一次 IPC 替代 N 次 read_cached_ifc）。
///
/// 用于缓存命中时批量加载 DEV/PHM/MOD/STL 文件，避免数千次 IPC 往返。
/// 单个文件读取失败不影响其他文件（对应 item.bytes = null）。
#[tauri::command]
pub fn batch_read_cached_files(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_paths: Vec<String>,
) -> Result<Vec<BatchCacheFileResult>, String> {
    let mut results = Vec::with_capacity(entry_paths.len());
    for entry_path in &entry_paths {
        let path = match cache_file_path(&app_handle, project_id, entry_path) {
            Ok(p) => p,
            Err(_) => {
                results.push(BatchCacheFileResult {
                    entry_path: entry_path.clone(),
                    bytes: None,
                });
                continue;
            }
        };
        let bytes = stdfs::read(&path).ok();
        results.push(BatchCacheFileResult {
            entry_path: entry_path.clone(),
            bytes,
        });
    }
    Ok(results)
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
    /// v5: line_fam_property 不同 file_name_lower 的去重数量
    pub line_fam_source_count: u64,
    /// v5: line_dev_property 不同 file_name_lower 的去重数量
    pub line_dev_source_count: u64,
    /// v5: line_cbm_ref 中 ref_kind=famFiles 的 file_name_lower 去重数量
    pub line_expected_fam_ref_count: u64,
    /// v5: line_cbm_ref 中 ref_kind=devFiles 的 file_name_lower 去重数量
    pub line_expected_dev_ref_count: u64,
    /// v5: 图引用中存在但 line_fam_property 缺失的 file_name_lower 列表
    pub missing_line_fam_sources: Vec<String>,
    /// v5: 图引用中存在但 line_dev_property 缺失的 file_name_lower 列表
    pub missing_line_dev_sources: Vec<String>,
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
    /// v5: 归一化后的引用值（路径统一为 / 分隔，去空段），用于诊断时匹配 FAM/DEV 文件
    pub normalized_ref_value: Option<String>,
    /// v5: 引用值的文件名小写（如 "x.fam"），用于诊断时的文件名匹配
    pub file_name_lower: Option<String>,
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

    // line_cbm_ref（v5: 同时写入 normalized_ref_value / file_name_lower）
    for r in &payload.refs {
        tx.execute(
            "INSERT INTO line_cbm_ref (project_id, node_path, ref_kind, ref_key, ref_value, sort_order, normalized_ref_value, file_name_lower, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![pid, r.node_path, r.ref_kind, r.ref_key, r.ref_value, r.sort_order, r.normalized_ref_value, r.file_name_lower, now],
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

// ===== v5: 线路工程 FAM/DEV 属性缓存 =====

/// line_fam_property 写入 payload
/// FAM 行格式：`中文展示键=ENGLISH_KEY=值`（值可能含 =，前端已 rejoin）
#[derive(Debug, Deserialize)]
pub struct LineFamPropertyPayload {
    pub source_path: String,
    pub normalized_path: String,
    pub file_name_lower: String,
    pub display_key: Option<String>,
    pub prop_key: String,
    pub prop_value: Option<String>,
    pub raw_line: Option<String>,
    pub sort_order: i64,
}

/// line_dev_property 写入 payload（普通 KEY=VALUE）
#[derive(Debug, Deserialize)]
pub struct LineDevPropertyPayload {
    pub source_path: String,
    pub normalized_path: String,
    pub file_name_lower: String,
    pub prop_key: String,
    pub prop_value: Option<String>,
    pub raw_line: Option<String>,
    pub sort_order: i64,
}

/// Tauri command：统一保存线路工程缓存（图 + FAM/DEV 属性，一个事务）
///
/// 替代生产环境单独调用 save_line_gim_graph 的做法。事务内：
/// 1. 删除旧 line_cbm_node / line_cbm_child / line_cbm_ref / line_file_stat
/// 2. 删除旧 line_fam_property / line_dev_property
/// 3. 插入 graph payload（nodes / children / refs / file_stats）
/// 4. 插入 fam_props / dev_props
/// 5. 更新 gim_project: parser_version = PARSER_VERSION（当前 gim-parser-v13）, project_type = transmission_line
///
/// 使用 prepared statement 批量插入，避免每行重新 prepare。
#[tauri::command]
pub fn save_line_project_cache(
    state: tauri::State<'_, DbState>,
    project_id: i64,
    graph_payload: LineGraphPayload,
    fam_props: Vec<LineFamPropertyPayload>,
    dev_props: Vec<LineDevPropertyPayload>,
) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    let pid = project_id;

    // 1. 删除旧索引（6 张表）
    tx.execute("DELETE FROM line_cbm_node WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 line_cbm_node 失败: {}", e))?;
    tx.execute("DELETE FROM line_cbm_child WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 line_cbm_child 失败: {}", e))?;
    tx.execute("DELETE FROM line_cbm_ref WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 line_cbm_ref 失败: {}", e))?;
    tx.execute("DELETE FROM line_file_stat WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 line_file_stat 失败: {}", e))?;
    tx.execute("DELETE FROM line_fam_property WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 line_fam_property 失败: {}", e))?;
    tx.execute("DELETE FROM line_dev_property WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 line_dev_property 失败: {}", e))?;

    // 2. line_cbm_node（prepared statement）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO line_cbm_node (project_id, path, name, entity_name, classify_name, raw_props_json, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ).map_err(|e| format!("预处理 line_cbm_node 失败: {}", e))?;
        for n in &graph_payload.nodes {
            stmt.execute(params![pid, n.path, n.name, n.entity_name, n.classify_name, n.raw_props_json, n.sort_order, now])
                .map_err(|e| format!("插入 line_cbm_node 失败: {}", e))?;
        }
    }

    // 3. line_cbm_child（prepared statement）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO line_cbm_child (project_id, parent_path, child_path, sort_order, ref_type, extra, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
        ).map_err(|e| format!("预处理 line_cbm_child 失败: {}", e))?;
        for c in &graph_payload.children {
            stmt.execute(params![pid, c.parent_path, c.child_path, c.sort_order, c.ref_type, c.extra, now])
                .map_err(|e| format!("插入 line_cbm_child 失败: {}", e))?;
        }
    }

    // 4. line_cbm_ref（v5: 含 normalized_ref_value / file_name_lower，prepared statement）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO line_cbm_ref (project_id, node_path, ref_kind, ref_key, ref_value, sort_order, normalized_ref_value, file_name_lower, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        ).map_err(|e| format!("预处理 line_cbm_ref 失败: {}", e))?;
        for r in &graph_payload.refs {
            stmt.execute(params![pid, r.node_path, r.ref_kind, r.ref_key, r.ref_value, r.sort_order, r.normalized_ref_value, r.file_name_lower, now])
                .map_err(|e| format!("插入 line_cbm_ref 失败: {}", e))?;
        }
    }

    // 5. line_file_stat（prepared statement）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO line_file_stat (project_id, file_type, count)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(project_id, file_type) DO UPDATE SET count = ?3"
        ).map_err(|e| format!("预处理 line_file_stat 失败: {}", e))?;
        for f in &graph_payload.file_stats {
            stmt.execute(params![pid, f.file_type, f.count])
                .map_err(|e| format!("插入 line_file_stat 失败: {}", e))?;
        }
    }

    // 6. line_fam_property（prepared statement）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO line_fam_property (project_id, source_path, normalized_path, file_name_lower, display_key, prop_key, prop_value, raw_line, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
        ).map_err(|e| format!("预处理 line_fam_property 失败: {}", e))?;
        for p in &fam_props {
            stmt.execute(params![pid, p.source_path, p.normalized_path, p.file_name_lower, p.display_key, p.prop_key, p.prop_value, p.raw_line, p.sort_order, now])
                .map_err(|e| format!("插入 line_fam_property 失败: {}", e))?;
        }
    }

    // 7. line_dev_property（prepared statement）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO line_dev_property (project_id, source_path, normalized_path, file_name_lower, prop_key, prop_value, raw_line, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        ).map_err(|e| format!("预处理 line_dev_property 失败: {}", e))?;
        for p in &dev_props {
            stmt.execute(params![pid, p.source_path, p.normalized_path, p.file_name_lower, p.prop_key, p.prop_value, p.raw_line, p.sort_order, now])
                .map_err(|e| format!("插入 line_dev_property 失败: {}", e))?;
        }
    }

    // 8. 更新 gim_project: parser_version = v5, project_type = transmission_line
    let project_type = if graph_payload.project_type.is_empty() {
        "transmission_line".to_string()
    } else {
        graph_payload.project_type.clone()
    };
    tx.execute(
        "UPDATE gim_project SET parser_version = ?1, project_type = ?2, updated_at_ms = ?3 WHERE id = ?4",
        params![PARSER_VERSION, project_type, now, pid],
    )
    .map_err(|e| format!("更新 project_type/parser_version 失败: {}", e))?;

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
    /// v5: 归一化后的引用值
    pub normalized_ref_value: Option<String>,
    /// v5: 引用值的文件名小写
    pub file_name_lower: Option<String>,
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

    // 3. line_cbm_ref（v5: 同时读取 normalized_ref_value / file_name_lower）
    let mut stmt = conn
        .prepare("SELECT node_path, ref_kind, ref_key, ref_value, sort_order, normalized_ref_value, file_name_lower FROM line_cbm_ref WHERE project_id = ?1 ORDER BY node_path ASC, ref_kind ASC, sort_order ASC, id ASC")
        .map_err(|e| format!("预处理 line_cbm_ref 失败: {}", e))?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(LineCbmRefRecord {
            node_path: row.get(0)?,
            ref_kind: row.get(1)?,
            ref_key: row.get(2)?,
            ref_value: row.get(3)?,
            sort_order: row.get(4)?,
            normalized_ref_value: row.get(5)?,
            file_name_lower: row.get(6)?,
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

// ===== v5: 线路工程 FAM/DEV 属性读取 =====

/// line_fam_property 读取记录
#[derive(Debug, Serialize)]
pub struct LineFamPropertyRecord {
    pub source_path: String,
    pub normalized_path: String,
    pub file_name_lower: String,
    pub display_key: Option<String>,
    pub prop_key: String,
    pub prop_value: Option<String>,
    pub raw_line: Option<String>,
    pub sort_order: i64,
}

/// line_dev_property 读取记录
#[derive(Debug, Serialize)]
pub struct LineDevPropertyRecord {
    pub source_path: String,
    pub normalized_path: String,
    pub file_name_lower: String,
    pub prop_key: String,
    pub prop_value: Option<String>,
    pub raw_line: Option<String>,
    pub sort_order: i64,
}

/// 线路工程 FAM/DEV 属性读取结果
#[derive(Debug, Serialize)]
pub struct LineAttributeResult {
    pub fam_properties: Vec<LineFamPropertyRecord>,
    pub dev_properties: Vec<LineDevPropertyRecord>,
}

/// Tauri command：读取线路工程 FAM/DEV 属性缓存（只读）
///
/// 二次打开线路 GIM（缓存命中）时调用，配合 get_line_gim_graph 恢复全部状态。
#[tauri::command]
pub fn get_line_attributes(
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<LineAttributeResult, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;

    // 1. line_fam_property
    let mut stmt = conn
        .prepare("SELECT source_path, normalized_path, file_name_lower, display_key, prop_key, prop_value, raw_line, sort_order FROM line_fam_property WHERE project_id = ?1 ORDER BY normalized_path ASC, prop_key ASC, sort_order ASC")
        .map_err(|e| format!("预处理 line_fam_property 失败: {}", e))?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(LineFamPropertyRecord {
            source_path: row.get(0)?,
            normalized_path: row.get(1)?,
            file_name_lower: row.get(2)?,
            display_key: row.get(3)?,
            prop_key: row.get(4)?,
            prop_value: row.get(5)?,
            raw_line: row.get(6)?,
            sort_order: row.get(7)?,
        })
    }).map_err(|e| format!("查询 line_fam_property 失败: {}", e))?;
    let mut fam_properties = Vec::new();
    for r in rows { fam_properties.push(r.map_err(|e| format!("读取 line_fam_property 失败: {}", e))?); }

    // 2. line_dev_property
    let mut stmt = conn
        .prepare("SELECT source_path, normalized_path, file_name_lower, prop_key, prop_value, raw_line, sort_order FROM line_dev_property WHERE project_id = ?1 ORDER BY normalized_path ASC, prop_key ASC, sort_order ASC")
        .map_err(|e| format!("预处理 line_dev_property 失败: {}", e))?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(LineDevPropertyRecord {
            source_path: row.get(0)?,
            normalized_path: row.get(1)?,
            file_name_lower: row.get(2)?,
            prop_key: row.get(3)?,
            prop_value: row.get(4)?,
            raw_line: row.get(5)?,
            sort_order: row.get(6)?,
        })
    }).map_err(|e| format!("查询 line_dev_property 失败: {}", e))?;
    let mut dev_properties = Vec::new();
    for r in rows { dev_properties.push(r.map_err(|e| format!("读取 line_dev_property 失败: {}", e))?); }

    Ok(LineAttributeResult {
        fam_properties,
        dev_properties,
    })
}

/// v5: 线路工程 FAM/DEV 属性缓存诊断结果（内部辅助结构，供 validate/diagnostic 共用）
#[derive(Debug, Clone, Default)]
struct LineAttrDiagnostic {
    fam_source_count: u64,
    dev_source_count: u64,
    expected_fam_ref_count: u64,
    expected_dev_ref_count: u64,
    missing_fam_sources: Vec<String>,
    missing_dev_sources: Vec<String>,
}

/// v5: 计算线路工程 FAM/DEV 属性缓存诊断字段
///
/// 统一键空间为 file_name_lower（裸文件名小写）。line_cbm_ref 中的引用通常是裸文件名
/// （如 `43cf81da-...f159.fam`），而 line_fam_property/line_dev_property 中的 normalized_path
/// 是完整路径（如 `Cbm/43cf81da-...f159.fam`）。若用 normalized_ref_value 与 normalized_path
/// 做差集会因键空间不一致而误报缺失，故 expected/actual/missing 全部改用 file_name_lower 统一比较。
///
/// - fam/dev source count：line_fam_property / line_dev_property 中 file_name_lower 去重数量
/// - expected fam/dev ref count：line_cbm_ref 中 ref_kind=famFiles/devFiles 且 file_name_lower 非空的去重数量
/// - missing fam/dev sources：图引用中存在但属性表缺失的 file_name_lower 列表
fn compute_line_attr_diagnostic(conn: &Connection, project_id: i64) -> Result<LineAttrDiagnostic, String> {
    use std::collections::HashSet;

    // 1. fam source count (DISTINCT file_name_lower in line_fam_property)
    let fam_source_count: u64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT file_name_lower) FROM line_fam_property WHERE project_id = ?1",
            params![project_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0i64) as u64;

    // 2. dev source count
    let dev_source_count: u64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT file_name_lower) FROM line_dev_property WHERE project_id = ?1",
            params![project_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0i64) as u64;

    // 3. expected fam refs (DISTINCT file_name_lower where ref_kind=famFiles)
    let mut expected_fam_refs: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT file_name_lower FROM line_cbm_ref
                 WHERE project_id = ?1 AND ref_kind = 'famFiles' AND file_name_lower IS NOT NULL",
            )
            .map_err(|e| format!("预处理 fam refs 失败: {}", e))?;
        let rows = stmt
            .query_map(params![project_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("查询 fam refs 失败: {}", e))?;
        for r in rows {
            expected_fam_refs.push(r.map_err(|e| format!("读取 fam refs 失败: {}", e))?);
        }
    }

    // 4. expected dev refs
    let mut expected_dev_refs: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT file_name_lower FROM line_cbm_ref
                 WHERE project_id = ?1 AND ref_kind = 'devFiles' AND file_name_lower IS NOT NULL",
            )
            .map_err(|e| format!("预处理 dev refs 失败: {}", e))?;
        let rows = stmt
            .query_map(params![project_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("查询 dev refs 失败: {}", e))?;
        for r in rows {
            expected_dev_refs.push(r.map_err(|e| format!("读取 dev refs 失败: {}", e))?);
        }
    }

    // 5. fam file_name_lower set (actual cached sources, for missing detection)
    let mut fam_paths: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn
            .prepare("SELECT DISTINCT file_name_lower FROM line_fam_property WHERE project_id = ?1")
            .map_err(|e| format!("预处理 fam paths 失败: {}", e))?;
        let rows = stmt
            .query_map(params![project_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("查询 fam paths 失败: {}", e))?;
        for r in rows {
            fam_paths.insert(r.map_err(|e| format!("读取 fam paths 失败: {}", e))?);
        }
    }

    // 6. dev file_name_lower set
    let mut dev_paths: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn
            .prepare("SELECT DISTINCT file_name_lower FROM line_dev_property WHERE project_id = ?1")
            .map_err(|e| format!("预处理 dev paths 失败: {}", e))?;
        let rows = stmt
            .query_map(params![project_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("查询 dev paths 失败: {}", e))?;
        for r in rows {
            dev_paths.insert(r.map_err(|e| format!("读取 dev paths 失败: {}", e))?);
        }
    }

    // 7. missing fam sources: expected file_name_lower not in fam_paths (sorted)
    let mut missing_fam: Vec<String> = expected_fam_refs
        .iter()
        .filter(|r| !fam_paths.contains(*r))
        .cloned()
        .collect();
    missing_fam.sort();

    // 8. missing dev sources
    let mut missing_dev: Vec<String> = expected_dev_refs
        .iter()
        .filter(|r| !dev_paths.contains(*r))
        .cloned()
        .collect();
    missing_dev.sort();

    Ok(LineAttrDiagnostic {
        fam_source_count,
        dev_source_count,
        expected_fam_ref_count: expected_fam_refs.len() as u64,
        expected_dev_ref_count: expected_dev_refs.len() as u64,
        missing_fam_sources: missing_fam,
        missing_dev_sources: missing_dev,
    })
}

/// Tauri command：校验 GIM 缓存完整性（只读，不修复）
///
/// v4 增强：根据 project_type 分支校验逻辑
/// - transmission_line：valid = parser_version_match && line_cbm_node_count > 0
/// - substation（或 null/unknown）：保持原有 IFC/cache 校验逻辑
///
/// v5 增强（transmission_line 分支）：
/// - valid 增加 line_fam_source_count > 0 条件（FAM 属性必须存在）
/// - 输出 line_dev_source_count / line_expected_fam_ref_count / missing_* 诊断字段
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
    // v5: transmission_line 增加 line_fam_source_count > 0 条件
    // substation（或 null/unknown）：保持原有 IFC/cache 校验逻辑
    let is_line = project_type.as_deref() == Some("transmission_line");

    // v5: 线路工程计算 FAM/DEV 属性诊断字段（非线路工程返回全零/空，不影响结果）
    let line_attr_diag = if is_line {
        compute_line_attr_diagnostic(&conn, project_id)?
    } else {
        LineAttrDiagnostic::default()
    };

    let (ifc_entry_count, cached_ifc_count, missing_cache_paths, valid) = if is_line {
        // 线路工程：不检查 IFC 缓存；v5 要求 FAM 属性源存在
        let valid = parser_version_match
            && line_cbm_node_count > 0
            && line_attr_diag.fam_source_count > 0;
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
        // v5: 线路工程 FAM/DEV 属性诊断字段
        line_fam_source_count: line_attr_diag.fam_source_count,
        line_dev_source_count: line_attr_diag.dev_source_count,
        line_expected_fam_ref_count: line_attr_diag.expected_fam_ref_count,
        line_expected_dev_ref_count: line_attr_diag.expected_dev_ref_count,
        missing_line_fam_sources: line_attr_diag.missing_fam_sources,
        missing_line_dev_sources: line_attr_diag.missing_dev_sources,
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

    // v4: 线路工程图缓存诊断
    pub project_type: Option<String>,
    pub line_cbm_node_count: u64,
    pub line_cbm_child_count: u64,
    pub line_cbm_ref_count: u64,
    pub line_file_stat_count: u64,

    // v5: 线路工程 FAM/DEV 属性缓存诊断
    pub line_fam_property_count: u64,
    pub line_dev_property_count: u64,
    pub line_fam_source_count: u64,
    pub line_dev_source_count: u64,
    pub line_expected_fam_ref_count: u64,
    pub line_expected_dev_ref_count: u64,
    pub missing_line_fam_sources: Vec<String>,
    pub missing_line_dev_sources: Vec<String>,
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

    // 1. 查询 gim_project 基本信息（含 parser_version、project_type）
    let project = conn
        .query_row(
            "SELECT id, path, name, size, modified_ms, sha256, parser_version, project_type FROM gim_project WHERE id = ?1",
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
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .map_err(|e| format!("查询项目失败: {}", e))?;

    let parser_version_match = project.6.as_deref() == Some(PARSER_VERSION);
    let project_type = project.7.clone();

    // 2. 统计索引表数量
    let entries_count = count_rows(&conn, "gim_entry", project_id)?;
    let cbm_nodes_count = count_rows(&conn, "cbm_node", project_id)?;
    let ifc_models_count = count_rows(&conn, "ifc_model", project_id)?;
    let file_dev_entries_count = count_rows(&conn, "file_dev_entry", project_id)?;
    let fam_properties_count = count_rows(&conn, "fam_property", project_id)?;
    let dev_properties_count = count_rows(&conn, "dev_property", project_id)?;
    // v4: 线路工程图缓存表统计
    let line_cbm_node_count = count_rows(&conn, "line_cbm_node", project_id)?;
    let line_cbm_child_count = count_rows(&conn, "line_cbm_child", project_id)?;
    let line_cbm_ref_count = count_rows(&conn, "line_cbm_ref", project_id)?;
    let line_file_stat_count = count_rows(&conn, "line_file_stat", project_id)?;
    // v5: 线路工程 FAM/DEV 属性表统计
    let line_fam_property_count = count_rows(&conn, "line_fam_property", project_id)?;
    let line_dev_property_count = count_rows(&conn, "line_dev_property", project_id)?;
    let has_index = cbm_nodes_count > 0 || ifc_models_count > 0 || line_cbm_node_count > 0;

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

    // v4: 根据 project_type 分支 valid 判断
    // v5: transmission_line 增加 line_fam_source_count > 0 条件
    // - substation（或 null/unknown）：保持原有 IFC 缓存校验逻辑
    let is_line = project_type.as_deref() == Some("transmission_line");
    // v5: 线路工程计算 FAM/DEV 属性诊断字段
    let line_attr_diag = if is_line {
        compute_line_attr_diagnostic(&conn, project_id)?
    } else {
        LineAttrDiagnostic::default()
    };
    let valid = if is_line {
        parser_version_match
            && line_cbm_node_count > 0
            && line_attr_diag.fam_source_count > 0
    } else {
        has_index
            && ifc_models_count > 0
            && ifc_entry_count > 0
            && cached_ifc_count == ifc_entry_count
            && missing_cache_paths.is_empty()
            && parser_version_match
    };

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
        // v4: 线路工程图缓存诊断
        project_type,
        line_cbm_node_count: line_cbm_node_count as u64,
        line_cbm_child_count: line_cbm_child_count as u64,
        line_cbm_ref_count: line_cbm_ref_count as u64,
        line_file_stat_count: line_file_stat_count as u64,
        // v5: 线路工程 FAM/DEV 属性缓存诊断
        line_fam_property_count: line_fam_property_count as u64,
        line_dev_property_count: line_dev_property_count as u64,
        line_fam_source_count: line_attr_diag.fam_source_count,
        line_dev_source_count: line_attr_diag.dev_source_count,
        line_expected_fam_ref_count: line_attr_diag.expected_fam_ref_count,
        line_expected_dev_ref_count: line_attr_diag.expected_dev_ref_count,
        missing_line_fam_sources: line_attr_diag.missing_fam_sources,
        missing_line_dev_sources: line_attr_diag.missing_dev_sources,
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

/// 缓存项目摘要（用于缓存管理 UI 列表）
#[derive(Debug, Serialize)]
pub struct CachedProjectSummary {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub project_type: Option<String>,
    pub parser_version: Option<String>,
    pub size: u64,
    pub modified_ms: u64,
    pub updated_at_ms: u64,
}

/// 列出所有缓存的项目（只读，按最近打开排序）
#[tauri::command]
pub fn list_cached_projects(state: tauri::State<'_, DbState>) -> Result<Vec<CachedProjectSummary>, String> {
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, path, project_type, parser_version, size, modified_ms, updated_at_ms
             FROM gim_project ORDER BY last_opened_at_ms DESC",
        )
        .map_err(|e| format!("查询项目列表失败: {}", e))?;
    let projects = stmt
        .query_map([], |row| {
            Ok(CachedProjectSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                project_type: row.get(3)?,
                parser_version: row.get(4)?,
                size: row.get(5)?,
                modified_ms: row.get(6)?,
                updated_at_ms: row.get(7)?,
            })
        })
        .map_err(|e| format!("映射项目列表失败: {}", e))?;
    let result = projects
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集项目列表失败: {}", e))?;
    Ok(result)
}

/// 删除指定项目的全部缓存（DB 记录 + 磁盘文件）
///
/// 级联删除 13 张索引表 + gim_project 记录，并尝试删除磁盘缓存目录。
/// 磁盘文件删除为 best-effort，失败不影响 DB 清理。
#[tauri::command]
pub fn delete_project_cache(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<String, String> {
    let mut conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;

    // 级联删除所有索引表（变电 6 张 + 线路 6 张 + fragments 1 张）
    for table in &[
        "gim_entry",
        "cbm_node",
        "ifc_model",
        "file_dev_entry",
        "fam_property",
        "dev_property",
        "line_cbm_node",
        "line_cbm_child",
        "line_cbm_ref",
        "line_file_stat",
        "line_fam_property",
        "line_dev_property",
        "fragment_cache",
    ] {
        let sql = format!("DELETE FROM {} WHERE project_id = ?1", table);
        tx.execute(&sql, params![project_id])
            .map_err(|e| format!("清理 {} 失败: {}", table, e))?;
    }

    // 删除项目记录
    let deleted = tx
        .execute("DELETE FROM gim_project WHERE id = ?1", params![project_id])
        .map_err(|e| format!("删除 gim_project 失败: {}", e))?;
    if deleted == 0 {
        return Err(format!("项目 {} 不存在或已被删除", project_id));
    }

    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;

    // 尝试删除磁盘缓存目录（best-effort）
    let mut disk_messages: Vec<String> = Vec::new();
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app_data_dir 失败: {}", e))?;

    // IFC 缓存目录: app_data_dir/extracted/{project_id}/
    let ifc_dir = app_dir.join("extracted").join(project_id.to_string());
    if ifc_dir.exists() {
        match stdfs::remove_dir_all(&ifc_dir) {
            Ok(()) => disk_messages.push("IFC 磁盘缓存已删除".to_string()),
            Err(e) => disk_messages.push(format!("IFC 磁盘缓存删除失败（需后续手动清理）: {}", e)),
        }
    }

    // Fragments 缓存目录: app_data_dir/fragments/{project_id}/
    let frag_dir = app_dir.join("fragments").join(project_id.to_string());
    if frag_dir.exists() {
        match stdfs::remove_dir_all(&frag_dir) {
            Ok(()) => disk_messages.push("Fragments 磁盘缓存已删除".to_string()),
            Err(e) => disk_messages.push(format!("Fragments 磁盘缓存删除失败: {}", e)),
        }
    }

    let summary = if disk_messages.is_empty() {
        format!("项目 {} 缓存已清除（数据库记录 + 磁盘文件均无残留）", project_id)
    } else {
        format!(
            "项目 {} 数据库记录已清除。{}",
            project_id,
            disk_messages.join("；")
        )
    };
    Ok(summary)
}

// ===== 几何引用链批量写入（v6） =====

/// DEV SOLIDMODEL 批量写入 payload
#[derive(Debug, Deserialize)]
pub struct DevSolidModelPayload {
    pub dev_path: String,
    pub solid_model_path: String,
    pub transform_matrix: Option<String>,
    pub sort_order: i64,
}

/// DEV SUBDEVICE 批量写入 payload
#[derive(Debug, Deserialize)]
pub struct DevSubDevicePayload {
    pub dev_path: String,
    pub child_dev_path: String,
    pub transform_matrix: Option<String>,
    pub sort_order: i64,
}

/// PHM SOLIDMODEL 批量写入 payload
#[derive(Debug, Deserialize)]
pub struct PhmSolidModelPayload {
    pub phm_path: String,
    pub solid_model_path: String,
    pub transform_matrix: Option<String>,
    pub color: Option<String>,
    pub sort_order: i64,
}

/// 几何引用链完整 payload（一次事务写入三张表）
#[derive(Debug, Deserialize)]
pub struct GeometryRefsPayload {
    pub project_id: i64,
    pub dev_solid_models: Vec<DevSolidModelPayload>,
    pub dev_sub_devices: Vec<DevSubDevicePayload>,
    pub phm_solid_models: Vec<PhmSolidModelPayload>,
}

/// 批量写入 DEV/PHM 几何引用链到 SQLite。
///
/// 在 save_gim_index 之后调用，解析 DEV/PHM 文件后将其 SOLIDMODEL / SUBDEVICE
/// 引用写入三张缓存表。缓存命中时可直接查询这些表来发现 MOD/STL 几何源，
/// 无需逐文件读取数千个 DEV/PHM。
#[tauri::command]
pub fn save_geometry_refs(
    state: tauri::State<'_, DbState>,
    payload: GeometryRefsPayload,
) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    let pid = payload.project_id;

    // 1. 清空旧数据
    tx.execute("DELETE FROM dev_solid_model WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 dev_solid_model 失败: {}", e))?;
    tx.execute("DELETE FROM dev_sub_device WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 dev_sub_device 失败: {}", e))?;
    tx.execute("DELETE FROM phm_solid_model WHERE project_id = ?1", params![pid])
        .map_err(|e| format!("清理 phm_solid_model 失败: {}", e))?;

    // 2. dev_solid_model（DEV SOLIDMODEL → PHM）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO dev_solid_model (project_id, dev_path, solid_model_path, transform_matrix, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        ).map_err(|e| format!("预处理 dev_solid_model 失败: {}", e))?;
        for sm in &payload.dev_solid_models {
            stmt.execute(params![pid, sm.dev_path, sm.solid_model_path, sm.transform_matrix, sm.sort_order, now])
                .map_err(|e| format!("插入 dev_solid_model 失败: {}", e))?;
        }
    }

    // 3. dev_sub_device（DEV SUBDEVICE → child DEV）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO dev_sub_device (project_id, dev_path, child_dev_path, transform_matrix, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        ).map_err(|e| format!("预处理 dev_sub_device 失败: {}", e))?;
        for sd in &payload.dev_sub_devices {
            stmt.execute(params![pid, sd.dev_path, sd.child_dev_path, sd.transform_matrix, sd.sort_order, now])
                .map_err(|e| format!("插入 dev_sub_device 失败: {}", e))?;
        }
    }

    // 4. phm_solid_model（PHM SOLIDMODEL → MOD/STL）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO phm_solid_model (project_id, phm_path, solid_model_path, transform_matrix, color, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
        ).map_err(|e| format!("预处理 phm_solid_model 失败: {}", e))?;
        for sm in &payload.phm_solid_models {
            stmt.execute(params![pid, sm.phm_path, sm.solid_model_path, sm.transform_matrix, sm.color, sm.sort_order, now])
                .map_err(|e| format!("插入 phm_solid_model 失败: {}", e))?;
        }
    }

    tx.commit().map_err(|e| format!("提交几何引用链事务失败: {}", e))?;
    Ok(())
}

/// 可到达的几何源（MOD/STL 路径 + 其变换矩阵来源）
#[derive(Debug, Serialize)]
pub struct ReachableGeometry {
    /// MOD/STL 文件路径（如 "MOD/abc.mod"）
    pub geometry_path: String,
    /// 几何实例唯一键。同一 MOD/STL 文件可被不同矩阵多次实例化。
    pub instance_key: String,
    /// CBM/DEV/SUBDEVICE/PHM 累积放置矩阵（列主序 16 值，逗号分隔）
    pub placement_transform_matrix: Option<String>,
    /// DEV SOLIDMODEL 的 TRANSFORMMATRIX（列主序 16 值，逗号分隔）
    pub dev_transform_matrix: Option<String>,
    /// PHM SOLIDMODEL 的 TRANSFORMMATRIX（列主序 16 值，逗号分隔）
    pub phm_transform_matrix: Option<String>,
    /// PHM COLORn 原始串（如 "128,128,128,100"）
    pub phm_color: Option<String>,
}

#[derive(Clone)]
struct CbmGeometryNode {
    parent_key: Option<String>,
    entity_name: Option<String>,
    dev_path: Option<String>,
    local_matrix: [f64; 16],
}

/// 查询项目中可从 CBM 到达的 MOD/STL 几何源。
///
/// 沿引用链查询：cbm_node.dev_path → dev_solid_model → phm_solid_model，
/// 以及 cbm_node.dev_path → dev_sub_device → dev_solid_model → phm_solid_model。
///
/// 一次 SQL 查询替代数千次逐个文件 I/O。
///
/// - include_mod（默认 true）：返回 .mod 文件
/// - include_stl（默认 false）：返回 .stl 文件
#[tauri::command]
pub fn get_reachable_geometry(
    state: tauri::State<'_, DbState>,
    project_id: i64,
    include_mod: Option<bool>,
    include_stl: Option<bool>,
) -> Result<Vec<ReachableGeometry>, String> {
    use std::time::Instant;

    let total_t0 = Instant::now();
    let include_mod = include_mod.unwrap_or(true);
    let include_stl = include_stl.unwrap_or(false);

    eprintln!(
        "[get_reachable_geometry] start project_id={} include_mod={} include_stl={}",
        project_id, include_mod, include_stl
    );

    // 快速短路：两个都 false 直接返回空
    if !include_mod && !include_stl {
        eprintln!("[get_reachable_geometry] done total=0ms rows=0 (both false)");
        return Ok(Vec::new());
    }

    let lock_t0 = Instant::now();
    let conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
    eprintln!(
        "[get_reachable_geometry] lock acquired: {}ms",
        lock_t0.elapsed().as_millis()
    );

    let results = query_reachable_geometry(&conn, project_id, include_mod, include_stl)?;

    eprintln!(
        "[get_reachable_geometry] done total={}ms rows={} include_mod={} include_stl={}",
        total_t0.elapsed().as_millis(),
        results.len(),
        include_mod,
        include_stl
    );

    Ok(results)
}

fn query_reachable_geometry(
    conn: &Connection,
    project_id: i64,
    include_mod: bool,
    include_stl: bool,
) -> Result<Vec<ReachableGeometry>, String> {
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::time::Instant;

    // Avoid SQLite recursive CTEs / multi-table joins here. In the app this
    // command runs while rendering is active, and SQLite may spend a long time
    // materializing a join before yielding the first row. The indexed tables are
    // small enough to join deterministically in Rust.
    let cbm_t0 = Instant::now();
    let mut cbm_stmt = conn
        .prepare(
            "SELECT node_key, parent_key, entity_name, dev_path, transform_matrix
             FROM cbm_node
             WHERE project_id = ?1",
        )
        .map_err(|e| format!("预处理 cbm_node dev_path 失败: {}", e))?;
    let cbm_rows = cbm_stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| format!("查询 cbm_node dev_path 失败: {}", e))?;
    let mut cbm_nodes: HashMap<String, CbmGeometryNode> = HashMap::new();
    for row in cbm_rows {
        let (node_key, parent_key, entity_name, dev_path, transform_matrix) =
            row.map_err(|e| format!("读取 cbm_node 行失败: {}", e))?;
        cbm_nodes.insert(node_key, CbmGeometryNode {
            parent_key,
            entity_name,
            dev_path,
            local_matrix: parse_matrix_opt(transform_matrix.as_deref()),
        });
    }

    let mut dev_instances: HashMap<String, Vec<[f64; 16]>> = HashMap::new();
    let mut dev_instance_seen: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<(String, [f64; 16])> = VecDeque::new();

    let mut cbm_matrix_cache: HashMap<String, [f64; 16]> = HashMap::new();
    for (node_key, node) in &cbm_nodes {
        let Some(dev_path_raw) = node.dev_path.as_deref() else {
            continue;
        };
        if dev_path_raw.trim().is_empty() {
            continue;
        }
        if is_virtual_dev_subdevice(node.entity_name.as_deref()) {
            continue;
        }
        let dev_path = normalize_dev_path(dev_path_raw);
        let matrix = cumulative_cbm_matrix(node_key, &cbm_nodes, &mut cbm_matrix_cache, &mut HashSet::new());
        let key = make_matrix_instance_key(&dev_path, &matrix);
        if dev_instance_seen.insert(key) {
            dev_instances.entry(dev_path.clone()).or_default().push(matrix);
            queue.push_back((dev_path, matrix));
        }
    }
    eprintln!(
        "[get_reachable_geometry] cbm dev instances: {}ms devs={} instances={}",
        cbm_t0.elapsed().as_millis(),
        dev_instances.len(),
        dev_instance_seen.len()
    );

    let sub_t0 = Instant::now();
    let mut sub_edges: HashMap<String, Vec<(String, [f64; 16])>> = HashMap::new();
    let mut sub_stmt = conn
        .prepare(
            "SELECT dev_path, child_dev_path, transform_matrix
             FROM dev_sub_device
             WHERE project_id = ?1",
        )
        .map_err(|e| format!("预处理 dev_sub_device 失败: {}", e))?;
    let sub_rows = sub_stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| format!("查询 dev_sub_device 失败: {}", e))?;
    for row in sub_rows {
        let (parent, child, transform_matrix) =
            row.map_err(|e| format!("读取 dev_sub_device 行失败: {}", e))?;
        sub_edges
            .entry(normalize_dev_path(&parent))
            .or_default()
            .push((normalize_dev_path(&child), parse_matrix_opt(transform_matrix.as_deref())));
    }

    let mut child_count = 0usize;
    while let Some((parent_dev, parent_matrix)) = queue.pop_front() {
        if let Some(children) = sub_edges.get(&parent_dev) {
            for (child_dev, child_local_matrix) in children {
                let child_matrix = multiply_matrices(&parent_matrix, child_local_matrix);
                let key = make_matrix_instance_key(child_dev, &child_matrix);
                if dev_instance_seen.insert(key) {
                    dev_instances.entry(child_dev.clone()).or_default().push(child_matrix);
                    queue.push_back((child_dev.clone(), child_matrix));
                    child_count += 1;
                }
            }
        }
    }
    eprintln!(
        "[get_reachable_geometry] sub devices: {}ms child_added={} reachable_devs={} instances={}",
        sub_t0.elapsed().as_millis(),
        child_count,
        dev_instances.len(),
        dev_instance_seen.len()
    );

    let dsm_t0 = Instant::now();
    let mut phm_refs: Vec<(String, [f64; 16], Option<String>)> = Vec::new();
    let mut dsm_stmt = conn
        .prepare(
            "SELECT dev_path, solid_model_path, transform_matrix
             FROM dev_solid_model
             WHERE project_id = ?1",
        )
        .map_err(|e| format!("预处理 dev_solid_model 失败: {}", e))?;
    let dsm_rows = dsm_stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| format!("查询 dev_solid_model 失败: {}", e))?;
    let mut dsm_count = 0usize;
    for row in dsm_rows {
        let (dev_path, solid_model_path, transform_matrix) =
            row.map_err(|e| format!("读取 dev_solid_model 行失败: {}", e))?;
        let dev_path = normalize_dev_path(&dev_path);
        if let Some(instances) = dev_instances.get(&dev_path) {
            let solid_matrix = parse_matrix_opt(transform_matrix.as_deref());
            for base_matrix in instances {
                phm_refs.push((
                    normalize_phm_path(&solid_model_path),
                    multiply_matrices(base_matrix, &solid_matrix),
                    transform_matrix.clone(),
                ));
                dsm_count += 1;
            }
        }
    }
    eprintln!(
        "[get_reachable_geometry] dev solid model refs: {}ms rows={}",
        dsm_t0.elapsed().as_millis(),
        dsm_count
    );

    let psm_t0 = Instant::now();
    let mut phm_to_geometry: HashMap<String, Vec<(String, Option<String>, Option<String>)>> = HashMap::new();
    let mut psm_stmt = conn
        .prepare(
            "SELECT phm_path, solid_model_path, transform_matrix, color
             FROM phm_solid_model
             WHERE project_id = ?1",
        )
        .map_err(|e| format!("预处理 phm_solid_model 失败: {}", e))?;
    let psm_rows = psm_stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| format!("查询 phm_solid_model 失败: {}", e))?;
    let mut psm_count = 0usize;
    for row in psm_rows {
        let (phm_path, solid_model_path, transform_matrix, color) =
            row.map_err(|e| format!("读取 phm_solid_model 行失败: {}", e))?;
        let lower = solid_model_path.to_ascii_lowercase();
        if (include_mod && lower.ends_with(".mod")) || (include_stl && lower.ends_with(".stl")) {
            phm_to_geometry
                .entry(normalize_phm_path(&phm_path))
                .or_default()
                .push((normalize_geometry_path(&solid_model_path), transform_matrix, color));
            psm_count += 1;
        }
    }
    eprintln!(
        "[get_reachable_geometry] phm solid models: {}ms rows={}",
        psm_t0.elapsed().as_millis(),
        psm_count
    );

    let collect_t0 = Instant::now();
    let mut results = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (phm_path, dev_placement_matrix, dev_transform_matrix) in phm_refs {
        if let Some(geometries) = phm_to_geometry.get(&phm_path) {
            for (geometry_path, phm_transform_matrix, phm_color) in geometries {
                let phm_matrix = parse_matrix_opt(phm_transform_matrix.as_deref());
                let placement_matrix = multiply_matrices(&dev_placement_matrix, &phm_matrix);
                let placement_transform_matrix = matrix_to_string(&placement_matrix);
                let key = format!(
                    "{}\u{1f}{}\u{1f}{}",
                    geometry_path,
                    placement_transform_matrix,
                    phm_color.as_deref().unwrap_or("")
                );
                if seen.insert(key) {
                    results.push(ReachableGeometry {
                        geometry_path: geometry_path.clone(),
                        instance_key: format!("{}#{}", geometry_path, placement_transform_matrix),
                        placement_transform_matrix: Some(placement_transform_matrix),
                        dev_transform_matrix: dev_transform_matrix.clone(),
                        phm_transform_matrix: phm_transform_matrix.clone(),
                        phm_color: phm_color.clone(),
                    });
                }
            }
        }
    }
    results.sort_by(|a, b| a.geometry_path.cmp(&b.geometry_path));
    eprintln!(
        "[get_reachable_geometry] collect rows: {}ms rows={}",
        collect_t0.elapsed().as_millis(),
        results.len()
    );

    Ok(results)
}

fn identity_matrix() -> [f64; 16] {
    [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
}

fn parse_matrix_opt(raw: Option<&str>) -> [f64; 16] {
    let Some(raw) = raw else {
        return identity_matrix();
    };
    let values: Vec<f64> = raw
        .split(',')
        .map(|part| part.trim().parse::<f64>())
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();
    if values.len() != 16 || values.iter().any(|v| !v.is_finite()) {
        return identity_matrix();
    }

    let mut matrix = [0.0; 16];
    matrix.copy_from_slice(&values);
    matrix
}

fn multiply_matrices(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    let mut out = [0.0; 16];
    // Three.js Matrix4 uses column-major storage. This computes out = a * b.
    for col in 0..4 {
        for row in 0..4 {
            out[col * 4 + row] =
                a[0 * 4 + row] * b[col * 4 + 0] +
                a[1 * 4 + row] * b[col * 4 + 1] +
                a[2 * 4 + row] * b[col * 4 + 2] +
                a[3 * 4 + row] * b[col * 4 + 3];
        }
    }
    out
}

fn matrix_to_string(matrix: &[f64; 16]) -> String {
    matrix
        .iter()
        .map(|v| format!("{:.6}", v))
        .collect::<Vec<_>>()
        .join(",")
}

fn make_matrix_instance_key(dev_path: &str, matrix: &[f64; 16]) -> String {
    format!("{}\u{1f}{}", dev_path, matrix_to_string(matrix))
}

fn is_virtual_dev_subdevice(entity_name: Option<&str>) -> bool {
    entity_name
        .map(|name| name.eq_ignore_ascii_case("DEV_SUBDEVICE"))
        .unwrap_or(false)
}

fn cumulative_cbm_matrix(
    node_key: &str,
    nodes: &std::collections::HashMap<String, CbmGeometryNode>,
    cache: &mut std::collections::HashMap<String, [f64; 16]>,
    visiting: &mut std::collections::HashSet<String>,
) -> [f64; 16]
{
    if let Some(matrix) = cache.get(node_key) {
        return *matrix;
    }
    if !visiting.insert(node_key.to_string()) {
        return identity_matrix();
    }

    let Some(node) = nodes.get(node_key) else {
        visiting.remove(node_key);
        return identity_matrix();
    };

    let parent_matrix = node
        .parent_key
        .as_deref()
        .and_then(|parent_key| nodes.get(parent_key).map(|_| parent_key.to_string()))
        .map(|parent_key| cumulative_cbm_matrix(&parent_key, nodes, cache, visiting))
        .unwrap_or_else(identity_matrix);
    let matrix = multiply_matrices(&parent_matrix, &node.local_matrix);
    cache.insert(node_key.to_string(), matrix);
    visiting.remove(node_key);
    matrix
}

fn normalize_dev_path(path: &str) -> String {
    normalize_prefixed_path(path, "DEV")
}

fn normalize_phm_path(path: &str) -> String {
    normalize_prefixed_path(path, "PHM")
}

fn normalize_geometry_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    if lower.starts_with("mod/") || lower.starts_with("stl/") {
        normalized
    } else {
        format!("MOD/{}", normalized)
    }
}

fn normalize_prefixed_path(path: &str, prefix: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    let expected = format!("{}/", prefix);
    if normalized.to_ascii_lowercase().starts_with(&expected.to_ascii_lowercase()) {
        format!("{}{}", expected, &normalized[expected.len()..])
    } else {
        format!("{}{}", expected, normalized)
    }
}

/// 获取指定项目的缓存诊断（供缓存管理 UI 使用）
///
/// 薄包装：复用已有的 get_project_cache_diagnostic 内部函数。
#[tauri::command]
pub fn get_project_diagnostic(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<ProjectCacheDiagnostic, String> {
    get_project_cache_diagnostic(&app_handle, state, project_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_geometry_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE cbm_node (
                project_id INTEGER NOT NULL,
                node_key TEXT NOT NULL,
                parent_key TEXT,
                entity_name TEXT,
                dev_path TEXT,
                transform_matrix TEXT
            );
            CREATE INDEX idx_cbm_node_project_dev ON cbm_node(project_id, dev_path);

            CREATE TABLE dev_solid_model (
                project_id INTEGER NOT NULL,
                dev_path TEXT NOT NULL,
                solid_model_path TEXT NOT NULL,
                transform_matrix TEXT,
                sort_order INTEGER NOT NULL
            );
            CREATE INDEX idx_dev_sm_dev ON dev_solid_model(project_id, dev_path);

            CREATE TABLE dev_sub_device (
                project_id INTEGER NOT NULL,
                dev_path TEXT NOT NULL,
                child_dev_path TEXT NOT NULL,
                transform_matrix TEXT,
                sort_order INTEGER NOT NULL
            );
            CREATE INDEX idx_dev_sub_dev ON dev_sub_device(project_id, dev_path);

            CREATE TABLE phm_solid_model (
                project_id INTEGER NOT NULL,
                phm_path TEXT NOT NULL,
                solid_model_path TEXT NOT NULL,
                transform_matrix TEXT,
                color TEXT,
                sort_order INTEGER NOT NULL
            );
            CREATE INDEX idx_phm_sm_phm ON phm_solid_model(project_id, phm_path);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn reachable_geometry_includes_direct_and_child_dev_paths() {
        let conn = setup_geometry_conn();
        conn.execute(
            "INSERT INTO cbm_node (project_id, node_key, parent_key, entity_name, dev_path, transform_matrix)
             VALUES
             (1, 'root', NULL, 'F4System', 'root.dev', NULL),
             (1, 'direct', NULL, 'F4System', 'direct.dev', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO dev_sub_device (project_id, dev_path, child_dev_path, sort_order)
             VALUES (1, 'DEV/root.dev', 'child.dev', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO dev_solid_model (project_id, dev_path, solid_model_path, transform_matrix, sort_order)
             VALUES
             (1, 'DEV/direct.dev', 'direct.phm', 'direct-tm', 0),
             (1, 'DEV/child.dev', 'child.phm', 'child-tm', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO phm_solid_model (project_id, phm_path, solid_model_path, transform_matrix, color, sort_order)
             VALUES
             (1, 'PHM/direct.phm', 'direct.mod', 'direct-phm-tm', NULL, 0),
             (1, 'PHM/child.phm', 'child.mod', 'child-phm-tm', '1,2,3,100', 0)",
            [],
        )
        .unwrap();

        let rows = query_reachable_geometry(&conn, 1, true, false).unwrap();
        let paths: Vec<_> = rows.iter().map(|r| r.geometry_path.as_str()).collect();
        assert_eq!(paths, vec!["MOD/child.mod", "MOD/direct.mod"]);
        assert_eq!(rows[0].dev_transform_matrix.as_deref(), Some("child-tm"));
        assert_eq!(rows[0].phm_color.as_deref(), Some("1,2,3,100"));
    }

    #[test]
    fn reachable_geometry_filters_mod_and_stl() {
        let conn = setup_geometry_conn();
        conn.execute(
            "INSERT INTO cbm_node (project_id, node_key, parent_key, entity_name, dev_path, transform_matrix)
             VALUES (1, 'device', NULL, 'F4System', 'device.dev', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO dev_solid_model (project_id, dev_path, solid_model_path, transform_matrix, sort_order)
             VALUES (1, 'DEV/device.dev', 'device.phm', NULL, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO phm_solid_model (project_id, phm_path, solid_model_path, transform_matrix, color, sort_order)
             VALUES
             (1, 'PHM/device.phm', 'a.mod', NULL, NULL, 0),
             (1, 'PHM/device.phm', 'b.stl', NULL, NULL, 1)",
            [],
        )
        .unwrap();

        let mod_rows = query_reachable_geometry(&conn, 1, true, false).unwrap();
        assert_eq!(mod_rows.len(), 1);
        assert_eq!(mod_rows[0].geometry_path, "MOD/a.mod");

        let stl_rows = query_reachable_geometry(&conn, 1, false, true).unwrap();
        assert_eq!(stl_rows.len(), 1);
        assert_eq!(stl_rows[0].geometry_path, "MOD/b.stl");

        let all_rows = query_reachable_geometry(&conn, 1, true, true).unwrap();
        assert_eq!(all_rows.len(), 2);
    }

    #[test]
    fn reachable_geometry_uses_cumulative_cbm_transform() {
        let conn = setup_geometry_conn();
        conn.execute(
            "INSERT INTO cbm_node (project_id, node_key, parent_key, entity_name, dev_path, transform_matrix)
             VALUES
             (1, 'parent', NULL, 'F3System', NULL, '1,0,0,0,0,1,0,0,0,0,1,0,10,0,0,1'),
             (1, 'child', 'parent', 'F4System', 'device.dev', '1,0,0,0,0,1,0,0,0,0,1,0,0,20,0,1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO dev_solid_model (project_id, dev_path, solid_model_path, transform_matrix, sort_order)
             VALUES (1, 'DEV/device.dev', 'device.phm', NULL, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO phm_solid_model (project_id, phm_path, solid_model_path, transform_matrix, color, sort_order)
             VALUES (1, 'PHM/device.phm', 'device.mod', NULL, NULL, 0)",
            [],
        )
        .unwrap();

        let rows = query_reachable_geometry(&conn, 1, true, false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].placement_transform_matrix.as_deref(),
            Some("1.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,10.000000,20.000000,0.000000,1.000000")
        );
    }

    #[test]
    fn reachable_geometry_does_not_seed_from_virtual_dev_subdevice_nodes() {
        let conn = setup_geometry_conn();
        conn.execute(
            "INSERT INTO cbm_node (project_id, node_key, parent_key, entity_name, dev_path, transform_matrix)
             VALUES
             (1, 'parent', NULL, 'F4System', 'root.dev', NULL),
             (1, 'parent#dev:0:child.dev', 'parent', 'DEV_SUBDEVICE', 'child.dev',
              '1,0,0,0,0,1,0,0,0,0,1,0,999,0,0,1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO dev_sub_device (project_id, dev_path, child_dev_path, transform_matrix, sort_order)
             VALUES (1, 'DEV/root.dev', 'child.dev', '1,0,0,0,0,1,0,0,0,0,1,0,100,0,0,1', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO dev_solid_model (project_id, dev_path, solid_model_path, transform_matrix, sort_order)
             VALUES (1, 'DEV/child.dev', 'child.phm', NULL, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO phm_solid_model (project_id, phm_path, solid_model_path, transform_matrix, color, sort_order)
             VALUES (1, 'PHM/child.phm', 'child.mod', NULL, NULL, 0)",
            [],
        )
        .unwrap();

        let rows = query_reachable_geometry(&conn, 1, true, false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].placement_transform_matrix.as_deref(),
            Some("1.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,100.000000,0.000000,0.000000,1.000000")
        );
    }
}
