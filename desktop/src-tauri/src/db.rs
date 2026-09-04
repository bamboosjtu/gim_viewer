use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs as stdfs;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;
use tauri::Manager;

/// Debug-only 性能日志宏。
///
/// `get_reachable_geometry` 等热路径的性能 eprintln! 在 release 构建中无条件输出，
/// 会污染用户终端且带来微小 I/O 开销（见 review0709.md §3.3 问题 6）。
/// 使用此宏后，性能日志仅在 debug 构建中输出；release 构建中完全消除。
///
/// 注意：初始化阶段的错误日志（如 init_db 中的 WAL 设置失败）仍使用 eprintln!，
/// 因为它们是启动故障的诊断信息，需要始终可见。
macro_rules! debug_perf_log {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!($($arg)*);
        }
    };
}

/// 当前解析器版本（变更解析逻辑时递增，用于缓存失效）
/// v2: 增加 substation_fam_property / substation_dev_property 表，缓存 CBM/FAM/DEV 基础属性
/// v3: validate cache requires substation_cbm_node index; rebuild incomplete v2 cache
/// v4: adds transmission_line graph cache (powerline_cbm_node/child/ref/file_stat)
/// v5: adds transmission_line FAM/DEV attribute cache (powerline_fam_property / powerline_dev_property)
/// v6: 缓存 DEV/PHM/MOD 几何文件到本地磁盘（缓存命中场景下支持 xml-mod 回放）
/// v7: 几何引用链递归 DEV SUBDEVICE，并保存 SUBDEVICE 变换矩阵
/// v8: 几何查询使用 CBM 父链累计 TRANSFORMMATRIX，并按实例级 placement 去重
/// v9: 层级树名称优化——F1System 根节点用 GIM 头部工程名，F4System/PARTINDEX 设备层用 DEV SYMBOLNAME；过滤 IFC "&其他"占位符
/// v10: F1System 显示工程类型名（变电工程/建筑工程），F2System 按 SYSCLASSIFYNAME 映射专业名（U=建筑工程等）并按 U→A→S→G 排序
/// v11: F3System 命名优化——方案A 过滤 SYSTEMNAME 占位符（- / 其它 / 空），方案B 收集 F4 子节点设备名/IFC文件名生成区分性后缀
/// v12: 修复 DEV SUBDEVICE 虚拟子节点 transformMatrix 为空导致嵌套 DEV 中 MOD 位置错误（丢失 SUBDEVICE 变换）
/// v13: DEV_SUBDEVICE 虚拟节点仅用于层级树/点击，不作为全量几何查询起点，避免与 DEV SUBDEVICES 递归重复
/// v14: PARTINDEX 是 DEV SUBDEVICE 的 CBM 语义别名，不作为第二个几何查询起点，避免遗漏局部矩阵的重复部件
/// v15: IFC 路径解析兼容任意目录（Bentley 导出 IFC 位于 CBM/ 而非 DEV/），旧缓存存有错误的 DEV/ 路径需失效重建
/// v16: 资源上限、几何 ready 提交协议、线路缓存 session 校验
/// v19: IFC 空间索引改为逐模型增量构建；运行时 IFC 会话身份与模型事件隔离
/// v20: 线路 native semantic pack 与大 MOD 仅保留路径元数据，缓存输入边界同步升级
/// v22: Substation IFC Spatial Semantic Core selective/two-pass scan
pub const PARSER_VERSION: &str = "gim-parser-v22";

/// Fragments 缓存版本（独立于 GIM parser_version，变更缓存格式时递增）
/// v2: 修复旧 v1 缓存可能加载不全的问题，强制失效重建
/// v3: IFC 加载关闭 COORDINATE_TO_ORIGIN，保留工程原始坐标以对齐 MOD（已废弃）
/// v4: restore IFC coordinateToOrigin=true; MOD/STL alignment handled by project-level sourceToViewer transform
// 2026-08 P0-3：缓存键由前端传入（fragments-cache-v6|fragments@x.y.z|web-ifc@a.b.c），
// 绑定 @thatopen/fragments 与 web-ifc 包版本；此常量仅作诊断兜底显示。
pub const FRAGMENTS_CACHE_VERSION: &str = "fragments-cache-v6";

/// GLB 几何缓存版本（方案 C：MOD/STL → glTF 序列化格式版本）
/// 独立于 PARSER_VERSION，用于在 MOD 解析逻辑变更时单独失效 glb 缓存。
/// 失效规则：
/// - PARSER_VERSION 变 → glbcache 目录由 delete_project_cache 删除重建
/// - GEOMETRY_CACHE_VERSION 变 → validate_gim_cache 返回 invalid，触发 delete_project_cache + 重序列化
/// 版本文件：{app_data_dir}/glbcache/{project_id}/_version.txt
pub const GEOMETRY_CACHE_VERSION: &str = "geometry-cache-v5-dev-status";

#[derive(Debug, Serialize, Deserialize)]
pub struct GeometryCacheManifestEntry {
    pub entry_path: String,
    /// DEV 几何结果：`glb` 表示有可加载的 GLB，`empty` 表示确定性空几何。
    /// 旧 manifest 没有该字段，反序列化失败后会整体失效并重建。
    pub status: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GeometryCacheManifest {
    pub source_sha256: String,
    pub entries: Vec<GeometryCacheManifestEntry>,
}

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

        CREATE TABLE IF NOT EXISTS substation_gim_entry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            entry_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            entry_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, entry_path)
        );
        CREATE INDEX IF NOT EXISTS idx_substation_gim_entry_project ON substation_gim_entry(project_id);
        CREATE INDEX IF NOT EXISTS idx_substation_gim_entry_type ON substation_gim_entry(project_id, entry_type);

        CREATE TABLE IF NOT EXISTS substation_cbm_node (
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
        CREATE INDEX IF NOT EXISTS idx_substation_cbm_node_project_parent ON substation_cbm_node(project_id, parent_key);
        CREATE INDEX IF NOT EXISTS idx_substation_cbm_node_ifc ON substation_cbm_node(project_id, ifc_file, ifc_guid);
        CREATE INDEX IF NOT EXISTS idx_substation_cbm_node_project_dev ON substation_cbm_node(project_id, dev_path);

        CREATE TABLE IF NOT EXISTS substation_ifc_model (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            model_id TEXT NOT NULL,
            name TEXT NOT NULL,
            entry_path TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, model_id)
        );
        CREATE INDEX IF NOT EXISTS idx_substation_ifc_model_project ON substation_ifc_model(project_id);

        CREATE TABLE IF NOT EXISTS substation_file_dev_entry (
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
        CREATE INDEX IF NOT EXISTS idx_substation_file_dev_project ON substation_file_dev_entry(project_id);
        CREATE INDEX IF NOT EXISTS idx_substation_file_dev_model ON substation_file_dev_entry(project_id, model_id);
        CREATE INDEX IF NOT EXISTS idx_substation_file_dev_device ON substation_file_dev_entry(project_id, device_cbm);

        CREATE TABLE IF NOT EXISTS substation_fam_property (
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
        CREATE INDEX IF NOT EXISTS idx_substation_fam_property_source ON substation_fam_property(project_id, source_path);

        CREATE TABLE IF NOT EXISTS substation_dev_property (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            dev_path TEXT NOT NULL,
            prop_key TEXT NOT NULL,
            prop_value TEXT,
            created_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, dev_path, prop_key)
        );
        CREATE INDEX IF NOT EXISTS idx_substation_dev_property_path ON substation_dev_property(project_id, dev_path);

        CREATE TABLE IF NOT EXISTS substation_fragment_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            entry_path TEXT NOT NULL,
            model_id TEXT NOT NULL,
            source_gim_sha256 TEXT NOT NULL DEFAULT '',
            source_ifc_size INTEGER NOT NULL,
            fragment_file_size INTEGER NOT NULL,
            fragments_version TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            UNIQUE(project_id, entry_path)
        );
        CREATE INDEX IF NOT EXISTS idx_substation_fragment_cache_project ON substation_fragment_cache(project_id);
        CREATE INDEX IF NOT EXISTS idx_substation_fragment_cache_entry ON substation_fragment_cache(project_id, entry_path);",
    )
    .map_err(|e| format!("初始化数据库表失败: {}", e))?;

    // 兼容旧库：给 substation_gim_entry 增加 local_cache_path 列（已存在则忽略）
    let _ = conn.execute(
        "ALTER TABLE substation_gim_entry ADD COLUMN local_cache_path TEXT",
        [],
    );

    // 兼容旧库：给 gim_project 增加 parser_version 列（已存在则忽略）
    let _ = conn.execute("ALTER TABLE gim_project ADD COLUMN parser_version TEXT", []);

    // v4: 给 gim_project 增加 project_type 列（substation / transmission_line / hybrid / unknown）
    let _ = conn.execute("ALTER TABLE gim_project ADD COLUMN project_type TEXT", []);

    // v4: 线路工程图缓存表
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS powerline_cbm_node (
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
        CREATE INDEX IF NOT EXISTS idx_powerline_cbm_node_project ON powerline_cbm_node(project_id);

        CREATE TABLE IF NOT EXISTS powerline_cbm_child (
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
        CREATE INDEX IF NOT EXISTS idx_powerline_cbm_child_parent ON powerline_cbm_child(project_id, parent_path);

        CREATE TABLE IF NOT EXISTS powerline_cbm_ref (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            node_path TEXT NOT NULL,
            ref_kind TEXT NOT NULL,
            ref_key TEXT,
            ref_value TEXT NOT NULL,
            sort_order INTEGER,
            created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_powerline_cbm_ref_node ON powerline_cbm_ref(project_id, node_path);

        CREATE TABLE IF NOT EXISTS powerline_file_stat (
            project_id INTEGER NOT NULL,
            file_type TEXT NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY(project_id, file_type)
        );",
    )
    .map_err(|e| format!("初始化线路工程缓存表失败: {}", e))?;

    // v5: powerline_cbm_ref 补字段（归一化结果，避免诊断时再临时猜路径）
    // 兼容旧库：已存在则忽略
    let _ = conn.execute(
        "ALTER TABLE powerline_cbm_ref ADD COLUMN normalized_ref_value TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE powerline_cbm_ref ADD COLUMN file_name_lower TEXT",
        [],
    );

    // v5: 线路工程 FAM/DEV 属性缓存表
    // line_fam_property：display_key 为中文展示键，prop_key 为英文键，prop_value 可含 =
    // line_dev_property：普通 KEY=VALUE，无 display_key
    // 使用复合 PRIMARY KEY（同 powerline_file_stat 模式），不设自增 id 列
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS powerline_fam_property (
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
        CREATE INDEX IF NOT EXISTS idx_powerline_fam_property_project ON powerline_fam_property(project_id);
        CREATE INDEX IF NOT EXISTS idx_powerline_fam_property_source ON powerline_fam_property(project_id, source_path);
        CREATE INDEX IF NOT EXISTS idx_powerline_fam_property_filename ON powerline_fam_property(project_id, file_name_lower);

        CREATE TABLE IF NOT EXISTS powerline_dev_property (
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
        CREATE INDEX IF NOT EXISTS idx_powerline_dev_property_project ON powerline_dev_property(project_id);
        CREATE INDEX IF NOT EXISTS idx_powerline_dev_property_source ON powerline_dev_property(project_id, source_path);
        CREATE INDEX IF NOT EXISTS idx_powerline_dev_property_filename ON powerline_dev_property(project_id, file_name_lower);

        CREATE TABLE IF NOT EXISTS powerline_cache_session (
            project_id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL,
            expected_nodes INTEGER NOT NULL,
            expected_children INTEGER NOT NULL,
            expected_refs INTEGER NOT NULL,
            expected_file_stats INTEGER NOT NULL,
            expected_fam_properties INTEGER NOT NULL,
            expected_dev_properties INTEGER NOT NULL,
            received_fam_properties INTEGER NOT NULL DEFAULT 0,
            received_dev_properties INTEGER NOT NULL DEFAULT 0,
            started_at_ms INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("初始化线路工程 FAM/DEV 属性缓存表失败: {}", e))?;

    // v6: 几何引用链缓存表（DEV → PHM → MOD/STL）
    // 避免缓存命中时逐文件读取数千个 DEV/PHM 来发现几何源
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS substation_dev_solid_model (
            project_id INTEGER NOT NULL,
            dev_path TEXT NOT NULL,
            solid_model_path TEXT NOT NULL,
            transform_matrix TEXT,
            sort_order INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(project_id, dev_path, sort_order)
        );
        CREATE INDEX IF NOT EXISTS idx_substation_dev_sm_project ON substation_dev_solid_model(project_id);
        CREATE INDEX IF NOT EXISTS idx_substation_dev_sm_dev ON substation_dev_solid_model(project_id, dev_path);

        CREATE TABLE IF NOT EXISTS substation_dev_sub_device (
            project_id INTEGER NOT NULL,
            dev_path TEXT NOT NULL,
            child_dev_path TEXT NOT NULL,
            transform_matrix TEXT,
            sort_order INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(project_id, dev_path, sort_order)
        );
        CREATE INDEX IF NOT EXISTS idx_substation_dev_sub_project ON substation_dev_sub_device(project_id);
        CREATE INDEX IF NOT EXISTS idx_substation_dev_sub_dev ON substation_dev_sub_device(project_id, dev_path);
        CREATE INDEX IF NOT EXISTS idx_substation_dev_sub_project_child ON substation_dev_sub_device(project_id, child_dev_path);

        CREATE TABLE IF NOT EXISTS substation_phm_solid_model (
            project_id INTEGER NOT NULL,
            phm_path TEXT NOT NULL,
            solid_model_path TEXT NOT NULL,
            transform_matrix TEXT,
            color TEXT,
            phm_color_max_a REAL,
            sort_order INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(project_id, phm_path, sort_order)
        );
        CREATE INDEX IF NOT EXISTS idx_substation_phm_sm_project ON substation_phm_solid_model(project_id);
        CREATE INDEX IF NOT EXISTS idx_substation_phm_sm_phm ON substation_phm_solid_model(project_id, phm_path);
        CREATE INDEX IF NOT EXISTS idx_substation_phm_sm_project_solid ON substation_phm_solid_model(project_id, solid_model_path);",
    )
    .map_err(|e| format!("初始化几何引用链缓存表失败: {}", e))?;

    // v7: DEV SUBDEVICE 也有独立 TRANSFORMMATRIXn，旧缓存库需补列。
    let _ = conn.execute(
        "ALTER TABLE substation_dev_sub_device ADD COLUMN transform_matrix TEXT",
        [],
    );
    // v8: preserve PHM file-level COLOR.A scale for cache replay (percent vs byte).
    let _ = conn.execute(
        "ALTER TABLE substation_phm_solid_model ADD COLUMN phm_color_max_a REAL",
        [],
    );

    // v18/P0-3：Fragments 缓存必须绑定源 GIM 内容身份；旧记录填空值并在
    // validate_fragment_cache 中一律视为失效，由当前工程重新生成。
    let _ = conn.execute(
        "ALTER TABLE substation_fragment_cache ADD COLUMN source_gim_sha256 TEXT NOT NULL DEFAULT ''",
        [],
    );

    // 2026-08 表名规范化迁移（substation_* / powerline_*）：
    // 旧表名数据均为可重建的解析缓存，且 PARSER_VERSION 已升版使其失效，
    // 直接删除回收空间，避免新旧两套表并存。
    conn.execute_batch(
        "DROP TABLE IF EXISTS gim_entry;
         DROP TABLE IF EXISTS cbm_node;
         DROP TABLE IF EXISTS ifc_model;
         DROP TABLE IF EXISTS file_dev_entry;
         DROP TABLE IF EXISTS fam_property;
         DROP TABLE IF EXISTS dev_property;
         DROP TABLE IF EXISTS fragment_cache;
         DROP TABLE IF EXISTS dev_solid_model;
         DROP TABLE IF EXISTS dev_sub_device;
         DROP TABLE IF EXISTS phm_solid_model;
         DROP TABLE IF EXISTS line_cbm_node;
         DROP TABLE IF EXISTS line_cbm_child;
         DROP TABLE IF EXISTS line_cbm_ref;
         DROP TABLE IF EXISTS line_file_stat;
         DROP TABLE IF EXISTS line_fam_property;
         DROP TABLE IF EXISTS line_dev_property;",
    )
    .map_err(|e| format!("清理旧命名缓存表失败: {}", e))?;

    Ok(conn)
}

/// 当前时间戳（毫秒，UNIX_EPOCH 起）
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn ensure_project_exists(conn: &Connection, project_id: i64) -> Result<(), String> {
    ensure_cache_project_id(project_id)?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM gim_project WHERE id = ?1)",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("校验项目 {} 失败: {}", project_id, e))?;
    if !exists {
        return Err(format!("项目 {} 不存在", project_id));
    }
    Ok(())
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
    // 前端 picker 已返回 canonical path，但 command 也必须在后端重新规范化：
    // 这样大小写、斜杠以及 . / .. 差异不会为同一个 Windows 文件创建多条项目记录。
    let (canonical_path, path_identity) = crate::canonical_identity(Path::new(&info.path))?;
    let extension = canonical_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("gim") {
        return Err("项目源文件必须是 .gim".to_string());
    }
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let now = now_ms();

    // 检查是否已存在，同时读取旧元信息判断源 GIM 文件是否变化。
    // 先做轻量精确匹配，再对旧版本可能保存的非 canonical 路径做一次
    // canonical identity 比较，避免升级后同一文件出现重复项目记录。
    let existing: Option<(i64, String, u64, u64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, path, size, modified_ms, sha256 FROM gim_project")
            .map_err(|e| format!("查询项目记录失败: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, u64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| format!("读取项目记录失败: {}", e))?;
        let mut found = None;
        for row in rows {
            let candidate = row.map_err(|e| format!("读取项目记录失败: {}", e))?;
            let matches = candidate.1 == path_identity
                || crate::canonical_identity(Path::new(&candidate.1))
                    .map(|(_, identity)| identity == path_identity)
                    .unwrap_or(false);
            if matches {
                found = Some(candidate);
                break;
            }
        }
        found
    };

    if let Some((id, old_path, old_size, old_modified_ms, old_sha256)) = existing {
        // 源 GIM 文件是否变化：size / modified_ms / sha256 任一不同即视为变化
        let file_changed = old_size != info.size
            || old_modified_ms != info.modified_ms
            || old_sha256 != info.sha256;

        if file_changed {
            // 源 GIM 文件变化：更新元信息，同时清空 parser_version / project_type，
            // 使 validate_gim_cache 返回 invalid，触发完整重建（不删除旧索引表数据）
            conn.execute(
                "UPDATE gim_project SET path = ?1, name = ?2, size = ?3, modified_ms = ?4, sha256 = ?5, parser_version = NULL, project_type = NULL, updated_at_ms = ?6, last_opened_at_ms = ?7 WHERE id = ?8",
                params![path_identity, info.name, info.size, info.modified_ms, info.sha256, now, now, id],
            )
            .map_err(|e| format!("更新项目记录失败: {}", e))?;
            println!(
                "[GIM] 源 GIM 文件变化，旧索引失效（path={}, old_size={}, new_size={}, old_sha256={}...）",
                info.path, old_size, info.size, &old_sha256[..old_sha256.len().min(12)]
            );
        } else {
            if old_path != path_identity {
                conn.execute(
                    "UPDATE gim_project SET path = ?1, updated_at_ms = ?2 WHERE id = ?3",
                    params![path_identity, now, id],
                )
                .map_err(|e| format!("规范化项目路径失败: {}", e))?;
            }
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
            params![path_identity, info.name, info.size, info.modified_ms, info.sha256, now, now, now],
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
    pub source_sha256: Option<String>,
    pub entries: Vec<GimEntryPayload>,
    pub cbm_nodes: Vec<CbmNodePayload>,
    pub ifc_models: Vec<IfcModelPayload>,
    pub file_dev_entries: Vec<FileDevEntryPayload>,
    pub fam_properties: Vec<FamPropertyPayload>,
    pub dev_properties: Vec<DevPropertyPayload>,
}

fn validate_index_payload(payload: &GimIndexPayload) -> Result<(), String> {
    ensure_cache_project_id(payload.project_id)?;
    const MAX_INDEX_ENTRIES: usize = 1_000_000;
    const MAX_INDEX_NODES: usize = 1_000_000;
    const MAX_INDEX_MODELS: usize = 4096;
    const MAX_INDEX_FILE_DEV: usize = 2_000_000;
    const MAX_INDEX_PROPERTIES: usize = 2_000_000;
    if payload.entries.len() > MAX_INDEX_ENTRIES
        || payload.cbm_nodes.len() > MAX_INDEX_NODES
        || payload.ifc_models.len() > MAX_INDEX_MODELS
        || payload.file_dev_entries.len() > MAX_INDEX_FILE_DEV
        || payload.fam_properties.len() > MAX_INDEX_PROPERTIES
        || payload.dev_properties.len() > MAX_INDEX_PROPERTIES
    {
        return Err("GIM 索引 payload 数量超过安全上限".to_string());
    }
    let entry_paths: std::collections::HashMap<&str, &str> = payload
        .entries
        .iter()
        .map(|e| (e.entry_path.as_str(), e.entry_type.as_str()))
        .collect();
    let node_keys: std::collections::HashSet<&str> = payload
        .cbm_nodes
        .iter()
        .map(|n| n.node_key.as_str())
        .collect();
    let model_ids: std::collections::HashSet<&str> = payload
        .ifc_models
        .iter()
        .map(|m| m.model_id.as_str())
        .collect();
    for e in &payload.entries {
        validate_entry_path(&e.entry_path)?;
        if e.file_name.trim().is_empty()
            || e.file_name.len() > 4096
            || e.file_size > 8 * 1024 * 1024 * 1024
        {
            return Err(format!("GIM entry 字段无效: {}", e.entry_path));
        }
        if e.entry_type != "IFC"
            && e.entry_type != "CBM"
            && e.entry_type != "DEV"
            && e.entry_type != "PHM"
            && e.entry_type != "MOD"
            && e.entry_type != "STL"
            && e.entry_type != "FAM"
            && e.entry_type != "SCH"
            && e.entry_type != "STD"
            && e.entry_type != "SLD"
        {
            return Err(format!("不支持的 entry_type: {}", e.entry_type));
        }
    }
    for n in &payload.cbm_nodes {
        validate_entry_path(&n.node_key)?;
        validate_entry_path(&n.path)?;
        if n.node_key.trim().is_empty() || n.path.trim().is_empty() || n.name.len() > 4096 {
            return Err("CBM 节点缺少 node_key/path 或文本过长".to_string());
        }
        for text in [
            n.entity_name.as_deref(),
            n.classify_name.as_deref(),
            n.fam_path.as_deref(),
            n.dev_path.as_deref(),
            n.ifc_file.as_deref(),
            n.ifc_guid.as_deref(),
            n.transform_matrix.as_deref(),
        ] {
            if text.map(|v| v.len() > 8192).unwrap_or(false) {
                return Err("CBM 节点字段过长".to_string());
            }
        }
        if let Some(parent) = n.parent_key.as_deref() {
            if !node_keys.contains(parent) {
                return Err(format!("CBM 节点 parent_key 不存在: {}", parent));
            }
        }
    }
    for m in &payload.ifc_models {
        if m.model_id.trim().is_empty() || m.model_id.len() > 4096 || m.name.len() > 4096 {
            return Err("IFC 模型字段无效".to_string());
        }
        validate_entry_path(&m.entry_path)?;
        if !model_ids.contains(m.model_id.as_str()) {
            return Err("IFC model_id 无效".to_string());
        }
        if entry_paths.get(m.entry_path.as_str()) != Some(&"IFC") {
            return Err(format!(
                "IFC 模型 entry_path 未指向 IFC entry: {}",
                m.entry_path
            ));
        }
    }
    for f in &payload.file_dev_entries {
        // DGN/缺失/重复 basename 的来源记录可以保留为证据，但没有可解析的
        // IFC model_id；只有非空 model_id 才必须引用本次索引中的模型。
        if !f.model_id.trim().is_empty() && !model_ids.contains(f.model_id.as_str()) {
            return Err(format!("文件设备关系引用未知 IFC model_id: {}", f.model_id));
        }
        if f.device_count < 0
            || f.device_count > MAX_INDEX_NODES as i64
            || f.ifc_name.len() > 4096
            || f.ifc_file.len() > 4096
            || f.device_cbm.len() > 4096
        {
            return Err("文件设备关系字段无效".to_string());
        }
    }
    for p in &payload.fam_properties {
        validate_entry_path(&p.source_path)?;
        if p.section_name.len() > 4096
            || p.prop_key.trim().is_empty()
            || p.prop_key.len() > 4096
            || p.prop_value
                .as_ref()
                .map(|v| v.len() > MAX_LINE_TEXT_BYTES)
                .unwrap_or(false)
            || p.sort_order < 0
        {
            return Err("FAM 属性字段无效或过长".to_string());
        }
    }
    for p in &payload.dev_properties {
        validate_entry_path(&p.dev_path)?;
        if p.prop_key.trim().is_empty()
            || p.prop_key.len() > 4096
            || p.prop_value
                .as_ref()
                .map(|v| v.len() > MAX_LINE_TEXT_BYTES)
                .unwrap_or(false)
        {
            return Err("DEV 属性字段无效或过长".to_string());
        }
    }
    Ok(())
}

/// 校验写入请求携带的源 GIM 身份仍是当前项目身份。
///
/// 工程切换可能与 IPC 写入并发发生；仅靠前端 await 前后的代次检查无法
/// 覆盖命令执行期间的竞态。把 SHA-256 绑定到数据库项目记录，可阻止旧
/// 工程的延迟提交覆盖同一路径已更新的新源文件缓存。
fn ensure_project_source_sha(
    conn: &Connection,
    project_id: i64,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    let Some(expected) = expected_sha256 else {
        return Ok(());
    };
    if expected.trim().is_empty() || expected.len() > 128 {
        return Err("source_sha256 无效".to_string());
    }
    let actual: String = conn
        .query_row(
            "SELECT sha256 FROM gim_project WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取项目源 SHA-256 失败: {}", e))?;
    if actual != expected {
        return Err("项目源 GIM 已变化，拒绝提交旧缓存".to_string());
    }
    Ok(())
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
    if payload.ifc_models.is_empty() || !payload.entries.iter().any(|e| e.entry_type == "IFC") {
        return Err(
            "拒绝写入 substation 索引：未发现 IFC 模型或 IFC entry（可能为线路工程被误识别，应走 save_line_gim_graph）"
                .to_string(),
        );
    }
    validate_index_payload(&payload)?;

    let mut conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, payload.project_id)?;
    ensure_project_source_sha(&conn, payload.project_id, payload.source_sha256.as_deref())?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    let pid = payload.project_id;

    // 先删除旧索引
    tx.execute(
        "DELETE FROM substation_gim_entry WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 substation_gim_entry 失败: {}", e))?;
    tx.execute(
        "DELETE FROM substation_cbm_node WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 substation_cbm_node 失败: {}", e))?;
    tx.execute(
        "DELETE FROM substation_ifc_model WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 substation_ifc_model 失败: {}", e))?;
    tx.execute(
        "DELETE FROM substation_file_dev_entry WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 substation_file_dev_entry 失败: {}", e))?;
    tx.execute(
        "DELETE FROM substation_fam_property WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 substation_fam_property 失败: {}", e))?;
    tx.execute(
        "DELETE FROM substation_dev_property WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 substation_dev_property 失败: {}", e))?;

    // substation_gim_entry
    for e in &payload.entries {
        tx.execute(
            "INSERT INTO substation_gim_entry (project_id, entry_path, file_name, entry_type, file_size, created_at_ms, local_cache_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![pid, e.entry_path, e.file_name, e.entry_type, e.file_size, now, e.local_cache_path],
        )
        .map_err(|e| format!("插入 substation_gim_entry 失败: {}", e))?;
    }

    // substation_cbm_node
    for n in &payload.cbm_nodes {
        tx.execute(
            "INSERT INTO substation_cbm_node (project_id, node_key, parent_key, path, name, entity_name, classify_name, fam_path, dev_path, ifc_file, ifc_guid, transform_matrix, sort_order, created_at_ms)
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
        .map_err(|e| format!("插入 substation_cbm_node 失败: {}", e))?;
    }

    // substation_ifc_model
    for m in &payload.ifc_models {
        tx.execute(
            "INSERT INTO substation_ifc_model (project_id, model_id, name, entry_path, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![pid, m.model_id, m.name, m.entry_path, now],
        )
        .map_err(|e| format!("插入 substation_ifc_model 失败: {}", e))?;
    }

    // substation_file_dev_entry
    for f in &payload.file_dev_entries {
        tx.execute(
            "INSERT INTO substation_file_dev_entry (project_id, model_id, ifc_name, ifc_file, device_count, device_cbm, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![pid, f.model_id, f.ifc_name, f.ifc_file, f.device_count, f.device_cbm, f.sort_order, now],
        )
        .map_err(|e| format!("插入 substation_file_dev_entry 失败: {}", e))?;
    }

    // substation_fam_property
    for fp in &payload.fam_properties {
        tx.execute(
            "INSERT INTO substation_fam_property (project_id, source_path, section_name, prop_key, prop_value, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![pid, fp.source_path, fp.section_name, fp.prop_key, fp.prop_value, fp.sort_order, now],
        )
        .map_err(|e| format!("插入 substation_fam_property 失败: {}", e))?;
    }

    // substation_dev_property
    for dp in &payload.dev_properties {
        tx.execute(
            "INSERT INTO substation_dev_property (project_id, dev_path, prop_key, prop_value, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![pid, dp.dev_path, dp.prop_key, dp.prop_value, now],
        )
        .map_err(|e| format!("插入 substation_dev_property 失败: {}", e))?;
    }

    // 几何引用链尚未写入，不能在此处提交 parser_version；由
    // save_geometry_refs 完成后统一提交 ready 状态。
    tx.execute(
        "UPDATE gim_project SET parser_version = NULL, project_type = 'substation', updated_at_ms = ?1 WHERE id = ?2",
        params![now, pid],
    )
    .map_err(|e| format!("清空 parser_version 失败: {}", e))?;

    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

// ===== GIM 索引读取 =====

/// substation_ifc_model 表完整记录
#[derive(Debug, Serialize)]
pub struct IfcModelRecord {
    pub id: i64,
    pub project_id: i64,
    pub model_id: String,
    pub name: String,
    pub entry_path: String,
    pub created_at_ms: u64,
}

/// substation_cbm_node 表完整记录
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

/// 二进制缓存写入 IPC 的 envelope：前 9 字节为 `GIMB` + 版本 +
/// little-endian metadata 长度，随后是 JSON metadata 与原始文件字节。
/// 使用 `tauri::ipc::Request` 接收 Raw body，避免把大型文件编码成 JSON 数字数组。
const BINARY_CACHE_REQUEST_MAGIC: &[u8; 4] = b"GIMB";
const BINARY_CACHE_REQUEST_VERSION: u8 = 1;
const BINARY_CACHE_REQUEST_HEADER: usize = 9;
const MAX_BINARY_CACHE_METADATA_BYTES: usize = 16 * 1024;
const MAX_BATCH_CACHE_FILES: usize = 200_000;
const MAX_BATCH_CACHE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// 线路首屏语义文本的连续磁盘包。原生解压时，CBM/DEV/FAM/PHM 以及小型
/// MOD 不再各自落盘；它们被追加到一个连续文件，随后由一次 IPC 读取给
/// Line Parser Worker。大 MOD/STL 仍保留独立文件，供用户查看几何来源。
pub(crate) const LINE_SEMANTIC_PACK_FILE: &str = ".gim-line-semantic.pack";
pub(crate) const LINE_SEMANTIC_INDEX_FILE: &str = ".gim-line-semantic.index";
const LINE_SEMANTIC_INDEX_MAGIC: &[u8; 4] = b"GLSI";
const LINE_SEMANTIC_INDEX_VERSION: u8 = 2;
const LINE_SEMANTIC_INDEX_LEGACY_VERSION: u8 = 1;
const LINE_SEMANTIC_INDEX_HEADER: usize = 9; // magic + version + count
const LINE_SEMANTIC_INDEX_FLAG_PACKED: u8 = 0x01;
/// semantic pack 是线路首屏语义输入，不应成为一次 IPC 的无界内存源。
/// 当前六个真实线路样本的 pack 约 2--22 MB；512 MiB 足以覆盖正常工程，
/// 同时把损坏/恶意缓存的单次响应和 Rust 分配控制在明确边界内。
const MAX_LINE_SEMANTIC_PACK_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct BinaryCacheWriteMeta {
    project_id: i64,
    entry_path: String,
    #[serde(default)]
    source_gim_sha256: Option<String>,
}

fn decode_binary_cache_write_request(
    request: &tauri::ipc::Request<'_>,
) -> Result<(BinaryCacheWriteMeta, Vec<u8>), String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => return Err("缓存写入必须使用二进制 IPC".to_string()),
    };
    if body.len() < BINARY_CACHE_REQUEST_HEADER
        || &body[..4] != BINARY_CACHE_REQUEST_MAGIC
        || body[4] != BINARY_CACHE_REQUEST_VERSION
    {
        return Err("缓存写入二进制 envelope 无效".to_string());
    }
    let metadata_len = u32::from_le_bytes([body[5], body[6], body[7], body[8]]) as usize;
    if metadata_len > MAX_BINARY_CACHE_METADATA_BYTES {
        return Err("缓存写入 metadata 过大".to_string());
    }
    let metadata_start = BINARY_CACHE_REQUEST_HEADER;
    let metadata_end = metadata_start
        .checked_add(metadata_len)
        .ok_or_else(|| "缓存写入 metadata 长度溢出".to_string())?;
    if metadata_end > body.len() {
        return Err("缓存写入 metadata 越界".to_string());
    }
    let meta: BinaryCacheWriteMeta = serde_json::from_slice(&body[metadata_start..metadata_end])
        .map_err(|e| format!("解析缓存写入 metadata 失败: {}", e))?;
    if meta.entry_path.trim().is_empty() {
        return Err("缓存写入 entry_path 不能为空".to_string());
    }
    Ok((meta, body[metadata_end..].to_vec()))
}

