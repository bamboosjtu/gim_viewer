//! Database facade: shared versions/state and stable command exports. Domain implementations live in db/.

use rusqlite::{params, Connection};
use std::fs as stdfs;
use std::path::PathBuf;
use std::sync::Mutex;
#[path = "db/geometry_cache.rs"]
mod geometry_cache;
pub use geometry_cache::*;
#[path = "db/projects.rs"]
mod projects;
pub use projects::*;
#[path = "db/schema.rs"]
mod schema;
use schema::*;
#[path = "db/substation_index.rs"]
mod substation_index;
pub use substation_index::*;
#[path = "db/validation_profile.rs"]
mod validation_profile;
use validation_profile::*;
#[path = "db/cache_paths.rs"]
mod cache_paths;
pub(crate) use cache_paths::*;
#[path = "db/cache_protocol.rs"]
mod cache_protocol;
// Preserve the existing DTO path; implementations import the protocol directly.
#[allow(unused_imports)]
pub use cache_protocol::BatchCacheFileResult;
#[path = "db/semantic_pack.rs"]
mod semantic_pack;
pub use semantic_pack::*;
#[path = "db/cache_transport.rs"]
mod cache_transport;
pub use cache_transport::*;
#[path = "db/cache_validation.rs"]
mod cache_validation;
pub use cache_validation::*;
#[path = "db/line_index.rs"]
mod line_index;
pub use line_index::*;
#[path = "db/diagnostics.rs"]
mod diagnostics;
pub use diagnostics::*;
#[path = "db/project_cache.rs"]
mod project_cache;
pub use project_cache::*;
#[cfg(test)]
#[path = "substation_sqlite_tests.rs"]
mod substation_sqlite_tests;
#[cfg(test)]
#[path = "db/tests.rs"]
mod tests;

/// Current database publication marker; semantic validity uses its own domain.
pub const PARSER_VERSION: &str = "gim-cache-schema-v1";

pub const LINE_PARSER_VERSION: &str = "gim-line-parser-v1";

pub const SUBSTATION_PARSER_VERSION: &str = "gim-substation-parser-v28";


/// GLB 几何缓存版本（方案 C：MOD/STL → glTF 序列化格式版本）
/// 独立于 PARSER_VERSION，用于在 MOD 解析逻辑变更时单独失效 glb 缓存。
/// 失效规则：
/// - 语义 parser domain 版本变 → 仅对应 source/index cache 失效
/// - GEOMETRY_CACHE_VERSION 变 → 仅 geometry domain 失效，由前端复用
///   substation source/index、重新构建 DEV GLB；不删除整个项目缓存
/// 版本文件：{app_data_dir}/glbcache/{project_id}/_version.txt
pub const GEOMETRY_CACHE_VERSION: &str = "geometry-cache-v20-source-bound-stl";

/// 应用级数据库连接
pub struct DbState(pub Mutex<Connection>);

/// 获取数据库文件路径：app_data_dir/gim_cache_schema_v1.db
fn db_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::application_data_dir(&app_handle)
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    stdfs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("gim_cache_schema_v1.db"))
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

    initialize_schema(&conn)?;
    Ok(conn)
}

/// 当前时间戳（毫秒，UNIX_EPOCH 起）
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Only an exact current domain contract can restore a semantic cache.
fn parser_domain_version_matches(stored: Option<&str>, current: &str) -> bool {
    stored == Some(current)
}

fn cache_miss_reason(reasons: Vec<String>) -> Option<String> {
    if reasons.is_empty() {
        None
    } else {
        Some(reasons.join("; "))
    }
}

fn count_rows(conn: &Connection, table: &str, project_id: i64) -> Result<i64, String> {
    let _timing = ValidationSpan::new("sqlite_counts");
    let sql = format!("SELECT COUNT(*) FROM {} WHERE project_id = ?1", table);
    conn.query_row(&sql, params![project_id], |row| row.get(0))
        .map_err(|e| format!("统计 {} 失败: {}", table, e))
}

const MAX_LINE_TEXT_BYTES: usize = 4 * 1024 * 1024;
