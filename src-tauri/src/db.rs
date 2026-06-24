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
        CREATE INDEX IF NOT EXISTS idx_gim_project_path ON gim_project(path);",
    )
    .map_err(|e| format!("初始化数据库表失败: {}", e))?;

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
        |row| {
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
        },
    )
    .map_err(|e| format!("查询项目记录失败: {}", e))
}