/// 校验 entry_path：只允许 Normal 组件，拒绝 ParentDir / RootDir / Prefix。
/// 同时处理 "/" 和 Windows "\" 语义下的路径穿越。
/// 返回由 Normal 组件拼接的相对 PathBuf。
fn validate_entry_path(entry_path: &str) -> Result<PathBuf, String> {
    // 归一化分隔符后再按组件校验，保证线路 PascalCase 清单和 Windows
    // 反斜杠引用在不同平台/旧缓存中得到同一安全语义。
    let normalized = entry_path.replace('\\', "/");
    let path = Path::new(&normalized);
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

/// 拒绝缓存目录中的符号链接/junction（Windows reparse point）。
/// 仅检查 metadata，不跟随链接，避免缓存路径被重定向到任意目录。
fn reject_link(path: &Path, label: &str) -> Result<(), String> {
    let Ok(meta) = stdfs::symlink_metadata(path) else {
        return Ok(());
    };
    let is_link = meta.file_type().is_symlink();
    #[cfg(windows)]
    // FILE_ATTRIBUTE_REPARSE_POINT (0x0400) covers junctions and other
    // Windows reparse points; use symlink_metadata so this check never follows
    // the link itself.
    let is_reparse = meta.file_attributes() & 0x0400 != 0;
    #[cfg(not(windows))]
    let is_reparse = false;
    if is_link || is_reparse {
        return Err(format!(
            "缓存{}包含符号链接或 junction: {}",
            label,
            path.display()
        ));
    }
    Ok(())
}

fn ensure_cache_project_id(project_id: i64) -> Result<(), String> {
    if project_id <= 0 {
        return Err("project_id 必须为正数".to_string());
    }
    Ok(())
}

/// 创建并检查 root 下的每一级父目录；已有组件一旦是链接立即拒绝。
fn ensure_cache_parent(
    root: &Path,
    relative_parent: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    reject_link(root, label)?;
    let mut current = root.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(part) = component else {
            return Err(format!("缓存{}父目录组件无效", label));
        };
        current.push(part);
        if !current.exists() {
            stdfs::create_dir(&current).map_err(|e| format!("创建缓存{}目录失败: {}", label, e))?;
        }
        reject_link(&current, label)?;
        if !current.is_dir() {
            return Err(format!(
                "缓存{}路径组件不是目录: {}",
                label,
                current.display()
            ));
        }
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("规范化缓存{}根目录失败: {}", label, e))?;
    let canonical_parent = current
        .canonicalize()
        .map_err(|e| format!("规范化缓存{}父目录失败: {}", label, e))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(format!("缓存{}父目录越界", label));
    }
    Ok(canonical_parent)
}

/// 原子替换缓存文件，避免进程中断留下半写文件被后续校验误认为可用。
pub(crate) fn atomic_write(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    reject_link(path, label)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("缓存{}缺少父目录", label))?;
    reject_link(parent, label)?;
    let stamp = now_ms();
    let temp = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("cache"),
        std::process::id(),
        stamp
    ));
    reject_link(&temp, label)?;
    {
        let mut file = stdfs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("创建缓存{}临时文件失败: {}", label, e))?;
        file.write_all(bytes)
            .map_err(|e| format!("写入缓存{}临时文件失败: {}", label, e))?;
        file.sync_all()
            .map_err(|e| format!("同步缓存{}临时文件失败: {}", label, e))?;
    }
    reject_link(path, label)?;
    // Windows 的 std::fs::rename 不覆盖已有文件；先删除已验证的普通目标，
    // 再 rename，避免目标被部分写入。
    if path.exists() {
        stdfs::remove_file(path).map_err(|e| {
            let _ = stdfs::remove_file(&temp);
            format!("删除旧缓存{}文件失败: {}", label, e)
        })?;
    }
    if let Err(e) = stdfs::rename(&temp, path) {
        let _ = stdfs::remove_file(&temp);
        return Err(format!("替换缓存{}文件失败: {}", label, e));
    }
    Ok(())
}

/// 为一次原生 GIM 解压创建独立 staging 目录。
///
/// 逐条写入 staging 时不需要对每个小文件执行 `sync_all + rename`；只有
/// 全部条目成功后才通过 `commit_cache_staging` 替换 project 目录。这样把
/// 数万次同步/元数据更新从冷启动关键路径移出，同时保留“未完成解压不
/// 能被缓存校验命中”的提交语义。
pub(crate) fn create_cache_staging_dir(
    app_handle: &tauri::AppHandle,
    project_id: i64,
) -> Result<(PathBuf, PathBuf), String> {
    ensure_cache_project_id(project_id)?;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("extracted");
    if !base.exists() {
        stdfs::create_dir_all(&base).map_err(|e| format!("创建 extracted 目录失败: {}", e))?;
    }
    reject_link(&base, " extracted")?;
    if !base.is_dir() {
        return Err(format!("extracted 路径不是目录: {}", base.display()));
    }

    let final_root = base.join(project_id.to_string());
    // 纳入路径安全检查；旧目录即使存在也只允许是普通目录，提交时会
    // 先移动到 backup，再由新 staging 目录接替。
    reject_link(&final_root, "缓存")?;
    if final_root.exists() && !final_root.is_dir() {
        return Err(format!("缓存根路径不是目录: {}", final_root.display()));
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = base.join(format!(
        ".staging-{}-{}-{}",
        project_id,
        std::process::id(),
        stamp
    ));
    if staging.exists() {
        return Err(format!("缓存 staging 目录已存在: {}", staging.display()));
    }
    stdfs::create_dir(&staging).map_err(|e| format!("创建缓存 staging 目录失败: {}", e))?;
    reject_link(&staging, " staging")?;
    Ok((final_root, staging))
}

/// 一次解压过程复用的 staging 写入器。
///
/// 归档通常包含上万条同目录文件。逐条重新执行父目录的
/// `exists + symlink_metadata + is_dir` 会把元数据调用放大到数万次，
/// 在 Windows/Defender 环境下比实际写入更慢。写入器只缓存本次新建
/// staging 中已经检查过的目录。staging 根目录是本次调用刚创建的唯一
/// 目录，目标文件使用 `create_new` 原子创建：它既拒绝预先存在的普通文件，
/// 也拒绝预先存在的符号链接/junction，因此不必再对每个新文件做一次
/// `symlink_metadata`。这样在数万条目场景中可以把安全检查从“每文件”降为
/// “每个目录”，同时保留路径穿越和 reparse point 防护。
pub(crate) struct CacheStagingWriter {
    root: PathBuf,
    checked_dirs: HashSet<PathBuf>,
}

/// 一次 staging 文件写入中可拆分的耗时，用于区分 Windows 文件 open/创建
/// 与真正的字节写入。该信息只用于解压性能 profile，不改变写入语义。
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CacheWriteTiming {
    pub open_ms: f64,
    pub data_ms: f64,
}

impl CacheStagingWriter {
    pub(crate) fn new(staging_root: &Path) -> Result<Self, String> {
        reject_link(staging_root, " staging")?;
        if !staging_root.is_dir() {
            return Err(format!("缓存 staging 根路径不是目录: {}", staging_root.display()));
        }
        let mut checked_dirs = HashSet::new();
        checked_dirs.insert(staging_root.to_path_buf());
        Ok(Self {
            root: staging_root.to_path_buf(),
            checked_dirs,
        })
    }

    pub(crate) fn write_with_timing(
        &mut self,
        entry_path: &str,
        bytes: &[u8],
    ) -> Result<CacheWriteTiming, String> {
        let relative = validate_entry_path(entry_path)?;
        let mut current = self.root.clone();
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        for component in parent.components() {
            let Component::Normal(part) = component else {
                return Err("缓存 staging 父目录组件无效".to_string());
            };
            current.push(part);
            if !self.checked_dirs.contains(&current) {
                if !current.exists() {
                    stdfs::create_dir(&current)
                        .map_err(|e| format!("创建缓存 staging 子目录失败: {}", e))?;
                }
                reject_link(&current, " staging")?;
                if !current.is_dir() {
                    return Err(format!("缓存 staging 路径组件不是目录: {}", current.display()));
                }
                self.checked_dirs.insert(current.clone());
            }
        }
        let name = relative
            .file_name()
            .ok_or_else(|| "缓存 staging entry_path 缺少文件名".to_string())?;
        let full = current.join(name);
        if !full.starts_with(&self.root) {
            return Err("缓存 staging 路径越界".to_string());
        }
        // `create_new` 在文件系统层面原子拒绝已经存在的目标（包括链接），
        // 避免每个条目额外进行一次 symlink_metadata。staging 目录本身已在
        // 上方逐目录检查，且不会与旧正式缓存目录共享路径。
        let open_started = Instant::now();
        let mut file = stdfs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&full)
            .map_err(|e| format!("写入缓存 staging 文件失败: {} — {}", entry_path, e))?;
        let open_ms = open_started.elapsed().as_secs_f64() * 1000.0;
        let data_started = Instant::now();
        file.write_all(bytes)
            .map_err(|e| format!("写入缓存 staging 文件失败: {} — {}", entry_path, e))?;
        let data_ms = data_started.elapsed().as_secs_f64() * 1000.0;
        Ok(CacheWriteTiming { open_ms, data_ms })
    }
}

/// 线路语义 pack 的索引项。offset/size 均相对于
/// `LINE_SEMANTIC_PACK_FILE` 的数据起点（文件本身不含头部）。
#[derive(Debug, Clone)]
pub(crate) struct LineSemanticPackEntry {
    pub path: String,
    pub offset: u64,
    pub size: u64,
    /// true 表示数据位于连续 pack；false 表示仅记录独立缓存文件元数据。
    pub packed: bool,
}

/// 将线路 parser 所需的小文本连续写入 staging 文件。
///
/// 这里故意把索引写成独立文件：解压回调是逐条的，无法在还不知道条目数
/// 时构造固定头部；独立索引也让 `read_line_semantic_pack` 可以先读取索引，
/// 再一次性读取数据，避免数万次小文件 open。
pub(crate) struct LineSemanticPackWriter {
    data_file: stdfs::File,
    data_path: PathBuf,
    entries: Vec<LineSemanticPackEntry>,
    seen_paths: HashSet<String>,
    total_bytes: u64,
}

impl LineSemanticPackWriter {
    pub(crate) fn new(staging_root: &Path) -> Result<Self, String> {
        reject_link(staging_root, " staging")?;
        let data_path = staging_root.join(LINE_SEMANTIC_PACK_FILE);
        let data_file = stdfs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&data_path)
            .map_err(|e| format!("创建线路语义 pack 失败: {}", e))?;
        Ok(Self {
            data_file,
            data_path,
            entries: Vec::new(),
            seen_paths: HashSet::new(),
            total_bytes: 0,
        })
    }

    pub(crate) fn append_with_timing(
        &mut self,
        path: &str,
        bytes: &[u8],
    ) -> Result<CacheWriteTiming, String> {
        let normalized_path = normalize_cache_lookup_path(path);
        if !self.seen_paths.insert(normalized_path) {
            return Err(format!("线路语义 pack 条目重复: {}", path));
        }
        let offset = self.total_bytes;
        let size = u64::try_from(bytes.len())
            .map_err(|e| format!("线路语义 pack 条目大小溢出: {} — {}", path, e))?;
        let data_started = Instant::now();
        self.data_file
            .write_all(bytes)
            .map_err(|e| format!("写入线路语义 pack 失败: {} — {}", path, e))?;
        let data_ms = data_started.elapsed().as_secs_f64() * 1000.0;
        self.total_bytes = self
            .total_bytes
            .checked_add(size)
            .ok_or_else(|| "线路语义 pack 总大小溢出".to_string())?;
        self.entries.push(LineSemanticPackEntry {
            path: path.to_string(),
            offset,
            size,
            packed: true,
        });
        Ok(CacheWriteTiming {
            // pack data file 在 new() 时只打开一次；单条追加没有 open 成本。
            open_ms: 0.0,
            data_ms,
        })
    }

    /// 只记录不进入连续 pack 的大 MOD/STL（或其它）条目元数据。
    /// warm full-read 会据此重建完整 filesByType/currentFiles，而不把几何
    /// 字节复制到 semantic pack 或 Worker。
    pub(crate) fn record_metadata(&mut self, path: &str, size: u64) -> Result<(), String> {
        let normalized_path = normalize_cache_lookup_path(path);
        if !self.seen_paths.insert(normalized_path) {
            return Err(format!("线路语义 pack 条目重复: {}", path));
        }
        self.entries.push(LineSemanticPackEntry {
            path: path.to_string(),
            offset: 0,
            size,
            packed: false,
        });
        Ok(())
    }

    pub(crate) fn last_entry(&self) -> Option<&LineSemanticPackEntry> {
        self.entries.last()
    }

    pub(crate) fn finish(mut self) -> Result<Vec<LineSemanticPackEntry>, String> {
        self.data_file
            .flush()
            .map_err(|e| format!("刷新线路语义 pack 失败: {}", e))?;
        drop(self.data_file);

        let index_path = self.data_path.with_file_name(LINE_SEMANTIC_INDEX_FILE);
        let mut index_file = stdfs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&index_path)
            .map_err(|e| format!("创建线路语义 pack 索引失败: {}", e))?;
        index_file
            .write_all(LINE_SEMANTIC_INDEX_MAGIC)
            .map_err(|e| format!("写入线路语义 pack 索引失败: {}", e))?;
        index_file
            .write_all(&[LINE_SEMANTIC_INDEX_VERSION])
            .map_err(|e| format!("写入线路语义 pack 索引版本失败: {}", e))?;
        let count = u32::try_from(self.entries.len())
            .map_err(|_| "线路语义 pack 条目数溢出".to_string())?;
        index_file
            .write_all(&count.to_le_bytes())
            .map_err(|e| format!("写入线路语义 pack 条目数失败: {}", e))?;
        for entry in &self.entries {
            let path = entry.path.as_bytes();
            let path_len = u32::try_from(path.len())
                .map_err(|_| format!("线路语义 pack 路径过长: {}", entry.path))?;
            index_file
                .write_all(&path_len.to_le_bytes())
                .and_then(|_| index_file.write_all(path))
                .and_then(|_| index_file.write_all(&entry.offset.to_le_bytes()))
                .and_then(|_| index_file.write_all(&entry.size.to_le_bytes()))
                .and_then(|_| index_file.write_all(&[
                    if entry.packed { LINE_SEMANTIC_INDEX_FLAG_PACKED } else { 0 },
                ]))
                .map_err(|e| format!("写入线路语义 pack 索引项失败: {} — {}", entry.path, e))?;
        }
        index_file
            .flush()
            .map_err(|e| format!("刷新线路语义 pack 索引失败: {}", e))?;
        Ok(self.entries)
    }
}

fn normalize_cache_lookup_path(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// 读取并校验线路语义 pack 索引。索引是 staging/commit 产生的受信任文件，
/// 仍执行长度、路径和 offset 边界检查，避免损坏缓存导致 panic 或越界切片。
fn read_line_semantic_index(
    root: &Path,
) -> Result<HashMap<String, LineSemanticPackEntry>, String> {
    let index_path = root.join(LINE_SEMANTIC_INDEX_FILE);
    reject_link(&index_path, "线路语义 pack 索引")?;
    let bytes = stdfs::read(&index_path)
        .map_err(|e| format!("读取线路语义 pack 索引失败: {}", e))?;
    if bytes.len() < LINE_SEMANTIC_INDEX_HEADER
        || &bytes[..4] != LINE_SEMANTIC_INDEX_MAGIC
        || (bytes[4] != LINE_SEMANTIC_INDEX_VERSION
            && bytes[4] != LINE_SEMANTIC_INDEX_LEGACY_VERSION)
    {
        return Err("线路语义 pack 索引头无效".to_string());
    }
    let count = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
    if count > MAX_BATCH_CACHE_FILES {
        return Err("线路语义 pack 条目数超过安全上限".to_string());
    }
    let mut offset = LINE_SEMANTIC_INDEX_HEADER;
    let mut result = HashMap::with_capacity(count);
    for _ in 0..count {
        let path_len_end = offset
            .checked_add(4)
            .ok_or_else(|| "线路语义 pack 索引偏移溢出".to_string())?;
        if path_len_end > bytes.len() {
            return Err("线路语义 pack 索引路径长度越界".to_string());
        }
        let path_len = u32::from_le_bytes(bytes[offset..path_len_end].try_into().unwrap()) as usize;
        offset = path_len_end;
        let entry_end = offset
            .checked_add(path_len)
            .and_then(|v| v.checked_add(16))
            .and_then(|v| {
                if bytes[4] == LINE_SEMANTIC_INDEX_VERSION {
                    v.checked_add(1)
                } else {
                    Some(v)
                }
            })
            .ok_or_else(|| "线路语义 pack 索引条目偏移溢出".to_string())?;
        if path_len == 0 || path_len > 4096 || entry_end > bytes.len() {
            return Err("线路语义 pack 索引路径或长度无效".to_string());
        }
        let path_end = offset + path_len;
        let path = String::from_utf8(bytes[offset..path_end].to_vec())
            .map_err(|_| "线路语义 pack 索引路径不是 UTF-8".to_string())?;
        offset = path_end;
        validate_entry_path(&path)?;
        let entry_offset_end = offset + 8;
        let entry_offset = u64::from_le_bytes(bytes[offset..entry_offset_end].try_into().unwrap());
        offset = entry_offset_end;
        let entry_size_end = offset + 8;
        let entry_size = u64::from_le_bytes(bytes[offset..entry_size_end].try_into().unwrap());
        offset = entry_size_end;
        let packed = if bytes[4] == LINE_SEMANTIC_INDEX_VERSION {
            let flags = bytes[offset];
            offset += 1;
            if flags & !LINE_SEMANTIC_INDEX_FLAG_PACKED != 0 {
                return Err("线路语义 pack 索引 flags 无效".to_string());
            }
            flags & LINE_SEMANTIC_INDEX_FLAG_PACKED != 0
        } else {
            // v1 索引只包含 pack 数据，因此旧条目全部视为 packed。
            true
        };
        let entry = LineSemanticPackEntry {
            path: path.clone(),
            offset: entry_offset,
            size: entry_size,
            packed,
        };
        let key = normalize_cache_lookup_path(&path);
        if result.insert(key, entry).is_some() {
            return Err("线路语义 pack 索引包含重复路径".to_string());
        }
    }
    if offset != bytes.len() {
        return Err("线路语义 pack 索引存在尾随数据".to_string());
    }
    Ok(result)
}

fn semantic_error(kind: &str, message: impl AsRef<str>) -> String {
    format!("{}: {}", kind, message.as_ref())
}

/// 校验 index 中 packed 区间的算术、边界与重叠关系。
///
/// 该检查在单条读取、full-read 和缓存校验中共享，任何整体损坏都会
/// 返回 PACK_TRUNCATED/INDEX_INVALID，而不是把其它条目当作可用的部分缓存。
fn validate_line_semantic_pack_ranges(
    index: &HashMap<String, LineSemanticPackEntry>,
    pack_len: u64,
) -> Result<(), String> {
    if pack_len > MAX_LINE_SEMANTIC_PACK_BYTES {
        return Err(semantic_error(
            "PACK_INVALID",
            format!(
                "线路语义 pack 大小超过安全上限（>{} bytes）",
                MAX_LINE_SEMANTIC_PACK_BYTES
            ),
        ));
    }
    let mut ranges: Vec<(u64, u64, &str)> = Vec::new();
    for entry in index.values() {
        if !entry.packed {
            continue;
        }
        let end = entry.offset.checked_add(entry.size).ok_or_else(|| {
            semantic_error(
                "PACK_TRUNCATED",
                format!("线路语义 pack 条目偏移溢出: {}", entry.path),
            )
        })?;
        if end > pack_len {
            return Err(semantic_error(
                "PACK_TRUNCATED",
                format!("线路语义 pack 条目越界: {}", entry.path),
            ));
        }
        if entry.size > 0 {
            ranges.push((entry.offset, end, entry.path.as_str()));
        }
    }
    ranges.sort_by_key(|(start, _, _)| *start);
    if ranges.is_empty() {
        if pack_len != 0 {
            return Err(semantic_error(
                "PACK_INVALID",
                "线路语义 pack 无 packed 条目但数据文件非空",
            ));
        }
    } else {
        if ranges[0].0 != 0 {
            return Err(semantic_error(
                "INDEX_INVALID",
                "线路语义 pack packed 区间未从 0 开始",
            ));
        }
        if ranges.last().map(|(_, end, _)| *end) != Some(pack_len) {
            return Err(semantic_error(
                "PACK_INVALID",
                "线路语义 pack 存在未被 index 覆盖的尾部数据",
            ));
        }
    }
    for pair in ranges.windows(2) {
        if pair[1].0 < pair[0].1 {
            return Err(semantic_error(
                "INDEX_INVALID",
                format!(
                    "线路语义 pack 条目区间重叠: {} / {}",
                    pair[0].2, pair[1].2
                ),
            ));
        }
        if pair[1].0 > pair[0].1 {
            return Err(semantic_error(
                "INDEX_INVALID",
                format!(
                    "线路语义 pack packed 区间存在空洞: {} / {}",
                    pair[0].2, pair[1].2
                ),
            ));
        }
    }
    Ok(())
}

/// v2 index 还保存 metadata-only entry；full-read/validate 时校验这些
/// 独立文件仍存在且大小未变，避免构造不完整的线路 Runtime。
fn validate_line_semantic_metadata_files(
    root: &Path,
    index: &HashMap<String, LineSemanticPackEntry>,
) -> Result<(), String> {
    for entry in index.values() {
        if entry.packed {
            continue;
        }
        let path = cache_file_path_from_root(root, &entry.path)?;
        let metadata = stdfs::metadata(&path).map_err(|e| {
            semantic_error(
                "PACK_INVALID",
                format!("线路语义 pack metadata 文件缺失: {} — {}", entry.path, e),
            )
        })?;
        if metadata.len() != entry.size {
            return Err(semantic_error(
                "PACK_INVALID",
                format!(
                    "线路语义 pack metadata 文件大小不匹配: {}（期望 {}, 实际 {}）",
                    entry.path,
                    entry.size,
                    metadata.len()
                ),
            ));
        }
    }
    Ok(())
}

/// 在已经 canonicalize 的缓存根目录下安全拼出相对 entry 路径；不创建目录。
fn cache_file_path_from_root(root: &Path, entry_path: &str) -> Result<PathBuf, String> {
    let relative = validate_entry_path(entry_path)
        .map_err(|e| semantic_error("PACK_INVALID", e))?;
    let full = root.join(relative);
    if !full.starts_with(root) {
        return Err(semantic_error("PACK_INVALID", "线路语义 pack metadata 路径越界"));
    }
    reject_link(&full, "线路语义 pack metadata 文件")
        .map_err(|e| semantic_error("PACK_INVALID", e))?;
    Ok(full)
}

/// 读取并校验 semantic pack 的公共入口。缺失/格式错误、pack 越界和
/// metadata 缺失分别保留可判定的错误前缀，供 WebView 选择整体重建或单条降级。
fn read_line_semantic_pack_files(
    root: &Path,
    validate_metadata: bool,
) -> Result<(HashMap<String, LineSemanticPackEntry>, u64), String> {
    let index = read_line_semantic_index(root)
        .map_err(|e| semantic_error("INDEX_INVALID", e))?;
    // A syntactically valid but empty index can be produced by truncating both
    // sidecars to their headers.  It is not a usable line semantic source:
    // accepting it would let the warm path build an empty/partial Runtime and
    // silently fall back to neither the pack nor the complete source.  Every
    // valid line pack must contain at least the project CBM (case-insensitive;
    // v2 may additionally contain metadata-only geometry entries).
    let has_packed_cbm = index.values().any(|entry| {
        entry.packed
            && entry.size > 0
            && normalize_cache_lookup_path(&entry.path).ends_with(".cbm")
    });
    if !has_packed_cbm {
        return Err(semantic_error(
            "INDEX_INVALID",
            "线路语义 pack index 不包含 packed CBM 入口",
        ));
    }
    let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
    reject_link(&pack_path, "线路语义 pack")
        .map_err(|e| semantic_error("PACK_INVALID", e))?;
    let pack_len = stdfs::metadata(&pack_path)
        .map_err(|e| {
            semantic_error(
                "PACK_INVALID",
                format!("读取线路语义 pack 元信息失败: {}", e),
            )
        })?
        .len();
    validate_line_semantic_pack_ranges(&index, pack_len)?;
    if validate_metadata {
        validate_line_semantic_metadata_files(root, &index)?;
    }
    Ok((index, pack_len))
}

#[cfg(test)]
fn validate_line_semantic_pack_files(root: &Path, validate_metadata: bool) -> Result<(), String> {
    let _ = read_line_semantic_pack_files(root, validate_metadata)?;
    Ok(())
}

/// 从线路语义 pack 读取单个条目；供 DiskBackedFile 的普通 source/geometry
/// 读取路径使用。按需只读取指定区间，不把整个 pack 复制到 JS。
fn read_line_semantic_pack_entry(root: &Path, entry_path: &str) -> Result<Option<Vec<u8>>, String> {
    let (index, _pack_len) = read_line_semantic_pack_files(root, false)?;
    let key = normalize_cache_lookup_path(entry_path);
    let Some(entry) = index.get(&key) else { return Ok(None); };
    if !entry.packed {
        // 该路径是 metadata-only（通常为大 MOD/STL），不是 semantic
        // entry；调用方可以按普通独立文件路径继续读取。
        return Ok(None);
    }
    let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
    reject_link(&pack_path, "线路语义 pack")
        .map_err(|e| semantic_error("PACK_INVALID", e))?;
    let pack_len = stdfs::metadata(&pack_path)
        .map_err(|e| {
            semantic_error(
                "PACK_INVALID",
                format!("读取线路语义 pack 元信息失败: {}", e),
            )
        })?
        .len();
    let end = entry
        .offset
        .checked_add(entry.size)
        .ok_or_else(|| semantic_error("PACK_TRUNCATED", "线路语义 pack 条目偏移溢出"))?;
    if end > pack_len {
        return Err(semantic_error(
            "PACK_TRUNCATED",
            format!("线路语义 pack 条目越界: {}", entry.path),
        ));
    }
    let mut file = stdfs::File::open(&pack_path)
        .map_err(|e| semantic_error("PACK_INVALID", format!("打开线路语义 pack 失败: {}", e)))?;
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(entry.offset))
        .map_err(|e| semantic_error("PACK_INVALID", format!("定位线路语义 pack 失败: {}", e)))?;
    let size = usize::try_from(entry.size)
        .map_err(|_| semantic_error("PACK_TRUNCATED", "线路语义 pack 条目大小超过平台限制"))?;
    let mut data = vec![0u8; size];
    file.read_exact(&mut data)
        .map_err(|e| {
            semantic_error(
                "PACK_TRUNCATED",
                format!("读取线路语义 pack 条目失败: {}", e),
            )
        })?;
    Ok(Some(data))
}

/// 提交一次完整的 staging 解压结果。
///
/// Windows 不支持 rename 覆盖目录，因此先把旧 project 目录移到同级 backup，
/// 再把 staging 目录改名为正式目录；新目录改名失败时尝试恢复 backup。
pub(crate) fn commit_cache_staging(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    staging_root: &Path,
) -> Result<(), String> {
    ensure_cache_project_id(project_id)?;
    reject_link(staging_root, " staging")?;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("extracted");
    reject_link(&base, " extracted")?;
    let final_root = base.join(project_id.to_string());
    reject_link(&final_root, "缓存")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let backup = base.join(format!(
        ".previous-{}-{}-{}",
        project_id,
        std::process::id(),
        stamp
    ));
    let had_previous = final_root.exists();
    if had_previous {
        stdfs::rename(&final_root, &backup)
            .map_err(|e| format!("移动旧缓存目录失败: {}", e))?;
    }
    if let Err(error) = stdfs::rename(staging_root, &final_root) {
        if had_previous {
            let _ = stdfs::rename(&backup, &final_root);
        }
        return Err(format!("提交缓存 staging 目录失败: {}", error));
    }
    // 旧目录不再参与缓存命中；清理失败不影响新目录的有效性，避免把一
    // 次成功解压误报成失败。下次可安全清理残留的 .previous-* 目录。
    if had_previous {
        let _ = remove_cache_dir_if_safe(&backup, "旧缓存");
    }
    Ok(())
}

pub(crate) fn remove_cache_dir_if_safe(path: &Path, label: &str) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    reject_link(path, label)?;
    for entry in stdfs::read_dir(path).map_err(|e| format!("读取缓存{}目录失败: {}", label, e))?
    {
        let child = entry
            .map_err(|e| format!("读取缓存{}目录项失败: {}", label, e))?
            .path();
        reject_link(&child, label)?;
        if child.is_dir() {
            remove_cache_dir_if_safe(&child, label)?;
        } else {
            stdfs::remove_file(&child).map_err(|e| format!("删除缓存{}文件失败: {}", label, e))?;
        }
    }
    stdfs::remove_dir(path).map_err(|e| format!("删除缓存{}目录失败: {}", label, e))?;
    Ok(true)
}

/// 计算缓存文件路径：app_data_dir/extracted/{project_id}/{entry_path}
/// entry_path 通过组件级校验（只允许 Normal 组件），防止 ../ 和 \..\ 穿越。
/// 最终路径必须位于 app_data_dir/extracted/{project_id}/ 下。
pub(crate) fn cache_file_path(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    entry_path: &str,
) -> Result<PathBuf, String> {
    ensure_cache_project_id(project_id)?;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;

    let safe_rel = validate_entry_path(entry_path)?;

    // 构建预期根目录：app_data_dir/extracted/{project_id}
    let root = base.join("extracted").join(project_id.to_string());
    if !root.exists() {
        stdfs::create_dir_all(&root).map_err(|e| format!("创建缓存目录失败: {}", e))?;
    }
    reject_link(&root, "")?;

    // 规范化根目录用于 containment 校验（此时 root 已存在，canonicalize 必成功）
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("规范化缓存根目录失败: {}", e))?;

    // 逐级创建并检查父目录，避免已有 symlink/junction 绕过 starts_with 校验。
    let parent_rel = safe_rel.parent().unwrap_or_else(|| Path::new(""));
    let canonical_parent = ensure_cache_parent(&canonical_root, parent_rel, "")?;
    let file_name = safe_rel.file_name().ok_or("entry_path 缺少文件名")?;
    let full = canonical_parent.join(file_name);

    // defense-in-depth：校验最终路径仍在 canonical_root 之下
    if !full.starts_with(&canonical_root) {
        return Err("路径越界".to_string());
    }

    reject_link(&full, "文件")?;

    Ok(full)
}

/// 校验数据库中保存的 local_cache_path 是否正好对应由 project_id + entry_path
/// 计算出的缓存位置。数据库文件可能被用户或旧版本篡改，不能直接对其中的
/// 任意路径调用 metadata/read。
fn is_expected_cache_path(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    entry_path: &str,
    candidate: &Path,
) -> Result<bool, String> {
    ensure_cache_project_id(project_id)?;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    let relative = validate_entry_path(entry_path)?;
    let root = base.join("extracted").join(project_id.to_string());
    if reject_link(&root, " IFC").is_err() {
        return Ok(false);
    }
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let expected = canonical_root.join(relative);
    let norm = |path: &Path| {
        let mut s = path.to_string_lossy().replace('\\', "/");
        #[cfg(windows)]
        {
            s = s.to_ascii_lowercase();
        }
        // `std::fs::canonicalize` may return an extended-length Windows path
        // (`\\\\?\\C:` / `//?/C:`), while older entries persisted the same
        // cache path without that prefix.  They identify the same file; keep
        // the containment check strict but compare a canonical prefix form.
        if let Some(rest) = s.strip_prefix("//?/unc/") {
            s = format!("//{}", rest);
        } else if let Some(rest) = s.strip_prefix("//?/") {
            s = rest.to_string();
        }
        while s.ends_with('/') {
            s.pop();
        }
        s
    };
    if norm(candidate) != norm(&expected) {
        return Ok(false);
    }
    let mut current = canonical_root;
    reject_link(&current, " IFC")?;
    for component in validate_entry_path(entry_path)?.components() {
        let Component::Normal(part) = component else {
            return Ok(false);
        };
        current.push(part);
        if current.exists() {
            reject_link(&current, " IFC")?;
        }
    }
    Ok(true)
}

/// 批量读取专用的缓存根目录解析。
///
/// `cache_file_path` 为单文件读写提供了最严格的逐次 canonicalize 防护；
/// 线路语义读取在同一 command 内反复使用同一个 project 根目录，若每条
/// entry 都重复 canonicalize，会让路径解析本身成为主要耗时。这里先把
/// 根目录规范化一次，再对每个相对组件做轻量 reparse-point 检查。
pub(crate) fn cache_project_root_for_batch(
    app_handle: &tauri::AppHandle,
    project_id: i64,
) -> Result<PathBuf, String> {
    ensure_cache_project_id(project_id)?;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("extracted");
    if !base.exists() {
        stdfs::create_dir_all(&base).map_err(|e| format!("创建 extracted 目录失败: {}", e))?;
    }
    reject_link(&base, " extracted")?;
    if !base.is_dir() {
        return Err(format!("extracted 路径不是目录: {}", base.display()));
    }
    let root = base.join(project_id.to_string());
    if !root.exists() {
        stdfs::create_dir_all(&root).map_err(|e| format!("创建缓存根目录失败: {}", e))?;
    }
    reject_link(&root, "缓存")?;
    if !root.is_dir() {
        return Err(format!("缓存根路径不是目录: {}", root.display()));
    }
    root.canonicalize()
        .map_err(|e| format!("规范化缓存根目录失败: {}", e))
}

/// 在已经 canonicalize 的缓存根目录下解析一条 entry。
pub(crate) struct BatchCachePathResolver {
    root: PathBuf,
    /// 同一批 entry 通常共享 Cbm/Dev/Mod/Phm 等父目录。缓存已经检查过
    /// 的目录，避免为每个文件重复触发 Windows reparse-point 元数据查询。
    checked_dirs: HashSet<PathBuf>,
}

impl BatchCachePathResolver {
    pub(crate) fn new(root: &Path) -> Result<Self, String> {
        reject_link(root, "缓存")?;
        if !root.is_dir() {
            return Err(format!("缓存根路径不是目录: {}", root.display()));
        }
        let mut checked_dirs = HashSet::new();
        checked_dirs.insert(root.to_path_buf());
        Ok(Self {
            root: root.to_path_buf(),
            checked_dirs,
        })
    }

    pub(crate) fn resolve(&mut self, entry_path: &str) -> Result<PathBuf, String> {
        let relative = validate_entry_path(entry_path)?;
        let mut current = self.root.clone();
        for component in relative.parent().unwrap_or_else(|| Path::new("")).components() {
            let Component::Normal(part) = component else {
                return Err("缓存 entry_path 父目录组件无效".to_string());
            };
            current.push(part);
            if !current.exists() {
                continue;
            }
            if self.checked_dirs.insert(current.clone()) {
                reject_link(&current, "")?;
                if !current.is_dir() {
                    return Err(format!("缓存路径组件不是目录: {}", current.display()));
                }
            }
        }
        let full = self.root.join(relative);
        if !full.starts_with(&self.root) {
            return Err("缓存路径越界".to_string());
        }
        // 文件自身仍逐条检查，避免把 symlink/junction 当作缓存命中。
        reject_link(&full, "文件")?;
        Ok(full)
    }
}

/// Tauri command：以 Raw IPC 写入缓存文件，避免 Vec<u8> JSON 数字数组膨胀。
#[tauri::command]
pub fn write_cache_file_binary(
    app_handle: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let (meta, bytes) = decode_binary_cache_write_request(&request)?;
    let conn = app_handle.state::<DbState>();
    let guard = conn
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&guard, meta.project_id)?;
    drop(guard);
    let path = cache_file_path(&app_handle, meta.project_id, &meta.entry_path)?;
    atomic_write(&path, &bytes, "")?;
    Ok(path.to_string_lossy().to_string())
}

/// Tauri command：读取缓存的 IFC 文件（路径由 project_id + entry_path 计算，不接受任意路径）
#[tauri::command]
pub fn read_cached_ifc(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
) -> Result<tauri::ipc::Response, String> {
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    let path = cache_file_path(&app_handle, project_id, &entry_path)?;
    let bytes = stdfs::read(&path).map_err(|e| format!("读取缓存文件失败: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Tauri command：读取 extracted/{project_id} 下的任意 GIM 条目。
///
/// 与 read_cached_ifc 相同，目标路径只由 project_id + entry_path 计算，
/// 不接受前端传入的绝对路径，供原生解压后的磁盘懒读 File 适配器使用。
#[tauri::command]
pub fn read_cached_entry(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
) -> Result<tauri::ipc::Response, String> {
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    let path = cache_file_path(&app_handle, project_id, &entry_path)?;
    let bytes = match stdfs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // 线路原生解压会把 parser 文本放入连续 semantic pack，避免数万
            // 个小文件 open。source/几何查看仍沿用原来的单条 API；只有
            // pack-backed 条目才在这里按 offset 懒读，普通缓存行为不变。
            let root = cache_project_root_for_batch(&app_handle, project_id)?;
            match read_line_semantic_pack_entry(&root, &entry_path)? {
                Some(bytes) => bytes,
                None => return Err(format!("读取缓存条目失败: {}", error)),
            }
        }
        Err(error) => return Err(format!("读取缓存条目失败: {}", error)),
    };
    Ok(tauri::ipc::Response::new(bytes))
}

/// 批量读取缓存文件的返回项
#[derive(Debug, Serialize)]
pub struct BatchCacheFileResult {
    pub entry_path: String,
    /// 成功时包含文件字节，失败时为 null
    pub bytes: Option<Vec<u8>>,
}

/// 将批量读取结果编码为 GIMR v2 envelope。线路 semantic pack 与普通批量
/// 文件读取共享此编码器，确保 WebView 端只需维护一套 transferable 解析器。
fn encode_batch_cache_response(
    results: Vec<BatchCacheFileResult>,
    total_bytes: u64,
    hit_count: u32,
    read_ms: f64,
    resolve_ms: f64,
    total_started: Instant,
) -> Result<Vec<u8>, String> {
    const HEADER_SIZE_V2: usize = 57;
    let encode_started = Instant::now();
    let mut out = Vec::new();
    out.reserve(HEADER_SIZE_V2);
    out.extend_from_slice(b"GIMR");
    out.push(2);
    let count = u32::try_from(results.len()).map_err(|_| "批量读取结果条目数溢出".to_string())?;
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&read_ms.to_le_bytes());
    out.extend_from_slice(&resolve_ms.to_le_bytes());
    // encode_ms/total_ms 在所有 item 写入后回填。
    out.extend_from_slice(&0.0_f64.to_le_bytes());
    out.extend_from_slice(&0.0_f64.to_le_bytes());
    out.extend_from_slice(&total_bytes.to_le_bytes());
    out.extend_from_slice(&hit_count.to_le_bytes());
    out.extend_from_slice(&count.saturating_sub(hit_count).to_le_bytes());
    for item in results {
        let path = item.entry_path.as_bytes();
        let path_len = u32::try_from(path.len()).map_err(|_| "批量读取路径过长".to_string())?;
        out.extend_from_slice(&path_len.to_le_bytes());
        out.extend_from_slice(path);
        match item.bytes {
            Some(bytes) => {
                out.push(1);
                out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
                out.extend_from_slice(&bytes);
            }
            None => {
                out.push(0);
                out.extend_from_slice(&0u64.to_le_bytes());
            }
        }
    }
    let encode_ms = encode_started.elapsed().as_secs_f64() * 1000.0;
    out[25..33].copy_from_slice(&encode_ms.to_le_bytes());
    let total_ms = total_started.elapsed().as_secs_f64() * 1000.0;
    out[33..41].copy_from_slice(&total_ms.to_le_bytes());
    Ok(out)
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
) -> Result<tauri::ipc::Response, String> {
    let total_started = Instant::now();
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    if entry_paths.len() > MAX_BATCH_CACHE_FILES {
        return Err("批量读取缓存文件数量超过安全上限".to_string());
    }
    // 同一批次共享 project 根目录；逐条只做相对路径和 reparse-point
    // 检查，避免重复 app_data_dir/canonicalize 带来的秒级开销。
    let batch_root = cache_project_root_for_batch(&app_handle, project_id)?;
    let mut path_resolver = BatchCachePathResolver::new(&batch_root)?;
    let mut results = Vec::with_capacity(entry_paths.len());
    let mut total_bytes: u64 = 0;
    let mut resolve_ms = 0.0_f64;
    let mut read_ms = 0.0_f64;
    let mut hit_count: u32 = 0;
    for entry_path in &entry_paths {
        let resolve_started = Instant::now();
        let path = match path_resolver.resolve(entry_path) {
            Ok(p) => p,
            Err(_) => {
                resolve_ms += resolve_started.elapsed().as_secs_f64() * 1000.0;
                results.push(BatchCacheFileResult {
                    entry_path: entry_path.clone(),
                    bytes: None,
                });
                continue;
            }
        };
        resolve_ms += resolve_started.elapsed().as_secs_f64() * 1000.0;
        let read_started = Instant::now();
        let bytes = stdfs::read(&path).ok();
        read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
        if let Some(ref data) = bytes {
            hit_count = hit_count.saturating_add(1);
            total_bytes = total_bytes
                .checked_add(data.len() as u64)
                .ok_or_else(|| "批量读取缓存文件总量溢出".to_string())?;
            if total_bytes > MAX_BATCH_CACHE_BYTES {
                return Err("批量读取缓存文件总量超过安全上限".to_string());
            }
        }
        results.push(BatchCacheFileResult {
            entry_path: entry_path.clone(),
            bytes,
        });
    }
    // GIMR v2：在原有 item 列表前附加 Rust 内部阶段计时。旧 WebView
    // 仍可解析 v1；新 WebView 只把这些字段写入 perfTimings，不改变业务 Map API。
    let out = encode_batch_cache_response(
        results,
        total_bytes,
        hit_count,
        read_ms,
        resolve_ms,
        total_started,
    )?;
    Ok(tauri::ipc::Response::new(out))
}

/// Tauri command：一次读取线路语义 pack 中的多个文本条目。
///
/// 原生冷启动只为线路 parser 保留一个连续 pack，避免 batch_read_cached_files
/// 对两万多个 CBM/FAM/DEV 文件逐个 open。索引先在 Rust 侧解析，数据文件只
/// 打开/读取一次；返回格式仍是 GIMR v2，因此 WebView 的 bytes/阶段埋点可复用。
#[tauri::command]
pub fn read_line_semantic_pack(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_paths: Vec<String>,
) -> Result<tauri::ipc::Response, String> {
    let total_started = Instant::now();
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    if entry_paths.len() > MAX_BATCH_CACHE_FILES {
        return Err("线路语义 pack 读取条目数超过安全上限".to_string());
    }
    let root = cache_project_root_for_batch(&app_handle, project_id)?;
    let (index, pack_len) = read_line_semantic_pack_files(&root, false)?;
    let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
    // 只打开一次 pack，并按索引区间读取请求项；不要把整个 pack 复制到
    // Rust 堆再切片。正常请求按 manifest 顺序到达，读取仍接近顺序 IO；
    // 即使请求顺序被调用方改变，也只产生 seek，不会增加 IPC 次数或峰值内存。
    let mut pack_file = stdfs::File::open(&pack_path)
        .map_err(|e| format!("打开线路语义 pack 失败: {}", e))?;

    let mut results = Vec::with_capacity(entry_paths.len());
    let mut total_bytes: u64 = 0;
    let mut hit_count: u32 = 0;
    let mut resolve_ms = 0.0_f64;
    let mut read_ms = 0.0_f64;
    for requested_path in &entry_paths {
        let resolve_started = Instant::now();
        let resolved = validate_entry_path(requested_path)
            .ok()
            .and_then(|_| index.get(&normalize_cache_lookup_path(requested_path)));
        resolve_ms += resolve_started.elapsed().as_secs_f64() * 1000.0;
        let bytes = if let Some(entry) = resolved.filter(|entry| entry.packed) {
            let end = entry
                .offset
                .checked_add(entry.size)
                .ok_or_else(|| {
                    semantic_error(
                        "PACK_TRUNCATED",
                        format!("线路语义 pack 条目偏移溢出: {}", requested_path),
                    )
                })?;
            if end > pack_len {
                return Err(semantic_error(
                    "PACK_TRUNCATED",
                    format!("线路语义 pack 条目越界: {}", requested_path),
                ));
            }
            let start = usize::try_from(entry.offset)
                .map_err(|_| semantic_error("PACK_TRUNCATED", "线路语义 pack 条目偏移超过平台限制"))?;
            let end = usize::try_from(end)
                .map_err(|_| semantic_error("PACK_TRUNCATED", "线路语义 pack 条目末端超过平台限制"))?;
            let mut data = vec![0u8; end - start];
            use std::io::{Read, Seek, SeekFrom};
            let read_started = Instant::now();
            pack_file
                .seek(SeekFrom::Start(entry.offset))
                .map_err(|e| semantic_error("PACK_INVALID", format!("定位线路语义 pack 失败: {} — {}", requested_path, e)))?;
            pack_file
                .read_exact(&mut data)
                .map_err(|e| semantic_error("PACK_TRUNCATED", format!("读取线路语义 pack 条目失败: {} — {}", requested_path, e)))?;
            read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
            hit_count = hit_count.saturating_add(1);
            total_bytes = total_bytes
                .checked_add(data.len() as u64)
                .ok_or_else(|| "线路语义 pack 读取总量溢出".to_string())?;
            if total_bytes > MAX_BATCH_CACHE_BYTES {
                return Err("线路语义 pack 读取总量超过安全上限".to_string());
            }
            Some(data)
        } else {
            None
        };
        results.push(BatchCacheFileResult {
            entry_path: requested_path.clone(),
            bytes,
        });
    }
    let out = encode_batch_cache_response(
        results,
        total_bytes,
        hit_count,
        read_ms,
        resolve_ms,
        total_started,
    )?;
    Ok(tauri::ipc::Response::new(out))
}

/// semantic pack full-read 的二进制 envelope。
///
/// `GIMF` v1 头部：magic(4) + version(1) + count(u32) +
/// index/resolve/read/encode/total(f64×5) + packed_bytes(u64) +
/// packed_count(u32)。每项为 path_len(u32)+path+flags(u8)+size(u64)+
/// data_len(u64)+data。metadata-only 项 flags=0、data_len=0，但保留
/// 原始 size，使 WebView 可以创建 lazy DiskBackedFile。
const LINE_SEMANTIC_FULL_MAGIC: &[u8; 4] = b"GIMF";
const LINE_SEMANTIC_FULL_VERSION: u8 = 1;
const LINE_SEMANTIC_FULL_HEADER: usize = 61;
const LINE_SEMANTIC_FULL_FLAG_PACKED: u8 = 0x01;
const MAX_LINE_SEMANTIC_FULL_RESPONSE_BYTES: u64 =
    MAX_LINE_SEMANTIC_PACK_BYTES + 64 * 1024 * 1024;

fn encode_line_semantic_pack_full_header(
    count: u32,
    index_ms: f64,
    resolve_ms: f64,
    read_ms: f64,
    packed_bytes: u64,
    packed_count: u32,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(LINE_SEMANTIC_FULL_HEADER);
    out.extend_from_slice(LINE_SEMANTIC_FULL_MAGIC);
    out.push(LINE_SEMANTIC_FULL_VERSION);
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&index_ms.to_le_bytes());
    out.extend_from_slice(&resolve_ms.to_le_bytes());
    out.extend_from_slice(&read_ms.to_le_bytes());
    // encodeMs / totalMs 在全部 item 完成后回填。
    out.extend_from_slice(&0.0_f64.to_le_bytes());
    out.extend_from_slice(&0.0_f64.to_le_bytes());
    out.extend_from_slice(&packed_bytes.to_le_bytes());
    out.extend_from_slice(&packed_count.to_le_bytes());
    out
}

/// Tauri command：一次读取完整线路 semantic pack，并返回 metadata-only 条目。
///
/// 与旧 `read_line_semantic_pack(project_id, entry_paths)` 不同，WebView 不
/// 再传递两万条路径；Rust 直接按 index 返回全部条目。整体 index/pack
/// 损坏会返回带前缀的错误，调用方必须让 semantic source cache 失效并重建，
/// 不得退化成逐条读取后提交 partial Runtime。
#[tauri::command]
pub fn read_line_semantic_pack_all(
    app_handle: tauri::AppHandle,
    project_id: i64,
) -> Result<tauri::ipc::Response, String> {
    let total_started = Instant::now();
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    let root = cache_project_root_for_batch(&app_handle, project_id)?;
    let index_started = Instant::now();
    let (index, pack_len) = read_line_semantic_pack_files(&root, true)?;
    let index_ms = index_started.elapsed().as_secs_f64() * 1000.0;
    // `resolveMs` covers all work after the index bytes have been validated and
    // before any semantic payload is read: collecting entries from the lookup
    // map, deterministic ordering, count/size arithmetic and response-size
    // validation. Keep it separate from `readMs` so the latter represents only
    // file seek/read operations.
    let resolve_started = Instant::now();
    let mut entries: Vec<LineSemanticPackEntry> = index.into_values().collect();
    // HashMap 只用于大小写不敏感查找；full-read 使用稳定排序，避免不同
    // Rust 进程的随机 hash seed 改变 Worker 输入/导航顺序。
    entries.sort_by(|a, b| normalize_cache_lookup_path(&a.path).cmp(&normalize_cache_lookup_path(&b.path)));
    let count = u32::try_from(entries.len())
        .map_err(|_| semantic_error("INDEX_INVALID", "线路语义 pack 条目数溢出"))?;
    let packed_count = entries.iter().filter(|entry| entry.packed).count();
    let packed_count = u32::try_from(packed_count)
        .map_err(|_| semantic_error("INDEX_INVALID", "线路语义 pack packed 条目数溢出"))?;
    let packed_bytes = entries
        .iter()
        .filter(|entry| entry.packed)
        .try_fold(0u64, |sum, entry| sum.checked_add(entry.size))
        .ok_or_else(|| semantic_error("PACK_TRUNCATED", "线路语义 pack 总大小溢出"))?;
    let response_overhead = entries.iter().try_fold(0u64, |sum, entry| {
        let path_len = u64::try_from(entry.path.as_bytes().len()).ok()?;
        sum.checked_add(4 + path_len + 1 + 8 + 8)
    }).ok_or_else(|| semantic_error("INDEX_INVALID", "线路语义 pack 响应大小溢出"))?;
    let expected_response = u64::try_from(LINE_SEMANTIC_FULL_HEADER)
        .ok()
        .and_then(|v| v.checked_add(response_overhead))
        .and_then(|v| v.checked_add(packed_bytes))
        .ok_or_else(|| semantic_error("PACK_INVALID", "线路语义 pack 响应大小溢出"))?;
    if expected_response > MAX_LINE_SEMANTIC_FULL_RESPONSE_BYTES {
        return Err(semantic_error(
            "PACK_INVALID",
            format!("线路语义 pack full response 超过安全上限（>{} bytes）", MAX_LINE_SEMANTIC_FULL_RESPONSE_BYTES),
        ));
    }
    let resolve_ms = resolve_started.elapsed().as_secs_f64() * 1000.0;
    let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
    let mut pack_file = stdfs::File::open(&pack_path)
        .map_err(|e| semantic_error("PACK_INVALID", format!("打开线路语义 pack 失败: {}", e)))?;
    use std::io::{Read, Seek, SeekFrom};
    let mut out = encode_line_semantic_pack_full_header(
        count,
        index_ms,
        resolve_ms,
        0.0,
        packed_bytes,
        packed_count,
    );
    let mut read_ms = 0.0_f64;
    let mut encode_ms = 0.0_f64;
    for entry in entries {
        let path = entry.path.as_bytes();
        let path_len = u32::try_from(path.len())
            .map_err(|_| semantic_error("INDEX_INVALID", format!("线路语义 pack 路径过长: {}", entry.path)))?;
        let data = if entry.packed {
            let size = usize::try_from(entry.size)
                .map_err(|_| semantic_error("PACK_TRUNCATED", format!("线路语义 pack 条目大小超过平台限制: {}", entry.path)))?;
            let mut data = vec![0u8; size];
            let read_started = Instant::now();
            pack_file
                .seek(SeekFrom::Start(entry.offset))
                .map_err(|e| semantic_error("PACK_INVALID", format!("定位线路语义 pack 失败: {} — {}", entry.path, e)))?;
            pack_file
                .read_exact(&mut data)
                .map_err(|e| semantic_error("PACK_TRUNCATED", format!("读取线路语义 pack 条目失败: {} — {}", entry.path, e)))?;
            read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
            Some(data)
        } else {
            None
        };
        // 只把 envelope 拼装计入 encodeMs；entry 的 seek/read 已在 readMs
        // 单独计时，避免阶段互相重叠导致性能报告误判瓶颈。
        let encode_item_started = Instant::now();
        out.extend_from_slice(&path_len.to_le_bytes());
        out.extend_from_slice(path);
        out.push(if entry.packed { LINE_SEMANTIC_FULL_FLAG_PACKED } else { 0 });
        out.extend_from_slice(&entry.size.to_le_bytes());
        if let Some(data) = data {
            out.extend_from_slice(&(data.len() as u64).to_le_bytes());
            out.extend_from_slice(&data);
        } else {
            out.extend_from_slice(&0u64.to_le_bytes());
        }
        encode_ms += encode_item_started.elapsed().as_secs_f64() * 1000.0;
        let response_bytes = u64::try_from(out.len()).unwrap_or(u64::MAX);
        if response_bytes > MAX_LINE_SEMANTIC_FULL_RESPONSE_BYTES {
            return Err(semantic_error("PACK_INVALID", "线路语义 pack full response 超过安全上限"));
        }
    }
    let total_ms = total_started.elapsed().as_secs_f64() * 1000.0;
    out[25..33].copy_from_slice(&read_ms.to_le_bytes());
    out[33..41].copy_from_slice(&encode_ms.to_le_bytes());
    out[41..49].copy_from_slice(&total_ms.to_le_bytes());
    let _ = pack_len;
    Ok(tauri::ipc::Response::new(out))
}

// ===== GLB 几何缓存（方案 C：MOD → glTF 离线预序列化） =====

/// GLB warm fast path 的单次批读上限。前端按 manifest 中的 size 在此边界
/// 内组批；单个超大 DEV 允许独占一个批次，避免因为一个合法大模型直接回退
/// 原始 MOD。
const MAX_GLB_BATCH_FILES: usize = 256;
const MAX_GLB_BATCH_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SINGLE_GLB_BYTES: u64 = 512 * 1024 * 1024;

/// 计算 GLB 缓存文件路径：app_data_dir/glbcache/{project_id}/{entry_path}.glb
///
/// 与 `cache_file_path`（extracted/）和 `fragment_cache_file_path`（fragments/）并列，
/// 独立目录存放序列化后的 glTF 二进制，便于版本失效时整体删除。
///
/// entry_path 通过组件级校验（只允许 Normal 组件），防止 ../ 和 \..\ 穿越。
fn glb_cache_file_path(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    entry_path: &str,
) -> Result<PathBuf, String> {
    ensure_cache_project_id(project_id)?;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;

    let safe_rel = validate_entry_path(entry_path)?;

    // 追加 .glb 后缀到文件名
    let mut glb_rel = safe_rel;
    let file_name = glb_rel
        .file_name()
        .map(|n| format!("{}.glb", n.to_string_lossy()))
        .ok_or("无法获取 glb 文件名")?;
    glb_rel.set_file_name(file_name);

    // 构建预期根目录：app_data_dir/glbcache/{project_id}
    let root = base.join("glbcache").join(project_id.to_string());
    if !root.exists() {
        stdfs::create_dir_all(&root).map_err(|e| format!("创建 glbcache 目录失败: {}", e))?;
    }
    reject_link(&root, " GLB")?;

    // 规范化根目录用于 containment 校验
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("规范化 glbcache 根目录失败: {}", e))?;

    let parent_rel = glb_rel.parent().unwrap_or_else(|| Path::new(""));
    let canonical_parent = ensure_cache_parent(&canonical_root, parent_rel, " GLB")?;
    let file_name = glb_rel.file_name().ok_or("无法获取 glb 文件名")?;
    let full = canonical_parent.join(file_name);

    if !full.starts_with(&canonical_root) {
        return Err("路径越界".to_string());
    }

    reject_link(&full, " GLB 文件")?;

    Ok(full)
}

/// Tauri command：以 Raw IPC 写入 GLB 缓存文件。
#[tauri::command]
pub fn write_glb_file_binary(
    app_handle: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let (meta, bytes) = decode_binary_cache_write_request(&request)?;
    let conn = app_handle.state::<DbState>();
    let guard = conn
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&guard, meta.project_id)?;
    drop(guard);
    let path = glb_cache_file_path(&app_handle, meta.project_id, &meta.entry_path)?;
    atomic_write(&path, &bytes, " GLB")?;
    Ok(path.to_string_lossy().to_string())
}

/// Tauri command：读取 GLB 缓存文件
///
/// 返回 `tauri::ipc::Response`（原始二进制），避免 `Vec<u8>` 经 JSON 序列化为
/// 数字数组带来的 3x 体积膨胀和解析开销。JS 侧 `invoke` 返回 `ArrayBuffer`。
#[tauri::command]
pub fn read_glb_file(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
) -> Result<tauri::ipc::Response, String> {
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    let path = glb_cache_file_path(&app_handle, project_id, &entry_path)?;
    let bytes = stdfs::read(&path).map_err(|e| format!("读取 glb 缓存文件失败: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Tauri command：批量读取 DEV GLB 缓存文件。
///
/// 请求仍只携带受校验的 entry_path 列表，响应使用 GIMR v2 二进制 envelope，
/// 不把 GLB 编码成 JSON 数字数组。单条文件缺失返回 envelope 中的 null；
/// 前端根据 manifest 将其判定为 fast path 整体不可用并回退原始 MOD。
#[tauri::command]
pub fn batch_read_glb_files(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_paths: Vec<String>,
) -> Result<tauri::ipc::Response, String> {
    let total_started = Instant::now();
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    if entry_paths.len() > MAX_GLB_BATCH_FILES {
        return Err("批量读取 GLB 文件数量超过安全上限".to_string());
    }

    let mut results = Vec::with_capacity(entry_paths.len());
    let mut total_bytes: u64 = 0;
    let mut hit_count: u32 = 0;
    let mut resolve_ms = 0.0_f64;
    let mut read_ms = 0.0_f64;
    for entry_path in &entry_paths {
        let resolve_started = Instant::now();
        let path = match glb_cache_file_path(&app_handle, project_id, entry_path) {
            Ok(path) => path,
            Err(_) => {
                resolve_ms += resolve_started.elapsed().as_secs_f64() * 1000.0;
                results.push(BatchCacheFileResult {
                    entry_path: entry_path.clone(),
                    bytes: None,
                });
                continue;
            }
        };
        resolve_ms += resolve_started.elapsed().as_secs_f64() * 1000.0;
        let read_started = Instant::now();
        let bytes = match stdfs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            // 对权限/IO 错误也返回单条 miss；调用方会放弃 fast path，
            // 但不会把一个不可读的缓存当作完整几何继续提交。
            Err(_) => None,
        };
        read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
        if let Some(ref data) = bytes {
            hit_count = hit_count.saturating_add(1);
            total_bytes = total_bytes
                .checked_add(data.len() as u64)
                .ok_or_else(|| "批量读取 GLB 总量溢出".to_string())?;
            let oversized_single = entry_paths.len() == 1
                && data.len() as u64 <= MAX_SINGLE_GLB_BYTES;
            if total_bytes > MAX_GLB_BATCH_BYTES && !oversized_single {
                return Err(format!(
                    "批量读取 GLB 总量超过安全上限（>{} bytes）",
                    MAX_GLB_BATCH_BYTES
                ));
            }
        }
        results.push(BatchCacheFileResult {
            entry_path: entry_path.clone(),
            bytes,
        });
    }
    let out = encode_batch_cache_response(
        results,
        total_bytes,
        hit_count,
        read_ms,
        resolve_ms,
        total_started,
    )?;
    Ok(tauri::ipc::Response::new(out))
}

/// 方案 C：检查 GLB 几何缓存版本是否匹配。
///
/// 读取 `{app_data_dir}/glbcache/{project_id}/_version.txt` 文件内容
/// 与 GEOMETRY_CACHE_VERSION 常量比较。
///
/// 返回值：
/// - true：版本文件存在且内容等于 GEOMETRY_CACHE_VERSION
/// - false：版本文件不存在（首次打开或旧版本无 marker）/ 内容不匹配 / IO 错误
///
/// 注意：调用方应将 false 视为缓存无效，触发 delete_project_cache + 重序列化。
fn check_geometry_cache_version(app_handle: &tauri::AppHandle, project_id: i64) -> bool {
    let base = match app_handle.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let marker = base
        .join("glbcache")
        .join(project_id.to_string())
        .join("_version.txt");
    if reject_link(&marker, "版本标记").is_err() {
        return false;
    }
    match stdfs::read_to_string(&marker) {
        Ok(content) => content.trim() == GEOMETRY_CACHE_VERSION,
        Err(_) => false,
    }
}

fn validate_glb_bytes(bytes: &[u8]) -> bool {
    // GLB header: magic "glTF", version 2, declared total length (LE u32).
    if bytes.len() < 12
        || &bytes[..4] != b"glTF"
        || u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) != 2
    {
        return false;
    }
    let declared = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    declared == bytes.len()
}

/// 校验磁盘上的 GLB 头，而不把完整文件读入 Rust 堆。
///
/// `validate_gim_cache` 在 warm restore 前会遍历 manifest；完整 GLB 内容随后
/// 由 `batch_read_glb_files` 统一读取一次。这里只读固定 12-byte header，避免
/// 预检阶段把每个 DEV 的 GLB 再完整读一遍。
fn validate_glb_file_header(path: &Path, expected_size: u64) -> bool {
    if expected_size < 12 || expected_size > u32::MAX as u64 {
        return false;
    }
    let Ok(mut file) = stdfs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; 12];
    use std::io::Read;
    if file.read_exact(&mut header).is_err() {
        return false;
    }
    &header[..4] == b"glTF"
        && u32::from_le_bytes([header[4], header[5], header[6], header[7]]) == 2
        && u32::from_le_bytes([header[8], header[9], header[10], header[11]]) as u64
            == expected_size
}

fn geometry_manifest_path(
    app_handle: &tauri::AppHandle,
    project_id: i64,
) -> Result<PathBuf, String> {
    ensure_cache_project_id(project_id)?;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    let root = base.join("glbcache").join(project_id.to_string());
    if !root.exists() {
        return Err("GLB 缓存目录不存在".to_string());
    }
    reject_link(&root, " GLB")?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("规范化 GLB 缓存目录失败: {}", e))?;
    let manifest = canonical_root.join("_manifest.json");
    reject_link(&manifest, " GLB manifest")?;
    Ok(manifest)
}

/// 校验一个 DEV geometry manifest 条目的结构。该检查不访问磁盘，供
/// `validate_gim_cache`、manifest 写入和单元测试共享；文件存在/GLB header
/// 校验由调用方在此结构检查通过后执行。
fn validate_geometry_manifest_entry_shape(
    entry: &GeometryCacheManifestEntry,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let normalized_path = normalize_cache_lookup_path(&entry.entry_path);
    validate_entry_path(&entry.entry_path)
        .map_err(|e| format!("GLB manifest entry_path 无效: {} ({})", entry.entry_path, e))?;
    if !normalized_path.starts_with("dev/") {
        return Err(format!("GLB manifest 只允许 DEV 条目: {}", entry.entry_path));
    }
    if !seen.insert(normalized_path) {
        return Err(format!("GLB manifest 条目重复: {}", entry.entry_path));
    }
    match entry.status.as_str() {
        "empty" if entry.size == 0 => Ok(()),
        "glb" if entry.size > 0 => Ok(()),
        "empty" => Err(format!("empty GLB manifest 条目大小必须为 0: {}", entry.entry_path)),
        "glb" => Err(format!("glb GLB manifest 条目大小必须大于 0: {}", entry.entry_path)),
        _ => Err(format!("GLB manifest 状态无效: {}", entry.entry_path)),
    }
}

/// 读取当前项目的 DEV geometry manifest。manifest 本身只描述 source/status/size；
/// GLB 文件及 header/长度由 fast path 和 validate_gim_cache 继续独立校验。
#[tauri::command]
pub fn read_geometry_cache_manifest(
    app_handle: tauri::AppHandle,
    project_id: i64,
) -> Result<GeometryCacheManifest, String> {
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    let path = geometry_manifest_path(&app_handle, project_id)?;
    let bytes = stdfs::read(&path).map_err(|e| format!("读取 GLB manifest 失败: {}", e))?;
    serde_json::from_slice::<GeometryCacheManifest>(&bytes)
        .map_err(|e| format!("解析 GLB manifest 失败: {}", e))
}

fn check_geometry_cache_manifest(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    source_sha256: &str,
) -> bool {
    let Ok(path) = geometry_manifest_path(app_handle, project_id) else {
        return false;
    };
    let Ok(bytes) = stdfs::read(path) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_slice::<GeometryCacheManifest>(&bytes) else {
        return false;
    };
    if manifest.source_sha256 != source_sha256 || manifest.entries.len() > 200_000 {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    for entry in manifest.entries {
        if validate_geometry_manifest_entry_shape(&entry, &mut seen).is_err() {
            return false;
        }
        if entry.status == "empty" {
            // empty 是确定性的合法结果，不存在对应 GLB 文件也不构成 miss。
            continue;
        }
        let Ok(glb_path) = glb_cache_file_path(app_handle, project_id, &entry.entry_path) else {
            return false;
        };
        let Ok(meta) = stdfs::metadata(&glb_path) else {
            return false;
        };
        if meta.len() != entry.size {
            return false;
        }
        // Only inspect the fixed header here. The warm fast path's binary batch
        // read performs the one full-file read and repeats size/header checks
        // on the returned bytes before parsing.
        if !validate_glb_file_header(&glb_path, entry.size) {
            return false;
        }
    }
    true
}

/// 写入 GLB manifest（版本标记之前的最后一步）。
#[tauri::command]
pub fn write_geometry_cache_manifest(
    app_handle: tauri::AppHandle,
    project_id: i64,
    source_sha256: String,
    entries: Vec<GeometryCacheManifestEntry>,
) -> Result<String, String> {
    if source_sha256.trim().is_empty() || source_sha256.len() > 128 {
        return Err("source_sha256 无效".to_string());
    }
    if entries.len() > 200_000 {
        return Err("GLB manifest 条目数超限".to_string());
    }
    {
        let state = app_handle.state::<DbState>();
        let guard = state
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
        ensure_project_source_sha(&guard, project_id, Some(&source_sha256))?;
    }
    let mut seen = std::collections::HashSet::new();
    for entry in &entries {
        if let Err(error) = validate_geometry_manifest_entry_shape(entry, &mut seen) {
            return Err(error);
        }
        if entry.status == "empty" {
            // empty 为确定性 tombstone：不要求磁盘上存在零字节占位文件。
            continue;
        }
        let path = glb_cache_file_path(&app_handle, project_id, &entry.entry_path)?;
        let meta =
            stdfs::metadata(&path).map_err(|e| format!("读取 GLB manifest 条目失败: {}", e))?;
        if meta.len() != entry.size {
            return Err(format!("GLB 大小与 manifest 不一致: {}", entry.entry_path));
        }
        let glb = stdfs::read(&path).map_err(|e| format!("读取 GLB 失败: {}", e))?;
        if !validate_glb_bytes(&glb) {
            return Err(format!(
                "GLB magic/version/length 校验失败: {}",
                entry.entry_path
            ));
        }
    }
    let path = geometry_manifest_path(&app_handle, project_id).or_else(|_| {
        let base = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
        let root = base.join("glbcache").join(project_id.to_string());
        stdfs::create_dir_all(&root).map_err(|e| format!("创建 GLB 目录失败: {}", e))?;
        reject_link(&root, " GLB")?;
        Ok::<PathBuf, String>(root.join("_manifest.json"))
    })?;
    let bytes = serde_json::to_vec(&GeometryCacheManifest {
        source_sha256,
        entries,
    })
    .map_err(|e| format!("序列化 GLB manifest 失败: {}", e))?;
    atomic_write(&path, &bytes, " GLB manifest")?;
    Ok(path.to_string_lossy().to_string())
}

/// Tauri command：写入 GLB 几何缓存版本标记文件。
///
/// 在 `cacheGlbFiles` 完成所有 MOD/STL → .glb 序列化后调用一次，
/// 把当前 GEOMETRY_CACHE_VERSION 写入 `{app_data_dir}/glbcache/{project_id}/_version.txt`。
/// 下次 `validate_gim_cache` 时读取此文件并比较，版本不匹配则整体失效。
#[tauri::command]
pub fn write_geometry_cache_version(
    app_handle: tauri::AppHandle,
    project_id: i64,
) -> Result<String, String> {
    ensure_cache_project_id(project_id)?;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    let dir = base.join("glbcache").join(project_id.to_string());
    if !dir.exists() {
        stdfs::create_dir_all(&dir).map_err(|e| format!("创建 glbcache 目录失败: {}", e))?;
    }
    reject_link(&dir, " GLB")?;
    let marker = dir.join("_version.txt");
    reject_link(&marker, "版本标记")?;
    atomic_write(&marker, GEOMETRY_CACHE_VERSION.as_bytes(), "版本标记")?;
    Ok(marker.to_string_lossy().to_string())
}

// ===== Fragments 缓存 =====

/// Fragments 文件完整性校验：记录大小必须为正且与磁盘实际大小完全一致。
/// 单纯“存在且非空”无法识别截断文件。
fn fragment_file_size_matches(stored: i64, actual: u64) -> bool {
    stored > 0 && actual == stored as u64
}

/// 诊断侧的 Fragments 版本兼容判断。
///
/// 前端实际写入的是 `fragments-cache-vN|fragments@...|web-ifc@...`，
/// Rust 侧只知道基础 schema 版本，因此诊断应识别同一基础版本的组合键；
/// 运行时 `validate_fragment_cache` 仍使用前端传入的完整组合键做严格匹配。
fn fragment_cache_version_matches(stored: &str) -> bool {
    stored == FRAGMENTS_CACHE_VERSION
        || stored.starts_with(&format!("{}|", FRAGMENTS_CACHE_VERSION))
}

/// 计算 Fragments 缓存文件路径：app_data_dir/fragments/{project_id}/{safe_entry_path}.frag
/// entry_path 通过组件级校验（只允许 Normal 组件），防止 ../ 和 \..\ 穿越。
/// 最终路径必须位于 app_data_dir/fragments/{project_id}/ 下。
fn fragment_cache_file_path(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    entry_path: &str,
) -> Result<PathBuf, String> {
    ensure_cache_project_id(project_id)?;
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
    if !root.exists() {
        stdfs::create_dir_all(&root).map_err(|e| format!("创建 fragments 缓存目录失败: {}", e))?;
    }
    reject_link(&root, " fragments")?;

    // 规范化根目录用于 containment 校验（此时 root 已存在，canonicalize 必成功）
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("规范化 fragments 根目录失败: {}", e))?;

    // 拼接最终路径（frag_rel 仅含 Normal 组件，join 不会逃逸 canonical_root）
    let parent_rel = frag_rel.parent().unwrap_or_else(|| Path::new(""));
    let canonical_parent = ensure_cache_parent(&canonical_root, parent_rel, " fragments")?;
    let file_name = frag_rel.file_name().ok_or("无法获取 fragments 文件名")?;
    let full = canonical_parent.join(file_name);

    // defense-in-depth：校验最终路径仍在 canonical_root 之下
    if !full.starts_with(&canonical_root) {
        return Err("路径越界".to_string());
    }

    reject_link(&full, " fragments 文件")?;

    Ok(full)
}

/// substation_fragment_cache 表记录
#[derive(Debug, Serialize)]
pub struct FragmentCacheRecord {
    pub id: i64,
    pub project_id: i64,
    pub entry_path: String,
    pub model_id: String,
    pub source_gim_sha256: String,
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
    pub source_gim_sha256: Option<String>,
    pub source_gim_sha256_match: bool,
    pub source_ifc_size_match: bool,
    pub fragment_file_exists: bool,
    pub fragment_file_size: u64,
    pub fragment_file_size_match: bool,
    pub valid: bool,
}

/// Tauri command：以 Raw IPC 写入 Fragments 缓存文件。
#[tauri::command]
pub fn write_fragment_cache_file_binary(
    app_handle: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<serde_json::Value, String> {
    let (meta, bytes) = decode_binary_cache_write_request(&request)?;
    let source_sha = meta
        .source_gim_sha256
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Fragments 缓存写入缺少 source_gim_sha256".to_string())?;
    let conn = app_handle.state::<DbState>();
    let guard = conn
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&guard, meta.project_id)?;
    // 在同一把数据库锁下核对源 SHA 并完成原子写入，避免工程切换时旧
    // 异步任务先覆盖当前 .frag、随后才在 upsert 阶段被拒绝。
    ensure_project_source_sha(&guard, meta.project_id, Some(source_sha))?;
    let path = fragment_cache_file_path(&app_handle, meta.project_id, &meta.entry_path)?;
    let size = bytes.len();
    atomic_write(&path, &bytes, " fragments")?;
    drop(guard);
    Ok(serde_json::json!({ "path": path.to_string_lossy(), "size": size }))
}

/// Tauri command：读取 Fragments 缓存文件
#[tauri::command]
pub fn read_fragment_cache_file(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
) -> Result<tauri::ipc::Response, String> {
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    let path = fragment_cache_file_path(&app_handle, project_id, &entry_path)?;
    let bytes = stdfs::read(&path).map_err(|e| format!("读取 fragments 缓存文件失败: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Tauri command：删除损坏的 Fragments 缓存记录与 .frag 文件（P0-3 自愈）。
///
/// 前端在反序列化/运行时校验失败时调用，避免下次打开继续命中坏缓存。
#[tauri::command]
pub fn delete_fragment_cache_record(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    project_id: i64,
    entry_path: String,
) -> Result<(), String> {
    {
        let guard = state
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    // 先删记录
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let res = conn.execute(
        "DELETE FROM substation_fragment_cache WHERE project_id = ?1 AND entry_path = ?2",
        params![project_id, entry_path],
    );
    if let Err(e) = res {
        return Err(format!("删除 substation_fragment_cache 记录失败: {}", e));
    }
    drop(conn);

    // 再删文件（失败仅告警，不阻断——记录已删，下次写入会重建）
    match fragment_cache_file_path(&app_handle, project_id, &entry_path) {
        Ok(path) => {
            if path.exists() {
                if let Err(e) = std::fs::remove_file(&path) {
                    eprintln!("[db] 删除 fragments 缓存文件失败（忽略）: {}", e);
                }
            }
        }
        Err(e) => eprintln!("[db] 解析 fragments 缓存路径失败（忽略）: {}", e),
    }
    Ok(())
}

/// Tauri command：upsert substation_fragment_cache 记录
#[tauri::command]
pub fn upsert_fragment_cache_record(
    state: tauri::State<'_, DbState>,
    project_id: i64,
    entry_path: String,
    model_id: String,
    source_ifc_size: i64,
    fragment_file_size: i64,
    cache_version: String,
    source_gim_sha256: String,
) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;
    // 写入记录前重新核对项目源身份，防止旧工程的异步任务在工程切换或
    // 同路径文件更新后把旧 SHA 记录写入当前项目。
    ensure_project_source_sha(&conn, project_id, Some(&source_gim_sha256))?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO substation_fragment_cache (project_id, entry_path, model_id, source_gim_sha256, source_ifc_size, fragment_file_size, fragments_version, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(project_id, entry_path) DO UPDATE SET
           model_id = ?3, source_gim_sha256 = ?4, source_ifc_size = ?5, fragment_file_size = ?6, fragments_version = ?7, updated_at_ms = ?9",
        params![project_id, entry_path, model_id, source_gim_sha256, source_ifc_size, fragment_file_size, cache_version, now, now],
    )
    .map_err(|e| format!("upsert substation_fragment_cache 失败: {}", e))?;
    Ok(())
}

/// Tauri command：查询 substation_fragment_cache 记录
#[tauri::command]
pub fn get_fragment_cache_record(
    state: tauri::State<'_, DbState>,
    project_id: i64,
    entry_path: String,
) -> Result<Option<FragmentCacheRecord>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;
    let res = conn.query_row(
        "SELECT id, project_id, entry_path, model_id, source_gim_sha256, source_ifc_size, fragment_file_size, fragments_version, created_at_ms, updated_at_ms
         FROM substation_fragment_cache
         WHERE project_id = ?1 AND entry_path = ?2",
        params![project_id, entry_path],
        |row| Ok(FragmentCacheRecord {
            id: row.get(0)?,
            project_id: row.get(1)?,
            entry_path: row.get(2)?,
            model_id: row.get(3)?,
            source_gim_sha256: row.get(4)?,
            source_ifc_size: row.get(5)?,
            fragment_file_size: row.get(6)?,
            fragments_version: row.get(7)?,
            created_at_ms: row.get(8)?,
            updated_at_ms: row.get(9)?,
        }),
    );
    match res {
        Ok(r) => Ok(Some(r)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("查询 substation_fragment_cache 失败: {}", e)),
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
    cache_version: String,
    source_gim_sha256: String,
) -> Result<FragmentCacheValidation, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;

    // 查询记录
    let res = conn.query_row(
        "SELECT id, project_id, entry_path, model_id, source_gim_sha256, source_ifc_size, fragment_file_size, fragments_version, created_at_ms, updated_at_ms
         FROM substation_fragment_cache
         WHERE project_id = ?1 AND entry_path = ?2",
        params![project_id, entry_path],
        |row| Ok(FragmentCacheRecord {
            id: row.get(0)?,
            project_id: row.get(1)?,
            entry_path: row.get(2)?,
            model_id: row.get(3)?,
            source_gim_sha256: row.get(4)?,
            source_ifc_size: row.get(5)?,
            fragment_file_size: row.get(6)?,
            fragments_version: row.get(7)?,
            created_at_ms: row.get(8)?,
            updated_at_ms: row.get(9)?,
        }),
    );
    drop(conn);

    let record = match res {
        Ok(r) => Some(r),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("查询 substation_fragment_cache 失败: {}", e)),
    };

    let has_record = record.is_some();
    let stored_version = record.as_ref().map(|r| r.fragments_version.clone());
    let stored_gim_sha256 = record.as_ref().map(|r| r.source_gim_sha256.clone());
    let stored_ifc_size = record.as_ref().map(|r| r.source_ifc_size);

    let version_match = stored_version
        .as_ref()
        .map(|v| v == &cache_version)
        .unwrap_or(false);
    let source_gim_sha256_match = !source_gim_sha256.trim().is_empty()
        && stored_gim_sha256
            .as_deref()
            .map(|stored| stored.eq_ignore_ascii_case(source_gim_sha256.trim()))
            .unwrap_or(false);
    // source_ifc_size = 0 表示跳过大小校验（Fragments 缓存命中路径不读 IFC buffer）
    let size_match = if source_ifc_size == 0 {
        true
    } else {
        stored_ifc_size
            .map(|s| s == source_ifc_size)
            .unwrap_or(false)
    };

    // 检查 fragments 文件是否存在且大小 > 0，并与记录中的实际写入大小一致。
    let (file_exists, file_size) =
        match fragment_cache_file_path(&app_handle, project_id, &entry_path) {
            Ok(path) => match stdfs::metadata(&path) {
                Ok(meta) => (true, meta.len()),
                Err(_) => (false, 0),
            },
            Err(_) => (false, 0),
        };

    let stored_fragment_size = record.as_ref().map(|r| r.fragment_file_size);
    let fragment_file_size_match = stored_fragment_size
        .map(|stored| fragment_file_size_matches(stored, file_size))
        .unwrap_or(false);
    let valid = has_record
        && version_match
        && source_gim_sha256_match
        && size_match
        && file_exists
        && fragment_file_size_match;

    Ok(FragmentCacheValidation {
        project_id,
        entry_path,
        has_record,
        stored_fragments_version: stored_version,
        current_fragments_version: cache_version.clone(),
        fragments_version_match: version_match,
        source_gim_sha256: stored_gim_sha256,
        source_gim_sha256_match,
        source_ifc_size_match: size_match,
        fragment_file_exists: file_exists,
        fragment_file_size: file_size,
        fragment_file_size_match,
        valid,
    })
}

// ===== GIM 索引完整读取 + 缓存校验 =====

/// substation_gim_entry 表完整记录
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

/// substation_file_dev_entry 表完整记录
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

/// substation_fam_property 表完整记录
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

/// substation_dev_property 表完整记录
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
    /// v4: powerline_cbm_node 表行数（transmission_line 缓存校验用）
    pub line_cbm_node_count: u64,
    /// v5: powerline_fam_property 不同 file_name_lower 的去重数量
    pub line_fam_source_count: u64,
    /// v5: powerline_dev_property 不同 file_name_lower 的去重数量
    pub line_dev_source_count: u64,
    /// v5: powerline_cbm_ref 中 ref_kind=famFiles 的 file_name_lower 去重数量
    pub line_expected_fam_ref_count: u64,
    /// v5: powerline_cbm_ref 中 ref_kind=devFiles 的 file_name_lower 去重数量
    pub line_expected_dev_ref_count: u64,
    /// v5: 图引用中存在但 powerline_fam_property 缺失的 file_name_lower 列表
    pub missing_line_fam_sources: Vec<String>,
    /// v5: 图引用中存在但 powerline_dev_property 缺失的 file_name_lower 列表
    pub missing_line_dev_sources: Vec<String>,
    /// v21: 线路 semantic source 状态：valid / missing / invalid。
    /// missing 表示旧缓存尚未生成 pack，可使用 SQLite fallback；invalid
    /// 表示 pack/index 或 metadata 整体损坏，必须重新解压重建。
    pub line_semantic_pack_status: String,
    pub line_semantic_pack_error: Option<String>,
    /// v6（方案 C）: GLB 几何缓存版本是否匹配（读取 glbcache/{projectId}/_version.txt 比较）
    /// 版本不匹配 → valid=false，触发 delete_project_cache + 重序列化
    pub geometry_cache_version_match: bool,
    /// v6（方案 C）: 当前 GEOMETRY_CACHE_VERSION（供前端诊断显示）
    pub current_geometry_cache_version: String,
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
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;

    // 1. substation_gim_entry
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, entry_path, file_name, entry_type, file_size, local_cache_path, created_at_ms
             FROM substation_gim_entry
             WHERE project_id = ?1
             ORDER BY entry_path ASC",
        )
        .map_err(|e| format!("预处理 substation_gim_entry 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_gim_entry)
        .map_err(|e| format!("查询 substation_gim_entry 失败: {}", e))?;
    let mut entries = Vec::new();
    for r in rows {
        entries.push(r.map_err(|e| format!("读取 substation_gim_entry 失败: {}", e))?);
    }

    // 2. substation_cbm_node
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, node_key, parent_key, path, name, entity_name, classify_name, fam_path, dev_path, ifc_file, ifc_guid, transform_matrix, sort_order, created_at_ms
             FROM substation_cbm_node
             WHERE project_id = ?1
             ORDER BY COALESCE(parent_key, ''), sort_order ASC, id ASC",
        )
        .map_err(|e| format!("预处理 substation_cbm_node 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_cbm_node)
        .map_err(|e| format!("查询 substation_cbm_node 失败: {}", e))?;
    let mut cbm_nodes = Vec::new();
    for r in rows {
        cbm_nodes.push(r.map_err(|e| format!("读取 substation_cbm_node 失败: {}", e))?);
    }

    // 3. substation_ifc_model
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, model_id, name, entry_path, created_at_ms
             FROM substation_ifc_model
             WHERE project_id = ?1
             ORDER BY model_id ASC",
        )
        .map_err(|e| format!("预处理 substation_ifc_model 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_ifc_model)
        .map_err(|e| format!("查询 substation_ifc_model 失败: {}", e))?;
    let mut ifc_models = Vec::new();
    for r in rows {
        ifc_models.push(r.map_err(|e| format!("读取 substation_ifc_model 失败: {}", e))?);
    }

    // 4. substation_file_dev_entry
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, model_id, ifc_name, ifc_file, device_count, device_cbm, sort_order, created_at_ms
             FROM substation_file_dev_entry
             WHERE project_id = ?1
             ORDER BY model_id ASC, sort_order ASC, id ASC",
        )
        .map_err(|e| format!("预处理 substation_file_dev_entry 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_file_dev_entry)
        .map_err(|e| format!("查询 substation_file_dev_entry 失败: {}", e))?;
    let mut file_dev_entries = Vec::new();
    for r in rows {
        file_dev_entries
            .push(r.map_err(|e| format!("读取 substation_file_dev_entry 失败: {}", e))?);
    }

    // 5. substation_fam_property
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, source_path, section_name, prop_key, prop_value, sort_order, created_at_ms
             FROM substation_fam_property
             WHERE project_id = ?1
             ORDER BY source_path ASC, sort_order ASC, id ASC",
        )
        .map_err(|e| format!("预处理 substation_fam_property 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_fam_property)
        .map_err(|e| format!("查询 substation_fam_property 失败: {}", e))?;
    let mut fam_properties = Vec::new();
    for r in rows {
        fam_properties.push(r.map_err(|e| format!("读取 substation_fam_property 失败: {}", e))?);
    }

    // 6. substation_dev_property
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, dev_path, prop_key, prop_value, created_at_ms
             FROM substation_dev_property
             WHERE project_id = ?1
             ORDER BY dev_path ASC, id ASC",
        )
        .map_err(|e| format!("预处理 substation_dev_property 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], row_to_dev_property)
        .map_err(|e| format!("查询 substation_dev_property 失败: {}", e))?;
    let mut dev_properties = Vec::new();
    for r in rows {
        dev_properties.push(r.map_err(|e| format!("读取 substation_dev_property 失败: {}", e))?);
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
    pub source_sha256: Option<String>,
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
    validate_line_graph_payload(&payload)?;
    let mut conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, payload.project_id)?;
    ensure_project_source_sha(&conn, payload.project_id, payload.source_sha256.as_deref())?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    let pid = payload.project_id;

    // 先删除旧线路索引
    tx.execute(
        "DELETE FROM powerline_cbm_node WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 powerline_cbm_node 失败: {}", e))?;
    tx.execute(
        "DELETE FROM powerline_cbm_child WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 powerline_cbm_child 失败: {}", e))?;
    tx.execute(
        "DELETE FROM powerline_cbm_ref WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 powerline_cbm_ref 失败: {}", e))?;
    tx.execute(
        "DELETE FROM powerline_file_stat WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 powerline_file_stat 失败: {}", e))?;

    // powerline_cbm_node
    for n in &payload.nodes {
        tx.execute(
            "INSERT INTO powerline_cbm_node (project_id, path, name, entity_name, classify_name, raw_props_json, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![pid, n.path, n.name, n.entity_name, n.classify_name, n.raw_props_json, n.sort_order, now],
        )
        .map_err(|e| format!("插入 powerline_cbm_node 失败: {}", e))?;
    }

    // powerline_cbm_child
    for c in &payload.children {
        tx.execute(
            "INSERT INTO powerline_cbm_child (project_id, parent_path, child_path, sort_order, ref_type, extra, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![pid, c.parent_path, c.child_path, c.sort_order, c.ref_type, c.extra, now],
        )
        .map_err(|e| format!("插入 powerline_cbm_child 失败: {}", e))?;
    }

    // line_cbm_ref（v5: 同时写入 normalized_ref_value / file_name_lower）
    for r in &payload.refs {
        tx.execute(
            "INSERT INTO powerline_cbm_ref (project_id, node_path, ref_kind, ref_key, ref_value, sort_order, normalized_ref_value, file_name_lower, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![pid, r.node_path, r.ref_kind, r.ref_key, r.ref_value, r.sort_order, r.normalized_ref_value, r.file_name_lower, now],
        )
        .map_err(|e| format!("插入 powerline_cbm_ref 失败: {}", e))?;
    }

    // powerline_file_stat
    for f in &payload.file_stats {
        tx.execute(
            "INSERT INTO powerline_file_stat (project_id, file_type, count)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(project_id, file_type) DO UPDATE SET count = ?3",
            params![pid, f.file_type, f.count],
        )
        .map_err(|e| format!("插入 powerline_file_stat 失败: {}", e))?;
    }

    // 兼容旧命令仅写入图表，但不再宣称缓存 ready；生产流程必须使用
    // begin/chunk/finish 三阶段协议完成属性完整性校验。
    tx.execute(
        "UPDATE gim_project SET parser_version = NULL, project_type = ?1, updated_at_ms = ?2 WHERE id = ?3",
        params![payload.project_type, now, pid],
    )
    .map_err(|e| format!("更新 project_type 失败: {}", e))?;

    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

// ===== v5: 线路工程 FAM/DEV 属性缓存 =====

/// powerline_fam_property 写入 payload
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

/// powerline_dev_property 写入 payload（普通 KEY=VALUE）
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

const MAX_LINE_NODES: usize = 500_000;
const MAX_LINE_CHILDREN: usize = 1_000_000;
const MAX_LINE_REFS: usize = 2_000_000;
const MAX_LINE_FILE_STATS: usize = 256;
const MAX_LINE_ATTR_ROWS: usize = 2_000_000;
const MAX_LINE_CHUNK_ROWS: usize = 10_000;
const MAX_LINE_TEXT_BYTES: usize = 4 * 1024 * 1024;

fn validate_line_path_field(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 4096 {
        return Err(format!("线路 {} 无效或过长", field));
    }
    validate_entry_path(value).map(|_| ())
}

fn validate_line_attr_common(
    source_path: &str,
    normalized_path: &str,
    file_name_lower: &str,
    prop_key: &str,
    prop_value: Option<&str>,
    raw_line: Option<&str>,
    expected_ext: &str,
) -> Result<(), String> {
    validate_line_path_field(source_path, "source_path")?;
    validate_line_path_field(normalized_path, "normalized_path")?;
    let source_normalized = source_path.replace('\\', "/");
    if normalized_path.contains('\\')
        || normalized_path != normalized_path.replace('\\', "/")
        || source_normalized != normalized_path
        || normalized_path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("线路 normalized_path 必须使用 / 分隔".to_string());
    }
    let expected_name = Path::new(normalized_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name_lower != expected_name || !file_name_lower.ends_with(expected_ext) {
        return Err(format!("线路 file_name_lower 与 {} 不一致", expected_ext));
    }
    if prop_key.trim().is_empty() || prop_key.len() > 4096 {
        return Err("线路属性 prop_key 无效或过长".to_string());
    }
    if prop_value
        .map(|v| v.len() > MAX_LINE_TEXT_BYTES)
        .unwrap_or(false)
        || raw_line
            .map(|v| v.len() > MAX_LINE_TEXT_BYTES)
            .unwrap_or(false)
    {
        return Err("线路属性文本过长".to_string());
    }
    Ok(())
}

fn validate_line_fam_property_payload(p: &LineFamPropertyPayload) -> Result<(), String> {
    validate_line_attr_common(
        &p.source_path,
        &p.normalized_path,
        &p.file_name_lower,
        &p.prop_key,
        p.prop_value.as_deref(),
        p.raw_line.as_deref(),
        ".fam",
    )?;
    if p.display_key
        .as_ref()
        .map(|v| v.len() > 4096)
        .unwrap_or(false)
    {
        return Err("线路 FAM display_key 过长".to_string());
    }
    if p.sort_order < 0 || p.sort_order > MAX_LINE_ATTR_ROWS as i64 {
        return Err("线路 FAM sort_order 无效".to_string());
    }
    Ok(())
}

fn validate_line_dev_property_payload(p: &LineDevPropertyPayload) -> Result<(), String> {
    validate_line_attr_common(
        &p.source_path,
        &p.normalized_path,
        &p.file_name_lower,
        &p.prop_key,
        p.prop_value.as_deref(),
        p.raw_line.as_deref(),
        ".dev",
    )?;
    if p.sort_order < 0 || p.sort_order > MAX_LINE_ATTR_ROWS as i64 {
        return Err("线路 DEV sort_order 无效".to_string());
    }
    Ok(())
}

// acc-plan P1-2：线路工程入库拆分为 begin/chunk/finish 三阶段命令。
//
// 原子性语义：parser_version 仅在 finish 阶段写入（提交点）。
// 中途失败 → 版本戳未更新 → validate_gim_cache 判定缓存无效 →
// 下次打开完整重建，不会出现半成品缓存被命中的情况。
//
// 分块收益：避免数十 MB payload 一次性 JSON 序列化过 IPC 的开销。

fn clear_powerline_tables(tx: &rusqlite::Transaction, pid: i64) -> Result<(), String> {
    for table in [
        "powerline_cbm_node",
        "powerline_cbm_child",
        "powerline_cbm_ref",
        "powerline_file_stat",
        "powerline_fam_property",
        "powerline_dev_property",
    ] {
        let sql = format!("DELETE FROM {} WHERE project_id = ?1", table);
        tx.execute(&sql, params![pid])
            .map_err(|e| format!("清理 {} 失败: {}", table, e))?;
    }
    Ok(())
}

fn validate_line_graph_payload(payload: &LineGraphPayload) -> Result<(), String> {
    ensure_cache_project_id(payload.project_id)?;
    if payload.project_type != "transmission_line" {
        return Err(format!(
            "线路缓存 project_type 无效: {}",
            payload.project_type
        ));
    }
    if payload
        .source_sha256
        .as_deref()
        .map(|s| s.trim().is_empty() || s.len() > 128)
        .unwrap_or(false)
    {
        return Err("线路 source_sha256 无效".to_string());
    }
    if payload.nodes.len() > MAX_LINE_NODES
        || payload.children.len() > MAX_LINE_CHILDREN
        || payload.refs.len() > MAX_LINE_REFS
        || payload.file_stats.len() > MAX_LINE_FILE_STATS
    {
        return Err("线路图 payload 数量超过安全上限".to_string());
    }
    let nodes: std::collections::HashSet<&str> =
        payload.nodes.iter().map(|n| n.path.as_str()).collect();
    if nodes.is_empty() {
        return Err("线路图节点不能为空".to_string());
    }
    for n in &payload.nodes {
        validate_line_path_field(&n.path, "node.path")?;
        if n.name.as_ref().map(|v| v.len() > 4096).unwrap_or(false)
            || n.entity_name
                .as_ref()
                .map(|v| v.len() > 4096)
                .unwrap_or(false)
            || n.classify_name
                .as_ref()
                .map(|v| v.len() > 4096)
                .unwrap_or(false)
        {
            return Err("线路图节点文本过长".to_string());
        }
        if n.raw_props_json.len() > 8 * 1024 * 1024 {
            return Err("线路图节点 raw_props_json 过大".to_string());
        }
    }
    for c in &payload.children {
        validate_line_path_field(&c.parent_path, "child.parent_path")?;
        validate_line_path_field(&c.child_path, "child.child_path")?;
        if !nodes.contains(c.parent_path.as_str()) || !nodes.contains(c.child_path.as_str()) {
            return Err(format!(
                "线路 child 引用不存在节点: {} -> {}",
                c.parent_path, c.child_path
            ));
        }
        if c.ref_type.trim().is_empty()
            || c.ref_type.len() > 128
            || c.extra
                .as_ref()
                .map(|v| v.len() > MAX_LINE_TEXT_BYTES)
                .unwrap_or(false)
        {
            return Err("线路 child 字段无效或过长".to_string());
        }
        if c.sort_order
            .map(|v| v < 0 || v > MAX_LINE_NODES as i64)
            .unwrap_or(false)
        {
            return Err("线路 child sort_order 无效".to_string());
        }
    }
    for r in &payload.refs {
        validate_line_path_field(&r.node_path, "ref.node_path")?;
        if !nodes.contains(r.node_path.as_str()) {
            return Err(format!("线路 ref 引用不存在节点: {}", r.node_path));
        }
        if r.ref_kind.trim().is_empty()
            || r.ref_kind.len() > 128
            || r.ref_value.trim().is_empty()
            || r.ref_value.len() > 4096
        {
            return Err("线路 ref 字段无效或过长".to_string());
        }
        if r.ref_key.as_ref().map(|v| v.len() > 4096).unwrap_or(false)
            || r.normalized_ref_value
                .as_ref()
                .map(|v| v.len() > 4096)
                .unwrap_or(false)
            || r.file_name_lower
                .as_ref()
                .map(|v| v.len() > 4096)
                .unwrap_or(false)
        {
            return Err("线路 ref 辅助字段过长".to_string());
        }
        if r.sort_order
            .map(|v| v < 0 || v > MAX_LINE_REFS as i64)
            .unwrap_or(false)
        {
            return Err("线路 ref sort_order 无效".to_string());
        }
    }
    for f in &payload.file_stats {
        if f.file_type.trim().is_empty()
            || f.file_type.len() > 128
            || f.count < 0
            || f.count > MAX_LINE_NODES as i64
        {
            return Err("线路 file_stat 无效".to_string());
        }
    }
    Ok(())
}

fn insert_line_graph(
    tx: &rusqlite::Transaction,
    pid: i64,
    payload: &LineGraphPayload,
    now: u64,
) -> Result<(), String> {
    // powerline_cbm_node
    {
        let mut stmt = tx.prepare(
            "INSERT INTO powerline_cbm_node (project_id, path, name, entity_name, classify_name, raw_props_json, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ).map_err(|e| format!("预处理 powerline_cbm_node 失败: {}", e))?;
        for n in &payload.nodes {
            stmt.execute(params![
                pid,
                n.path,
                n.name,
                n.entity_name,
                n.classify_name,
                n.raw_props_json,
                n.sort_order,
                now
            ])
            .map_err(|e| format!("插入 powerline_cbm_node 失败: {}", e))?;
        }
    }

    // powerline_cbm_child
    {
        let mut stmt = tx.prepare(
            "INSERT INTO powerline_cbm_child (project_id, parent_path, child_path, sort_order, ref_type, extra, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
        ).map_err(|e| format!("预处理 powerline_cbm_child 失败: {}", e))?;
        for c in &payload.children {
            stmt.execute(params![
                pid,
                c.parent_path,
                c.child_path,
                c.sort_order,
                c.ref_type,
                c.extra,
                now
            ])
            .map_err(|e| format!("插入 powerline_cbm_child 失败: {}", e))?;
        }
    }

    // powerline_cbm_ref（v5: 含 normalized_ref_value / file_name_lower）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO powerline_cbm_ref (project_id, node_path, ref_kind, ref_key, ref_value, normalized_ref_value, file_name_lower, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        ).map_err(|e| format!("预处理 powerline_cbm_ref 失败: {}", e))?;
        for r in &payload.refs {
            stmt.execute(params![
                pid,
                r.node_path,
                r.ref_kind,
                r.ref_key,
                r.ref_value,
                r.normalized_ref_value,
                r.file_name_lower,
                r.sort_order,
                now
            ])
            .map_err(|e| format!("插入 powerline_cbm_ref 失败: {}", e))?;
        }
    }

    // powerline_file_stat
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO powerline_file_stat (project_id, file_type, count) VALUES (?1, ?2, ?3)"
        ).map_err(|e| format!("预处理 powerline_file_stat 失败: {}", e))?;
        for f in &payload.file_stats {
            stmt.execute(params![pid, f.file_type, f.count])
                .map_err(|e| format!("插入 powerline_file_stat 失败: {}", e))?;
        }
    }
    Ok(())
}

/// 阶段 1/3：清空旧索引 + 写入线路图（graph 4 张表）
/// 清空项目 parser_version（P1 评审：入库开始时立即失效缓存，
/// 半成品数据在 finish 提交前不可能被 validate_gim_cache 命中）
fn invalidate_line_parser_version(tx: &rusqlite::Transaction, pid: i64) -> Result<(), String> {
    tx.execute(
        "UPDATE gim_project SET parser_version = NULL WHERE id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清空 parser_version 失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn save_line_graph_begin(
    state: tauri::State<'_, DbState>,
    project_id: i64,
    session_id: String,
    graph_payload: LineGraphPayload,
    source_sha256: Option<String>,
    expected_fam_properties: i64,
    expected_dev_properties: i64,
) -> Result<(), String> {
    if session_id.trim().is_empty() || session_id.len() > 128 {
        return Err("线路缓存 session_id 无效".to_string());
    }
    if graph_payload.project_id != project_id {
        return Err("project_id 与 graph_payload 不一致".to_string());
    }
    validate_line_graph_payload(&graph_payload)?;
    if expected_fam_properties < 0
        || expected_dev_properties < 0
        || expected_fam_properties > MAX_LINE_ATTR_ROWS as i64
        || expected_dev_properties > MAX_LINE_ATTR_ROWS as i64
    {
        return Err("线路属性期望数量无效或超过安全上限".to_string());
    }
    if let (Some(external), Some(in_payload)) = (
        source_sha256.as_deref(),
        graph_payload.source_sha256.as_deref(),
    ) {
        if external != in_payload {
            return Err("source_sha256 与 graph_payload.source_sha256 不一致".to_string());
        }
    }
    let mut conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;
    let expected_source = source_sha256
        .as_deref()
        .or(graph_payload.source_sha256.as_deref());
    ensure_project_source_sha(&conn, project_id, expected_source)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    clear_powerline_tables(&tx, project_id)?;
    invalidate_line_parser_version(&tx, project_id)?;
    insert_line_graph(&tx, project_id, &graph_payload, now)?;
    tx.execute(
        "INSERT INTO powerline_cache_session (project_id, session_id, expected_nodes, expected_children, expected_refs, expected_file_stats, expected_fam_properties, expected_dev_properties, received_fam_properties, received_dev_properties, started_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, ?9)
         ON CONFLICT(project_id) DO UPDATE SET session_id = ?2, expected_nodes = ?3, expected_children = ?4, expected_refs = ?5, expected_file_stats = ?6, expected_fam_properties = ?7, expected_dev_properties = ?8, received_fam_properties = 0, received_dev_properties = 0, started_at_ms = ?9",
        params![project_id, session_id, graph_payload.nodes.len() as i64, graph_payload.children.len() as i64, graph_payload.refs.len() as i64, graph_payload.file_stats.len() as i64, expected_fam_properties, expected_dev_properties, now],
    ).map_err(|e| format!("创建线路缓存 session 失败: {}", e))?;
    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

/// 阶段 2/3：写入一批 FAM/DEV 属性（可多次调用）
#[tauri::command]
fn insert_line_attr_chunk(
    tx: &rusqlite::Transaction,
    pid: i64,
    fam_props: &[LineFamPropertyPayload],
    dev_props: &[LineDevPropertyPayload],
    now: u64,
) -> Result<(), String> {
    if !fam_props.is_empty() {
        let mut stmt = tx.prepare(
            "INSERT INTO powerline_fam_property (project_id, source_path, normalized_path, file_name_lower, display_key, prop_key, prop_value, raw_line, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
        ).map_err(|e| format!("预处理 powerline_fam_property 失败: {}", e))?;
        for p in fam_props {
            stmt.execute(params![
                pid,
                p.source_path,
                p.normalized_path,
                p.file_name_lower,
                p.display_key,
                p.prop_key,
                p.prop_value,
                p.raw_line,
                p.sort_order,
                now
            ])
            .map_err(|e| format!("插入 powerline_fam_property 失败: {}", e))?;
        }
    }

    if !dev_props.is_empty() {
        let mut stmt = tx.prepare(
            "INSERT INTO powerline_dev_property (project_id, source_path, normalized_path, file_name_lower, prop_key, prop_value, raw_line, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        ).map_err(|e| format!("预处理 powerline_dev_property 失败: {}", e))?;
        for p in dev_props {
            stmt.execute(params![
                pid,
                p.source_path,
                p.normalized_path,
                p.file_name_lower,
                p.prop_key,
                p.prop_value,
                p.raw_line,
                p.sort_order,
                now
            ])
            .map_err(|e| format!("插入 powerline_dev_property 失败: {}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn save_line_attrs_chunk(
    state: tauri::State<'_, DbState>,
    project_id: i64,
    session_id: String,
    fam_props: Vec<LineFamPropertyPayload>,
    dev_props: Vec<LineDevPropertyPayload>,
) -> Result<(), String> {
    if session_id.trim().is_empty() || session_id.len() > 128 {
        return Err("线路缓存 session_id 无效".to_string());
    }
    if fam_props.len().saturating_add(dev_props.len()) > MAX_LINE_CHUNK_ROWS {
        return Err("线路属性 chunk 超过单批安全上限".to_string());
    }
    for p in &fam_props {
        validate_line_fam_property_payload(p)?;
    }
    for p in &dev_props {
        validate_line_dev_property_payload(p)?;
    }
    let mut conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    let (stored_session, expected_fam, expected_dev, received_fam, received_dev): (String, i64, i64, i64, i64) = tx.query_row(
        "SELECT session_id, expected_fam_properties, expected_dev_properties, received_fam_properties, received_dev_properties FROM powerline_cache_session WHERE project_id = ?1",
        params![project_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).map_err(|_| "线路缓存 session 不存在或已结束".to_string())?;
    if stored_session != session_id {
        return Err("线路缓存 session_id 不匹配".to_string());
    }
    let next_fam = received_fam
        .checked_add(fam_props.len() as i64)
        .ok_or("线路 FAM 数量溢出")?;
    let next_dev = received_dev
        .checked_add(dev_props.len() as i64)
        .ok_or("线路 DEV 数量溢出")?;
    if next_fam > expected_fam || next_dev > expected_dev {
        return Err("线路属性 chunk 超过 begin 声明数量".to_string());
    }
    insert_line_attr_chunk(&tx, project_id, &fam_props, &dev_props, now)?;
    tx.execute("UPDATE powerline_cache_session SET received_fam_properties = ?1, received_dev_properties = ?2 WHERE project_id = ?3", params![next_fam, next_dev, project_id])
        .map_err(|e| format!("更新线路缓存 session 计数失败: {}", e))?;
    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

/// 阶段 3/3：提交点——写入 parser_version / project_type，使缓存生效
#[tauri::command]
pub fn save_line_project_finish(
    state: tauri::State<'_, DbState>,
    project_id: i64,
    session_id: String,
) -> Result<(), String> {
    let mut conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let session: (String, i64, i64, i64, i64, i64, i64, i64) = tx.query_row(
        "SELECT session_id, expected_nodes, expected_children, expected_refs, expected_file_stats, expected_fam_properties, expected_dev_properties, received_fam_properties + received_dev_properties FROM powerline_cache_session WHERE project_id = ?1",
        params![project_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
    ).map_err(|_| "线路缓存 session 不存在或已结束".to_string())?;
    if session.0 != session_id {
        return Err("线路缓存 session_id 不匹配".to_string());
    }
    let counts: [(&str, i64); 6] = [
        ("powerline_cbm_node", session.1),
        ("powerline_cbm_child", session.2),
        ("powerline_cbm_ref", session.3),
        ("powerline_file_stat", session.4),
        ("powerline_fam_property", session.5),
        ("powerline_dev_property", session.6),
    ];
    for (table, expected) in counts {
        let actual: i64 = tx
            .query_row(
                &format!("SELECT COUNT(*) FROM {} WHERE project_id = ?1", table),
                params![project_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("校验线路缓存 {} 数量失败: {}", table, e))?;
        if actual != expected {
            return Err(format!(
                "线路缓存 {} 数量不完整（期望 {}, 实际 {}）",
                table, expected, actual
            ));
        }
    }
    let now = now_ms();
    tx.execute(
        "UPDATE gim_project SET parser_version = ?1, project_type = 'transmission_line', updated_at_ms = ?2 WHERE id = ?3",
        params![PARSER_VERSION, now, project_id],
    )
    .map_err(|e| format!("更新 parser_version 失败: {}", e))?;
    tx.execute(
        "DELETE FROM powerline_cache_session WHERE project_id = ?1",
        params![project_id],
    )
    .map_err(|e| format!("清理线路缓存 session 失败: {}", e))?;
    tx.commit()
        .map_err(|e| format!("提交线路缓存 finish 失败: {}", e))?;
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
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;

    // 读取 project_type
    let project_type: Option<String> = conn
        .query_row(
            "SELECT project_type FROM gim_project WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    // 1. powerline_cbm_node
    let mut stmt = conn
        .prepare("SELECT path, name, entity_name, classify_name, raw_props_json, sort_order FROM powerline_cbm_node WHERE project_id = ?1 ORDER BY sort_order ASC, id ASC")
        .map_err(|e| format!("预处理 powerline_cbm_node 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(LineCbmNodeRecord {
                path: row.get(0)?,
                name: row.get(1)?,
                entity_name: row.get(2)?,
                classify_name: row.get(3)?,
                raw_props_json: row.get(4)?,
                sort_order: row.get(5)?,
            })
        })
        .map_err(|e| format!("查询 powerline_cbm_node 失败: {}", e))?;
    let mut nodes = Vec::new();
    for r in rows {
        nodes.push(r.map_err(|e| format!("读取 powerline_cbm_node 失败: {}", e))?);
    }

    // 2. powerline_cbm_child
    let mut stmt = conn
        .prepare("SELECT parent_path, child_path, sort_order, ref_type, extra FROM powerline_cbm_child WHERE project_id = ?1 ORDER BY parent_path ASC, sort_order ASC, id ASC")
        .map_err(|e| format!("预处理 powerline_cbm_child 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(LineCbmChildRecord {
                parent_path: row.get(0)?,
                child_path: row.get(1)?,
                sort_order: row.get(2)?,
                ref_type: row.get(3)?,
                extra: row.get(4)?,
            })
        })
        .map_err(|e| format!("查询 powerline_cbm_child 失败: {}", e))?;
    let mut children = Vec::new();
    for r in rows {
        children.push(r.map_err(|e| format!("读取 powerline_cbm_child 失败: {}", e))?);
    }

    // 3. line_cbm_ref（v5: 同时读取 normalized_ref_value / file_name_lower）
    let mut stmt = conn
        .prepare("SELECT node_path, ref_kind, ref_key, ref_value, sort_order, normalized_ref_value, file_name_lower FROM powerline_cbm_ref WHERE project_id = ?1 ORDER BY node_path ASC, ref_kind ASC, sort_order ASC, id ASC")
        .map_err(|e| format!("预处理 powerline_cbm_ref 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(LineCbmRefRecord {
                node_path: row.get(0)?,
                ref_kind: row.get(1)?,
                ref_key: row.get(2)?,
                ref_value: row.get(3)?,
                sort_order: row.get(4)?,
                normalized_ref_value: row.get(5)?,
                file_name_lower: row.get(6)?,
            })
        })
        .map_err(|e| format!("查询 powerline_cbm_ref 失败: {}", e))?;
    let mut refs = Vec::new();
    for r in rows {
        refs.push(r.map_err(|e| format!("读取 powerline_cbm_ref 失败: {}", e))?);
    }

    // 4. powerline_file_stat
    let mut stmt = conn
        .prepare("SELECT file_type, count FROM powerline_file_stat WHERE project_id = ?1 ORDER BY file_type ASC")
        .map_err(|e| format!("预处理 powerline_file_stat 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(LineFileStatRecord {
                file_type: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| format!("查询 powerline_file_stat 失败: {}", e))?;
    let mut file_stats = Vec::new();
    for r in rows {
        file_stats.push(r.map_err(|e| format!("读取 powerline_file_stat 失败: {}", e))?);
    }

    Ok(LineGraphResult {
        project_type,
        nodes,
        children,
        refs,
        file_stats,
    })
}

// ===== v5: 线路工程 FAM/DEV 属性读取 =====

/// powerline_fam_property 读取记录
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

/// powerline_dev_property 读取记录
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
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;

    // 1. powerline_fam_property
    let mut stmt = conn
        .prepare("SELECT source_path, normalized_path, file_name_lower, display_key, prop_key, prop_value, raw_line, sort_order FROM powerline_fam_property WHERE project_id = ?1 ORDER BY normalized_path ASC, prop_key ASC, sort_order ASC")
        .map_err(|e| format!("预处理 powerline_fam_property 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
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
        })
        .map_err(|e| format!("查询 powerline_fam_property 失败: {}", e))?;
    let mut fam_properties = Vec::new();
    for r in rows {
        fam_properties.push(r.map_err(|e| format!("读取 powerline_fam_property 失败: {}", e))?);
    }

    // 2. powerline_dev_property
    let mut stmt = conn
        .prepare("SELECT source_path, normalized_path, file_name_lower, prop_key, prop_value, raw_line, sort_order FROM powerline_dev_property WHERE project_id = ?1 ORDER BY normalized_path ASC, prop_key ASC, sort_order ASC")
        .map_err(|e| format!("预处理 powerline_dev_property 失败: {}", e))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(LineDevPropertyRecord {
                source_path: row.get(0)?,
                normalized_path: row.get(1)?,
                file_name_lower: row.get(2)?,
                prop_key: row.get(3)?,
                prop_value: row.get(4)?,
                raw_line: row.get(5)?,
                sort_order: row.get(6)?,
            })
        })
        .map_err(|e| format!("查询 powerline_dev_property 失败: {}", e))?;
    let mut dev_properties = Vec::new();
    for r in rows {
        dev_properties.push(r.map_err(|e| format!("读取 powerline_dev_property 失败: {}", e))?);
    }

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
/// 统一键空间为 file_name_lower（裸文件名小写）。powerline_cbm_ref 中的引用通常是裸文件名
/// （如 `43cf81da-...f159.fam`），而 powerline_fam_property/powerline_dev_property 中的 normalized_path
/// 是完整路径（如 `Cbm/43cf81da-...f159.fam`）。若用 normalized_ref_value 与 normalized_path
/// 做差集会因键空间不一致而误报缺失，故 expected/actual/missing 全部改用 file_name_lower 统一比较。
///
/// - fam/dev source count：powerline_fam_property / powerline_dev_property 中 file_name_lower 去重数量
/// - expected fam/dev ref count：powerline_cbm_ref 中 ref_kind=famFiles/devFiles 且 file_name_lower 非空的去重数量
/// - missing fam/dev sources：图引用中存在但属性表缺失的 file_name_lower 列表
fn compute_line_attr_diagnostic(
    conn: &Connection,
    project_id: i64,
) -> Result<LineAttrDiagnostic, String> {
    use std::collections::HashSet;

    // 1. fam source count (DISTINCT file_name_lower in powerline_fam_property)
    let fam_source_count: u64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT file_name_lower) FROM powerline_fam_property WHERE project_id = ?1",
            params![project_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0i64) as u64;

    // 2. dev source count
    let dev_source_count: u64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT file_name_lower) FROM powerline_dev_property WHERE project_id = ?1",
            params![project_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0i64) as u64;

    // 3. expected fam refs (DISTINCT file_name_lower where ref_kind=famFiles)
    let mut expected_fam_refs: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT file_name_lower FROM powerline_cbm_ref
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
                "SELECT DISTINCT file_name_lower FROM powerline_cbm_ref
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
            .prepare(
                "SELECT DISTINCT file_name_lower FROM powerline_fam_property WHERE project_id = ?1",
            )
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
            .prepare(
                "SELECT DISTINCT file_name_lower FROM powerline_dev_property WHERE project_id = ?1",
            )
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

/// 检查线路 semantic source 是否可用于 warm full-read。
///
/// 两个 sidecar 都不存在时视为 `missing`（兼容 v20 以前由 SQLite 入库、
/// 但没有 native pack 的缓存）；只有单边存在、格式/边界错误或 metadata
/// 文件缺失才视为 `invalid`，由上层放弃 SQLite partial runtime 并重建。
fn inspect_line_semantic_pack(
    app_handle: &tauri::AppHandle,
    project_id: i64,
) -> (String, Option<String>) {
    let root = match cache_project_root_for_batch(app_handle, project_id) {
        Ok(root) => root,
        Err(error) => return ("invalid".to_string(), Some(semantic_error("PACK_INVALID", error))),
    };
    let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
    let index_path = root.join(LINE_SEMANTIC_INDEX_FILE);
    let pack_exists = pack_path.exists();
    let index_exists = index_path.exists();
    if !pack_exists && !index_exists {
        return ("missing".to_string(), None);
    }
    if !index_exists {
        return (
            "invalid".to_string(),
            Some(semantic_error("INDEX_INVALID", "线路语义 pack index 缺失")),
        );
    }
    if !pack_exists {
        return (
            "invalid".to_string(),
            Some(semantic_error("PACK_INVALID", "线路语义 pack 数据文件缺失")),
        );
    }
    match read_line_semantic_pack_files(&root, true) {
        Ok(_) => ("valid".to_string(), None),
        Err(error) => ("invalid".to_string(), Some(error)),
    }
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
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<GimCacheValidation, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;

    let cbm_nodes_count = count_rows(&conn, "substation_cbm_node", project_id)?;
    let ifc_models_count = count_rows(&conn, "substation_ifc_model", project_id)?;
    let file_dev_entries_count = count_rows(&conn, "substation_file_dev_entry", project_id)?;
    let line_cbm_node_count = count_rows(&conn, "powerline_cbm_node", project_id)?;
    let has_index = cbm_nodes_count > 0 || ifc_models_count > 0 || line_cbm_node_count > 0;

    // 读取 parser_version 和 project_type
    let (stored_parser_version, project_type, source_sha256): (
        Option<String>,
        Option<String>,
        String,
    ) = conn
        .query_row(
            "SELECT parser_version, project_type, sha256 FROM gim_project WHERE id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()
        .unwrap_or((None, None, String::new()));
    let parser_version_match = stored_parser_version
        .as_deref()
        .map(|v| v == PARSER_VERSION)
        .unwrap_or(false);

    // 方案 C：校验 GLB 几何缓存版本
    // 读取 {app_data_dir}/glbcache/{project_id}/_version.txt 并与 GEOMETRY_CACHE_VERSION 比较
    // 版本不匹配 → valid=false，触发 delete_project_cache + 重序列化
    let geometry_cache_version_match = check_geometry_cache_version(&app_handle, project_id)
        && check_geometry_cache_manifest(&app_handle, project_id, &source_sha256);

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

    let (line_semantic_pack_status, line_semantic_pack_error) = if is_line {
        inspect_line_semantic_pack(&app_handle, project_id)
    } else {
        ("missing".to_string(), None)
    };

    let (ifc_entry_count, cached_ifc_count, missing_cache_paths, valid) = if is_line {
        // 线路工程：不检查 IFC 缓存；要求 FAM 属性源存在。
        // P1 评审修复：不再依赖 geometry_cache_version_match——glbcache/_version.txt
        // 仅由变电渐进 GLB 管线写入，线路工程永远没有该文件，旧条件导致线路缓存
        // 永远失效、每次打开都重新解压。线路缓存的完整性由三阶段入库协议保证：
        // parser_version 仅在 save_line_project_finish 提交。
        let valid =
            parser_version_match
                && line_cbm_node_count > 0
                && line_attr_diag.fam_source_count > 0
                // semantic source 整体损坏时不能拿 SQLite 图/属性拼出
                // partial Runtime；missing 则兼容旧缓存并允许 SQLite fallback。
                && line_semantic_pack_status != "invalid";
        (0u64, 0u64, Vec::new(), valid)
    } else {
        // 变电工程：保持原有 IFC 缓存校验
        let mut stmt = conn
            .prepare(
                "SELECT entry_path, local_cache_path, file_size
                 FROM substation_gim_entry
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
            let (entry_path, local_cache_path, expected_size) =
                r.map_err(|e| format!("读取 IFC entry 失败: {}", e))?;
            ifc_entry_count += 1;
            match local_cache_path {
                Some(p) if !p.is_empty() => {
                    let path = std::path::Path::new(&p);
                    if !is_expected_cache_path(&app_handle, project_id, &entry_path, path)? {
                        missing_cache_paths.push(format!("{} (缓存路径不匹配)", entry_path));
                    } else if path.exists() {
                        let actual_size = stdfs::metadata(path).map(|m| m.len()).unwrap_or(0);
                        if actual_size as i64 == expected_size {
                            cached_ifc_count += 1;
                        } else {
                            missing_cache_paths.push(format!(
                                "{} (大小不匹配: 期望 {}, 实际 {})",
                                entry_path, expected_size, actual_size
                            ));
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
            && parser_version_match
            && geometry_cache_version_match;

        (
            ifc_entry_count,
            cached_ifc_count,
            missing_cache_paths,
            valid,
        )
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
        line_semantic_pack_status,
        line_semantic_pack_error,
        geometry_cache_version_match,
        current_geometry_cache_version: GEOMETRY_CACHE_VERSION.to_string(),
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
    pub source_gim_sha256: String,
    pub source_gim_sha256_match: bool,
    pub source_ifc_size: i64,
    pub fragment_file_size_stored: i64,
    pub fragment_file_size_actual: u64,
    pub stored_fragments_version: String,
    pub current_fragments_cache_version: String,
    pub fragments_version_match: bool,
    pub fragment_file_exists: bool,
    pub fragment_file_size_match: bool,
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
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;

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
    let entries_count = count_rows(&conn, "substation_gim_entry", project_id)?;
    let cbm_nodes_count = count_rows(&conn, "substation_cbm_node", project_id)?;
    let ifc_models_count = count_rows(&conn, "substation_ifc_model", project_id)?;
    let file_dev_entries_count = count_rows(&conn, "substation_file_dev_entry", project_id)?;
    let fam_properties_count = count_rows(&conn, "substation_fam_property", project_id)?;
    let dev_properties_count = count_rows(&conn, "substation_dev_property", project_id)?;
    // v4: 线路工程图缓存表统计
    let line_cbm_node_count = count_rows(&conn, "powerline_cbm_node", project_id)?;
    let line_cbm_child_count = count_rows(&conn, "powerline_cbm_child", project_id)?;
    let line_cbm_ref_count = count_rows(&conn, "powerline_cbm_ref", project_id)?;
    let line_file_stat_count = count_rows(&conn, "powerline_file_stat", project_id)?;
    // v5: 线路工程 FAM/DEV 属性表统计
    let line_fam_property_count = count_rows(&conn, "powerline_fam_property", project_id)?;
    let line_dev_property_count = count_rows(&conn, "powerline_dev_property", project_id)?;
    let has_index = cbm_nodes_count > 0 || ifc_models_count > 0 || line_cbm_node_count > 0;

    // 3. 查询 IFC entry 并诊断每个缓存文件
    let mut stmt = conn
        .prepare(
            "SELECT entry_path, local_cache_path
             FROM substation_gim_entry
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
        let (entry_path, local_cache_path) =
            r.map_err(|e| format!("读取 IFC entry 失败: {}", e))?;
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

    // 4. 查询 substation_fragment_cache 记录并诊断每个 fragments 缓存文件
    let mut frag_stmt = conn
        .prepare(
            "SELECT entry_path, model_id, source_gim_sha256, source_ifc_size, fragment_file_size, fragments_version
             FROM substation_fragment_cache
             WHERE project_id = ?1
             ORDER BY entry_path ASC",
        )
        .map_err(|e| format!("预处理 substation_fragment_cache 失败: {}", e))?;
    let frag_rows = frag_stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| format!("查询 substation_fragment_cache 失败: {}", e))?;

    let mut fragment_cache_count: u64 = 0;
    let mut valid_fragment_cache_count: u64 = 0;
    let mut missing_fragment_cache_paths: Vec<String> = Vec::new();
    let mut fragment_cache_files: Vec<FragmentCacheFileDiagnostic> = Vec::new();

    for r in frag_rows {
        let (
            entry_path,
            model_id,
            source_gim_sha256,
            source_ifc_size,
            frag_size_stored,
            stored_version,
        ) = r.map_err(|e| format!("读取 substation_fragment_cache 失败: {}", e))?;
        fragment_cache_count += 1;

        let version_match = fragment_cache_version_matches(&stored_version);
        let source_gim_sha256_match =
            !source_gim_sha256.is_empty() && source_gim_sha256.eq_ignore_ascii_case(&project.5);
        let (file_exists, file_size_actual) =
            match fragment_cache_file_path(app_handle, project_id, &entry_path) {
                Ok(path) => match stdfs::metadata(&path) {
                    Ok(meta) => (true, meta.len()),
                    Err(_) => (false, 0),
                },
                Err(_) => (false, 0),
            };

        let fragment_file_size_match =
            fragment_file_size_matches(frag_size_stored, file_size_actual);
        let frag_valid =
            version_match && source_gim_sha256_match && file_exists && fragment_file_size_match;
        if frag_valid {
            valid_fragment_cache_count += 1;
        } else {
            missing_fragment_cache_paths.push(entry_path.clone());
        }

        fragment_cache_files.push(FragmentCacheFileDiagnostic {
            entry_path,
            model_id,
            source_gim_sha256,
            source_gim_sha256_match,
            source_ifc_size,
            fragment_file_size_stored: frag_size_stored,
            fragment_file_size_actual: file_size_actual,
            stored_fragments_version: stored_version,
            current_fragments_cache_version: FRAGMENTS_CACHE_VERSION.to_string(),
            fragments_version_match: version_match,
            fragment_file_exists: file_exists,
            fragment_file_size_match,
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
        parser_version_match && line_cbm_node_count > 0 && line_attr_diag.fam_source_count > 0
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
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;

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
pub fn list_cached_projects(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<CachedProjectSummary>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
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
    let mut conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;

    // 级联删除所有索引表（变电 6 张 + 线路 6 张 + fragments 1 张）
    for table in &[
        "substation_gim_entry",
        "substation_cbm_node",
        "substation_ifc_model",
        "substation_file_dev_entry",
        "substation_fam_property",
        "substation_dev_property",
        "powerline_cbm_node",
        "powerline_cbm_child",
        "powerline_cbm_ref",
        "powerline_file_stat",
        "powerline_fam_property",
        "powerline_dev_property",
        "powerline_cache_session",
        "substation_fragment_cache",
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
        match remove_cache_dir_if_safe(&ifc_dir, " IFC") {
            Ok(true) => disk_messages.push("IFC 磁盘缓存已删除".to_string()),
            Ok(false) => {}
            Err(e) => disk_messages.push(format!("IFC 磁盘缓存删除失败（需后续手动清理）: {}", e)),
        }
    }

    // Fragments 缓存目录: app_data_dir/fragments/{project_id}/
    let frag_dir = app_dir.join("fragments").join(project_id.to_string());
    if frag_dir.exists() {
        match remove_cache_dir_if_safe(&frag_dir, " Fragments") {
            Ok(true) => disk_messages.push("Fragments 磁盘缓存已删除".to_string()),
            Ok(false) => {}
            Err(e) => disk_messages.push(format!("Fragments 磁盘缓存删除失败: {}", e)),
        }
    }

    // GLB 几何缓存目录: app_data_dir/glbcache/{project_id}/
    let glb_dir = app_dir.join("glbcache").join(project_id.to_string());
    if glb_dir.exists() {
        match remove_cache_dir_if_safe(&glb_dir, " GLB") {
            Ok(true) => disk_messages.push("GLB 磁盘缓存已删除".to_string()),
            Ok(false) => {}
            Err(e) => disk_messages.push(format!("GLB 磁盘缓存删除失败: {}", e)),
        }
    }

    let summary = if disk_messages.is_empty() {
        format!(
            "项目 {} 缓存已清除（数据库记录 + 磁盘文件均无残留）",
            project_id
        )
    } else {
        format!(
            "项目 {} 数据库记录已清除。{}",
            project_id,
            disk_messages.join("；")
        )
    };
    Ok(summary)
}

/// Tauri command：仅删除 GLB 几何缓存目录（不删除 SQLite 记录和 IFC/Fragments 缓存）。
///
/// 用于缓存校验失败（如 _version.txt 缺失导致 geometry_cache_version_match=false）时，
/// 清理陈旧 GLB 文件，避免"GLB 存在但版本标记缺失"的假象。
#[tauri::command]
pub fn delete_glb_cache(app_handle: tauri::AppHandle, project_id: i64) -> Result<(), String> {
    ensure_cache_project_id(project_id)?;
    {
        let state = app_handle.state::<DbState>();
        let conn = state
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&conn, project_id)?;
    }
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app_data_dir 失败: {}", e))?;
    let glb_dir = base.join("glbcache").join(project_id.to_string());
    let _ = remove_cache_dir_if_safe(&glb_dir, " GLB")?;
    Ok(())
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
    pub phm_color_max_a: Option<f64>,
    pub sort_order: i64,
}

/// 几何引用链完整 payload（一次事务写入三张表）
#[derive(Debug, Deserialize)]
pub struct GeometryRefsPayload {
    pub project_id: i64,
    pub source_sha256: Option<String>,
    pub dev_solid_models: Vec<DevSolidModelPayload>,
    pub dev_sub_devices: Vec<DevSubDevicePayload>,
    pub phm_solid_models: Vec<PhmSolidModelPayload>,
}

fn validate_geometry_refs_payload(payload: &GeometryRefsPayload) -> Result<(), String> {
    ensure_cache_project_id(payload.project_id)?;
    for p in &payload.dev_solid_models {
        validate_entry_path(&p.dev_path)?;
        validate_entry_path(&p.solid_model_path)?;
        if !p.solid_model_path.to_ascii_lowercase().ends_with(".phm")
            && !p.solid_model_path.to_ascii_lowercase().ends_with(".dev")
        {
            return Err(format!(
                "DEV solid_model_path 类型无效: {}",
                p.solid_model_path
            ));
        }
    }
    for p in &payload.dev_sub_devices {
        validate_entry_path(&p.dev_path)?;
        validate_entry_path(&p.child_dev_path)?;
        if !p.child_dev_path.to_ascii_lowercase().ends_with(".dev") {
            return Err(format!("child_dev_path 类型无效: {}", p.child_dev_path));
        }
    }
    for p in &payload.phm_solid_models {
        validate_entry_path(&p.phm_path)?;
        validate_entry_path(&p.solid_model_path)?;
        let lower = p.solid_model_path.to_ascii_lowercase();
        if !lower.ends_with(".mod") && !lower.ends_with(".stl") && !lower.ends_with(".phm") {
            return Err(format!(
                "PHM solid_model_path 类型无效: {}",
                p.solid_model_path
            ));
        }
    }
    Ok(())
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
    validate_geometry_refs_payload(&payload)?;
    let mut conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, payload.project_id)?;
    ensure_project_source_sha(&conn, payload.project_id, payload.source_sha256.as_deref())?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    let pid = payload.project_id;

    // 1. 清空旧数据
    tx.execute(
        "DELETE FROM substation_dev_solid_model WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 substation_dev_solid_model 失败: {}", e))?;
    tx.execute(
        "DELETE FROM substation_dev_sub_device WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 substation_dev_sub_device 失败: {}", e))?;
    tx.execute(
        "DELETE FROM substation_phm_solid_model WHERE project_id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清理 substation_phm_solid_model 失败: {}", e))?;

    // 2. dev_solid_model（DEV SOLIDMODEL → PHM）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO substation_dev_solid_model (project_id, dev_path, solid_model_path, transform_matrix, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        ).map_err(|e| format!("预处理 substation_dev_solid_model 失败: {}", e))?;
        for sm in &payload.dev_solid_models {
            stmt.execute(params![
                pid,
                sm.dev_path,
                sm.solid_model_path,
                sm.transform_matrix,
                sm.sort_order,
                now
            ])
            .map_err(|e| format!("插入 substation_dev_solid_model 失败: {}", e))?;
        }
    }

    // 3. dev_sub_device（DEV SUBDEVICE → child DEV）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO substation_dev_sub_device (project_id, dev_path, child_dev_path, transform_matrix, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        ).map_err(|e| format!("预处理 substation_dev_sub_device 失败: {}", e))?;
        for sd in &payload.dev_sub_devices {
            stmt.execute(params![
                pid,
                sd.dev_path,
                sd.child_dev_path,
                sd.transform_matrix,
                sd.sort_order,
                now
            ])
            .map_err(|e| format!("插入 substation_dev_sub_device 失败: {}", e))?;
        }
    }

    // 4. phm_solid_model（PHM SOLIDMODEL → MOD/STL）
    {
        let mut stmt = tx.prepare(
            "INSERT INTO substation_phm_solid_model (project_id, phm_path, solid_model_path, transform_matrix, color, phm_color_max_a, sort_order, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ).map_err(|e| format!("预处理 substation_phm_solid_model 失败: {}", e))?;
        for sm in &payload.phm_solid_models {
            stmt.execute(params![
                pid,
                sm.phm_path,
                sm.solid_model_path,
                sm.transform_matrix,
                sm.color,
                sm.phm_color_max_a,
                sm.sort_order,
                now
            ])
            .map_err(|e| format!("插入 substation_phm_solid_model 失败: {}", e))?;
        }
    }

    // 几何引用链写入成功后才提交变电缓存 ready 状态；任何前置索引或
    // 引用链失败都保持 parser_version=NULL，下次打开会完整重建。
    tx.execute(
        "UPDATE gim_project SET parser_version = ?1, project_type = 'substation', updated_at_ms = ?2 WHERE id = ?3",
        params![PARSER_VERSION, now, pid],
    )
    .map_err(|e| format!("提交变电缓存版本失败: {}", e))?;

    tx.commit()
        .map_err(|e| format!("提交几何引用链事务失败: {}", e))?;
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
    /// PHM 文件内 COLORn.A 的最大值，用于透明度刻度判定
    pub phm_color_max_a: Option<f64>,
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
/// 沿引用链查询：substation_cbm_node.dev_path → substation_dev_solid_model → phm_solid_model，
/// 以及 substation_cbm_node.dev_path → substation_dev_sub_device → substation_dev_solid_model → phm_solid_model。
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

    debug_perf_log!(
        "[get_reachable_geometry] start project_id={} include_mod={} include_stl={}",
        project_id,
        include_mod,
        include_stl
    );

    let lock_t0 = Instant::now();
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&conn, project_id)?;
    debug_perf_log!(
        "[get_reachable_geometry] lock acquired: {}ms",
        lock_t0.elapsed().as_millis()
    );

    // 快速短路：两个都 false 仍需先完成 project_id 校验，避免把不存在
    // 的项目静默当成空结果返回。
    if !include_mod && !include_stl {
        debug_perf_log!("[get_reachable_geometry] done total=0ms rows=0 (both false)");
        return Ok(Vec::new());
    }

    let results = query_reachable_geometry(&conn, project_id, include_mod, include_stl)?;

    debug_perf_log!(
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
             FROM substation_cbm_node
             WHERE project_id = ?1
                AND (entity_name IS NULL OR (entity_name != 'DEV_SUBDEVICE' AND entity_name != 'PARTINDEX'))",
        )
        .map_err(|e| format!("预处理 substation_cbm_node dev_path 失败: {}", e))?;
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
        .map_err(|e| format!("查询 substation_cbm_node dev_path 失败: {}", e))?;
    let mut cbm_nodes: HashMap<String, CbmGeometryNode> = HashMap::new();
    for row in cbm_rows {
        let (node_key, parent_key, entity_name, dev_path, transform_matrix) =
            row.map_err(|e| format!("读取 substation_cbm_node 行失败: {}", e))?;
        cbm_nodes.insert(
            node_key,
            CbmGeometryNode {
                parent_key,
                entity_name,
                dev_path,
                local_matrix: parse_matrix_opt(transform_matrix.as_deref()),
            },
        );
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
        let matrix = cumulative_cbm_matrix(
            node_key,
            &cbm_nodes,
            &mut cbm_matrix_cache,
            &mut HashSet::new(),
        );
        let key = make_matrix_instance_key(&dev_path, &matrix);
        if dev_instance_seen.insert(key) {
            dev_instances
                .entry(dev_path.clone())
                .or_default()
                .push(matrix);
            queue.push_back((dev_path, matrix));
        }
    }
    debug_perf_log!(
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
             FROM substation_dev_sub_device
             WHERE project_id = ?1",
        )
        .map_err(|e| format!("预处理 substation_dev_sub_device 失败: {}", e))?;
    let sub_rows = sub_stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| format!("查询 substation_dev_sub_device 失败: {}", e))?;
    for row in sub_rows {
        let (parent, child, transform_matrix) =
            row.map_err(|e| format!("读取 substation_dev_sub_device 行失败: {}", e))?;
        sub_edges
            .entry(normalize_dev_path(&parent))
            .or_default()
            .push((
                normalize_dev_path(&child),
                parse_matrix_opt(transform_matrix.as_deref()),
            ));
    }

    let mut child_count = 0usize;
    while let Some((parent_dev, parent_matrix)) = queue.pop_front() {
        if let Some(children) = sub_edges.get(&parent_dev) {
            for (child_dev, child_local_matrix) in children {
                let child_matrix = multiply_matrices(&parent_matrix, child_local_matrix);
                let key = make_matrix_instance_key(child_dev, &child_matrix);
                if dev_instance_seen.insert(key) {
                    dev_instances
                        .entry(child_dev.clone())
                        .or_default()
                        .push(child_matrix);
                    queue.push_back((child_dev.clone(), child_matrix));
                    child_count += 1;
                }
            }
        }
    }
    debug_perf_log!(
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
             FROM substation_dev_solid_model
             WHERE project_id = ?1",
        )
        .map_err(|e| format!("预处理 substation_dev_solid_model 失败: {}", e))?;
    let dsm_rows = dsm_stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| format!("查询 substation_dev_solid_model 失败: {}", e))?;
    let mut dsm_count = 0usize;
    for row in dsm_rows {
        let (dev_path, solid_model_path, transform_matrix) =
            row.map_err(|e| format!("读取 substation_dev_solid_model 行失败: {}", e))?;
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
    debug_perf_log!(
        "[get_reachable_geometry] dev solid model refs: {}ms rows={}",
        dsm_t0.elapsed().as_millis(),
        dsm_count
    );

    let psm_t0 = Instant::now();
    let mut phm_to_geometry: HashMap<
        String,
        Vec<(String, Option<String>, Option<String>, Option<f64>)>,
    > = HashMap::new();
    let mut psm_stmt = conn
        .prepare(
            "SELECT phm_path, solid_model_path, transform_matrix, color, phm_color_max_a
             FROM substation_phm_solid_model
             WHERE project_id = ?1",
        )
        .map_err(|e| format!("预处理 substation_phm_solid_model 失败: {}", e))?;
    let psm_rows = psm_stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<f64>>(4)?,
            ))
        })
        .map_err(|e| format!("查询 substation_phm_solid_model 失败: {}", e))?;
    let mut psm_count = 0usize;
    for row in psm_rows {
        let (phm_path, solid_model_path, transform_matrix, color, color_max_a) =
            row.map_err(|e| format!("读取 substation_phm_solid_model 行失败: {}", e))?;
        let lower = solid_model_path.to_ascii_lowercase();
        if (include_mod && lower.ends_with(".mod")) || (include_stl && lower.ends_with(".stl")) {
            phm_to_geometry
                .entry(normalize_phm_path(&phm_path))
                .or_default()
                .push((
                    normalize_geometry_path(&solid_model_path),
                    transform_matrix,
                    color,
                    color_max_a,
                ));
            psm_count += 1;
        }
    }
    debug_perf_log!(
        "[get_reachable_geometry] phm solid models: {}ms rows={}",
        psm_t0.elapsed().as_millis(),
        psm_count
    );

    let collect_t0 = Instant::now();
    let mut results = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (phm_path, dev_placement_matrix, dev_transform_matrix) in phm_refs {
        if let Some(geometries) = phm_to_geometry.get(&phm_path) {
            for (geometry_path, phm_transform_matrix, phm_color, phm_color_max_a) in geometries {
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
                        instance_key: format!(
                            "{}#{}{}",
                            geometry_path,
                            placement_transform_matrix,
                            phm_color
                                .as_deref()
                                .map(|color| format!("#{}", color))
                                .unwrap_or_default()
                        ),
                        placement_transform_matrix: Some(placement_transform_matrix),
                        dev_transform_matrix: dev_transform_matrix.clone(),
                        phm_transform_matrix: phm_transform_matrix.clone(),
                        phm_color: phm_color.clone(),
                        phm_color_max_a: *phm_color_max_a,
                    });
                }
            }
        }
    }
    results.sort_by(|a, b| a.geometry_path.cmp(&b.geometry_path));
    debug_perf_log!(
        "[get_reachable_geometry] collect rows: {}ms rows={}",
        collect_t0.elapsed().as_millis(),
        results.len()
    );

    Ok(results)
}

fn identity_matrix() -> [f64; 16] {
    [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
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
            out[col * 4 + row] = a[row] /* 0*4+row */ * b[col * 4 + 0]
                + a[1 * 4 + row] * b[col * 4 + 1]
                + a[2 * 4 + row] * b[col * 4 + 2]
                + a[3 * 4 + row] * b[col * 4 + 3];
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
) -> [f64; 16] {
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
    if normalized
        .to_ascii_lowercase()
        .starts_with(&expected.to_ascii_lowercase())
    {
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
    #[cfg(test)]
    mod line_cache_protocol_tests {
        #[allow(unused_imports)]
        use super::super::{
            clear_powerline_tables, insert_line_attr_chunk, invalidate_line_parser_version, now_ms,
            LineFamPropertyPayload, PARSER_VERSION,
        };
        #[allow(unused_imports)]
        use rusqlite::Connection;

        /// 构建最小 schema：gim_project + 线路 6 表（仅测试涉及列）
        fn setup_line_conn() -> Connection {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE gim_project (
                id INTEGER PRIMARY KEY,
                parser_version TEXT,
                project_type TEXT
            );
            CREATE TABLE powerline_cbm_node (
                project_id INTEGER NOT NULL,
                path TEXT NOT NULL,
                name TEXT, entity_name TEXT, classify_name TEXT,
                raw_props_json TEXT NOT NULL DEFAULT '',
                sort_order INTEGER, created_at_ms INTEGER NOT NULL DEFAULT 0,
                UNIQUE(project_id, path)
            );
            CREATE TABLE powerline_cbm_child (
                project_id INTEGER NOT NULL,
                parent_path TEXT NOT NULL,
                child_path TEXT NOT NULL,
                sort_order INTEGER, ref_type TEXT NOT NULL DEFAULT '',
                extra TEXT, created_at_ms INTEGER NOT NULL DEFAULT 0,
                UNIQUE(project_id, parent_path, child_path, ref_type)
            );
            CREATE TABLE powerline_cbm_ref (
                project_id INTEGER NOT NULL,
                node_path TEXT NOT NULL, ref_kind TEXT NOT NULL,
                ref_key TEXT, ref_value TEXT NOT NULL,
                normalized_ref_value TEXT, file_name_lower TEXT,
                sort_order INTEGER, created_at_ms INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE powerline_file_stat (
                project_id INTEGER NOT NULL, file_type TEXT NOT NULL,
                count INTEGER NOT NULL, PRIMARY KEY(project_id, file_type)
            );
            CREATE TABLE powerline_fam_property (
                project_id INTEGER NOT NULL,
                source_path TEXT NOT NULL,
                normalized_path TEXT NOT NULL,
                file_name_lower TEXT NOT NULL,
                display_key TEXT, prop_key TEXT NOT NULL, prop_value TEXT,
                raw_line TEXT, sort_order INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(project_id, normalized_path, prop_key, sort_order)
            );
            CREATE TABLE powerline_dev_property (
                project_id INTEGER NOT NULL,
                source_path TEXT NOT NULL,
                normalized_path TEXT NOT NULL,
                file_name_lower TEXT NOT NULL,
                prop_key TEXT NOT NULL, prop_value TEXT,
                raw_line TEXT, sort_order INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(project_id, normalized_path, prop_key, sort_order)
            );",
            )
            .unwrap();
            conn
        }

        fn insert_project(conn: &Connection, pid: i64, version: Option<&str>) {
            conn.execute(
            "INSERT INTO gim_project (id, parser_version, project_type) VALUES (?1, ?2, 'transmission_line')",
            rusqlite::params![pid, version],
        )
        .unwrap();
        }

        fn count(conn: &Connection, table: &str, pid: i64) -> i64 {
            conn.query_row(
                &format!("SELECT COUNT(*) FROM {} WHERE project_id = ?1", table),
                rusqlite::params![pid],
                |r| r.get(0),
            )
            .unwrap()
        }

        #[test]
        fn begin_clears_parser_version_and_tables() {
            let conn = setup_line_conn();
            insert_project(&conn, 1, Some("stale-version"));
            conn.execute(
            "INSERT INTO powerline_cbm_node (project_id, path, raw_props_json, created_at_ms) VALUES (1, 'Cbm/old.cbm', '{}', 0)",
            [],
        ).unwrap();

            let tx = conn.unchecked_transaction().unwrap();
            clear_powerline_tables(&tx, 1).unwrap();
            invalidate_line_parser_version(&tx, 1).unwrap();
            tx.commit().unwrap();

            // P1 评审：入库开始即失效——版本戳清空、旧数据清除
            assert_eq!(count(&conn, "powerline_cbm_node", 1), 0);
            let stored: Option<String> = conn
                .query_row(
                    "SELECT parser_version FROM gim_project WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stored, None);
        }

        #[test]
        fn finish_commits_version_only_at_the_end() {
            let conn = setup_line_conn();
            insert_project(&conn, 1, None);

            // 模拟 chunk 阶段写入属性（版本仍为 NULL）
            let tx = conn.unchecked_transaction().unwrap();
            insert_line_attr_chunk(
                &tx,
                1,
                &[LineFamPropertyPayload {
                    source_path: "Cbm/x.fam".into(),
                    normalized_path: "Cbm/x.fam".into(),
                    file_name_lower: "cbm/x.fam".into(),
                    display_key: None,
                    prop_key: "K".into(),
                    prop_value: Some("V".into()),
                    raw_line: None,
                    sort_order: 0,
                }],
                &[],
                now_ms(),
            )
            .unwrap();
            tx.commit().unwrap();

            // chunk 完成但未 finish：版本戳必须仍为空（半成品不可命中）
            let stored: Option<String> = conn
                .query_row(
                    "SELECT parser_version FROM gim_project WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stored, None);
            assert_eq!(count(&conn, "powerline_fam_property", 1), 1);

            // finish：提交点
            conn.execute(
                "UPDATE gim_project SET parser_version = ?1 WHERE id = 1",
                rusqlite::params![PARSER_VERSION],
            )
            .unwrap();
            let stored: String = conn
                .query_row(
                    "SELECT parser_version FROM gim_project WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stored, PARSER_VERSION);
        }

        /// P1 评审回归核心：线路缓存有效性不依赖 glbcache 几何标记文件。
        ///
        /// 该文件只由变电渐进 GLB 管线写入——线路工程永远没有它。
        /// 旧表达式把 geometry_cache_version_match 纳入线路 valid 条件，
        /// 导致线路工程二次打开永远缓存未命中而重新解压（bug 复现）；
        /// 修复后仅要求 parser_version 匹配 + 图表非空 + FAM 源存在。
        #[test]
        fn line_cache_valid_without_geometry_marker() {
            let parser_version_match = true;
            let line_cbm_node_count: u64 = 10;
            let fam_source_count: u64 = 5;
            // 线路工程无该文件 → 恒为 false
            let geometry_cache_version_match = false;

            // 旧表达式（bug）：要求几何标记 → 线路缓存永远失效
            let old_valid = parser_version_match
                && geometry_cache_version_match
                && line_cbm_node_count > 0
                && fam_source_count > 0;
            assert!(!old_valid, "旧表达式应复现 bug（无几何标记时失效）");

            // 新表达式（修复后 validate_gim_cache is_line 分支）
            let new_valid = parser_version_match && line_cbm_node_count > 0 && fam_source_count > 0;
            assert!(new_valid, "修复后：无几何标记不应阻止线路缓存命中");
        }
    }

    use super::*;

    #[test]
    fn fragment_cache_requires_exact_nonzero_file_size() {
        assert!(fragment_file_size_matches(128, 128));
        assert!(!fragment_file_size_matches(128, 127));
        assert!(!fragment_file_size_matches(128, 0));
        assert!(!fragment_file_size_matches(0, 128));
        assert!(!fragment_file_size_matches(-1, 128));
    }

    #[test]
    fn fragment_cache_diagnostic_accepts_composed_runtime_version() {
        assert!(fragment_cache_version_matches(FRAGMENTS_CACHE_VERSION));
        let composed = format!("{}|fragments@0.0.0|web-ifc@0.0.0", FRAGMENTS_CACHE_VERSION);
        assert!(fragment_cache_version_matches(&composed));
        assert!(!fragment_cache_version_matches(
            "fragments-cache-v5|fragments@0.0.0"
        ));
        assert!(!fragment_cache_version_matches(
            "fragments-cache-v60|fragments@0.0.0"
        ));
    }

    fn setup_geometry_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE substation_cbm_node (
                project_id INTEGER NOT NULL,
                node_key TEXT NOT NULL,
                parent_key TEXT,
                entity_name TEXT,
                dev_path TEXT,
                transform_matrix TEXT
            );
            CREATE INDEX idx_substation_cbm_node_project_dev ON substation_cbm_node(project_id, dev_path);

            CREATE TABLE substation_dev_solid_model (
                project_id INTEGER NOT NULL,
                dev_path TEXT NOT NULL,
                solid_model_path TEXT NOT NULL,
                transform_matrix TEXT,
                sort_order INTEGER NOT NULL
            );
            CREATE INDEX idx_substation_dev_sm_dev ON substation_dev_solid_model(project_id, dev_path);

            CREATE TABLE substation_dev_sub_device (
                project_id INTEGER NOT NULL,
                dev_path TEXT NOT NULL,
                child_dev_path TEXT NOT NULL,
                transform_matrix TEXT,
                sort_order INTEGER NOT NULL
            );
            CREATE INDEX idx_substation_dev_sub_dev ON substation_dev_sub_device(project_id, dev_path);

            CREATE TABLE substation_phm_solid_model (
                project_id INTEGER NOT NULL,
                phm_path TEXT NOT NULL,
                solid_model_path TEXT NOT NULL,
                transform_matrix TEXT,
                color TEXT,
                phm_color_max_a REAL,
                sort_order INTEGER NOT NULL
            );
            CREATE INDEX idx_substation_phm_sm_phm ON substation_phm_solid_model(project_id, phm_path);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn reachable_geometry_includes_direct_and_child_dev_paths() {
        let conn = setup_geometry_conn();
        conn.execute(
            "INSERT INTO substation_cbm_node (project_id, node_key, parent_key, entity_name, dev_path, transform_matrix)
             VALUES
             (1, 'root', NULL, 'F4System', 'root.dev', NULL),
             (1, 'direct', NULL, 'F4System', 'direct.dev', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO substation_dev_sub_device (project_id, dev_path, child_dev_path, sort_order)
             VALUES (1, 'DEV/root.dev', 'child.dev', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO substation_dev_solid_model (project_id, dev_path, solid_model_path, transform_matrix, sort_order)
             VALUES
             (1, 'DEV/direct.dev', 'direct.phm', 'direct-tm', 0),
             (1, 'DEV/child.dev', 'child.phm', 'child-tm', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO substation_phm_solid_model (project_id, phm_path, solid_model_path, transform_matrix, color, sort_order)
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
            "INSERT INTO substation_cbm_node (project_id, node_key, parent_key, entity_name, dev_path, transform_matrix)
             VALUES (1, 'device', NULL, 'F4System', 'device.dev', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO substation_dev_solid_model (project_id, dev_path, solid_model_path, transform_matrix, sort_order)
             VALUES (1, 'DEV/device.dev', 'device.phm', NULL, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO substation_phm_solid_model (project_id, phm_path, solid_model_path, transform_matrix, color, sort_order)
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
            "INSERT INTO substation_cbm_node (project_id, node_key, parent_key, entity_name, dev_path, transform_matrix)
             VALUES
             (1, 'parent', NULL, 'F3System', NULL, '1,0,0,0,0,1,0,0,0,0,1,0,10,0,0,1'),
             (1, 'child', 'parent', 'F4System', 'device.dev', '1,0,0,0,0,1,0,0,0,0,1,0,0,20,0,1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO substation_dev_solid_model (project_id, dev_path, solid_model_path, transform_matrix, sort_order)
             VALUES (1, 'DEV/device.dev', 'device.phm', NULL, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO substation_phm_solid_model (project_id, phm_path, solid_model_path, transform_matrix, color, sort_order)
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
    fn reachable_geometry_does_not_seed_from_virtual_or_partindex_alias_nodes() {
        let conn = setup_geometry_conn();
        conn.execute(
            "INSERT INTO substation_cbm_node (project_id, node_key, parent_key, entity_name, dev_path, transform_matrix)
             VALUES
             (1, 'parent', NULL, 'F4System', 'root.dev', NULL),
             (1, 'parent#dev:0:child.dev', 'parent', 'DEV_SUBDEVICE', 'child.dev',
              '1,0,0,0,0,1,0,0,0,0,1,0,999,0,0,1'),
             (1, 'part-index', 'parent', 'PARTINDEX', 'child.dev',
              '1,0,0,0,0,1,0,0,0,0,1,0,888,0,0,1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO substation_dev_sub_device (project_id, dev_path, child_dev_path, transform_matrix, sort_order)
             VALUES (1, 'DEV/root.dev', 'child.dev', '1,0,0,0,0,1,0,0,0,0,1,0,100,0,0,1', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO substation_dev_solid_model (project_id, dev_path, solid_model_path, transform_matrix, sort_order)
             VALUES (1, 'DEV/child.dev', 'child.phm', NULL, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO substation_phm_solid_model (project_id, phm_path, solid_model_path, transform_matrix, color, sort_order)
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

    #[test]
    fn line_semantic_pack_round_trip_is_contiguous_and_case_insensitive() {
        let root = std::env::temp_dir().join(format!(
            "gim-viewer-semantic-pack-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut writer = LineSemanticPackWriter::new(&root).unwrap();
        writer
            .append_with_timing("Cbm/project.cbm", b"A=B")
            .unwrap();
        writer
            .append_with_timing("Dev/item.dev", b"C=D")
            .unwrap();
        let entries = writer.finish().unwrap();
        assert_eq!(entries[0].offset, 0);
        assert_eq!(entries[0].size, 3);
        assert_eq!(entries[1].offset, 3);

        let index = read_line_semantic_index(&root).unwrap();
        let first = index.get("cbm/project.cbm").unwrap();
        assert_eq!(first.path, "Cbm/project.cbm");
        let first_bytes = read_line_semantic_pack_entry(
            &root,
            "CBM\\PROJECT.CBM",
        )
        .unwrap()
        .unwrap();
        assert_eq!(first_bytes, b"A=B");
        let pack = std::fs::read(root.join(LINE_SEMANTIC_PACK_FILE)).unwrap();
        assert_eq!(pack, b"A=BC=D");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn line_semantic_pack_v2_keeps_metadata_only_entries() {
        let root = std::env::temp_dir().join(format!(
            "gim-viewer-semantic-pack-meta-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut writer = LineSemanticPackWriter::new(&root).unwrap();
        writer
            .append_with_timing("Cbm/project.cbm", b"A=B")
            .unwrap();
        writer.record_metadata("Mod/tower.stl", 1234).unwrap();
        let entries = writer.finish().unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].packed);
        assert!(!entries[1].packed);
        let index = read_line_semantic_index(&root).unwrap();
        assert_eq!(index.len(), 2);
        assert!(index.get("cbm/project.cbm").unwrap().packed);
        assert!(!index.get("mod/tower.stl").unwrap().packed);
        assert_eq!(index.get("mod/tower.stl").unwrap().size, 1234);
        assert!(read_line_semantic_pack_entry(&root, "MOD/tower.stl")
            .unwrap()
            .is_none());
        std::fs::create_dir_all(root.join("Mod")).unwrap();
        std::fs::write(root.join("Mod/tower.stl"), vec![0u8; 1234]).unwrap();
        validate_line_semantic_pack_files(&root, true).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn line_semantic_pack_integrity_errors_are_classified_without_panic() {
        let root = std::env::temp_dir().join(format!(
            "gim-viewer-semantic-pack-invalid-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut writer = LineSemanticPackWriter::new(&root).unwrap();
        writer.append_with_timing("Cbm/a.cbm", b"abc").unwrap();
        writer.finish().unwrap();

        let index_path = root.join(LINE_SEMANTIC_INDEX_FILE);
        let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
        let index_backup = std::fs::read(&index_path).unwrap();

        std::fs::write(&index_path, b"bad").unwrap();
        let error = read_line_semantic_pack_files(&root, false).unwrap_err();
        assert!(error.starts_with("INDEX_INVALID:"));
        std::fs::write(&index_path, &index_backup).unwrap();

        std::fs::write(&pack_path, b"a").unwrap();
        let error = read_line_semantic_pack_files(&root, false).unwrap_err();
        assert!(error.starts_with("PACK_TRUNCATED:"));
        std::fs::write(&pack_path, b"abc").unwrap();

        let mut corrupted = index_backup.clone();
        // v2 record: header(9) + path_len(4) + path(9) => offset at 22.
        let offset_start = 9 + 4 + "Cbm/a.cbm".len();
        corrupted[offset_start..offset_start + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        std::fs::write(&index_path, corrupted).unwrap();
        let error = read_line_semantic_pack_files(&root, false).unwrap_err();
        assert!(error.starts_with("PACK_TRUNCATED:"));

        std::fs::write(&index_path, &index_backup).unwrap();
        std::fs::remove_file(&pack_path).unwrap();
        let error = read_line_semantic_pack_files(&root, false).unwrap_err();
        assert!(error.starts_with("PACK_INVALID:"));

        // Both sidecars reduced to valid-looking empty headers must still be
        // rejected as an incomplete source; otherwise warm restore could
        // commit an empty graph while SQLite remains apparently valid.
        let mut empty_index = Vec::new();
        empty_index.extend_from_slice(b"GLSI");
        empty_index.push(LINE_SEMANTIC_INDEX_VERSION);
        empty_index.extend_from_slice(&0u32.to_le_bytes());
        std::fs::write(&index_path, empty_index).unwrap();
        std::fs::write(&pack_path, Vec::<u8>::new()).unwrap();
        let error = read_line_semantic_pack_files(&root, false).unwrap_err();
        assert!(error.starts_with("INDEX_INVALID:"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn geometry_manifest_accepts_glb_and_empty_and_is_case_insensitive() {
        let mut seen = HashSet::new();
        validate_geometry_manifest_entry_shape(
            &GeometryCacheManifestEntry {
                entry_path: "DEV/Shared.Dev".into(),
                status: "glb".into(),
                size: 12,
            },
            &mut seen,
        )
        .unwrap();
        validate_geometry_manifest_entry_shape(
            &GeometryCacheManifestEntry {
                entry_path: "dev/empty.dev".into(),
                status: "empty".into(),
                size: 0,
            },
            &mut seen,
        )
        .unwrap();
        let duplicate = validate_geometry_manifest_entry_shape(
            &GeometryCacheManifestEntry {
                entry_path: "Dev/SHARED.DEV".into(),
                status: "glb".into(),
                size: 12,
            },
            &mut seen,
        )
        .unwrap_err();
        assert!(duplicate.contains("重复"));
    }

    #[test]
    fn geometry_manifest_rejects_invalid_status_and_empty_size() {
        for (status, size) in [("empty", 1), ("glb", 0), ("partial", 12)] {
            let mut seen = HashSet::new();
            let error = validate_geometry_manifest_entry_shape(
                &GeometryCacheManifestEntry {
                    entry_path: "DEV/item.dev".into(),
                    status: status.into(),
                    size,
                },
                &mut seen,
            )
            .unwrap_err();
            assert!(!error.is_empty());
        }
    }
}
