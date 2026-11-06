//! Project identity registration, source guards and project records.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::io::Write;
use super::cache_paths::{ensure_cache_project_id};
use super::{DbState, now_ms};

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
pub async fn upsert_gim_project(app: tauri::AppHandle, info: FileInfoInput) -> Result<GimProjectRecord, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || upsert_gim_project_inner(&app.state::<DbState>(), info))
        .await.map_err(|e| format!("项目登记任务失败: {}", e))?
}

pub(super) fn upsert_gim_project_inner(
    state: &DbState,
    info: FileInfoInput,
) -> Result<GimProjectRecord, String> {
    // 前端 picker 已返回 canonical path，但 command 也必须在后端重新规范化：
    // 这样大小写、斜杠以及 . / .. 差异不会为同一个 Windows 文件创建多条项目记录。
    let started = std::time::Instant::now();
    let (canonical_path, path_identity) = crate::canonical_identity(Path::new(&info.path))?;
    let canonical_ms = started.elapsed().as_millis();
    let lock_started = std::time::Instant::now();
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
    let lock_ms = lock_started.elapsed().as_millis();
    let now = now_ms();

    // Current records always use the canonical identity computed above.
    let existing: Option<(i64, u64, u64, String)> = conn.query_row(
        "SELECT id, size, modified_ms, sha256 FROM gim_project WHERE path = ?1 LIMIT 1",
        params![path_identity],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(|e| format!("查询项目记录失败: {}", e))?;
    let check_ms = started.elapsed().as_millis();
    let mut source_event = None;

    let result = if let Some((id, old_size, old_modified_ms, old_sha256)) = existing {
        // 源 GIM 文件是否变化：size / modified_ms / sha256 任一不同即视为变化
        let file_changed = old_size != info.size
            || old_modified_ms != info.modified_ms
            || old_sha256 != info.sha256;

        if file_changed {
            // 源 GIM 文件变化：更新元信息，同时清空 parser_version / project_type，
            // 使 validate_gim_cache 返回 invalid，触发完整重建（不删除旧索引表数据）
            conn.execute(
                "UPDATE gim_project SET path = ?1, name = ?2, size = ?3, modified_ms = ?4, sha256 = ?5, parser_version = NULL, line_parser_version = NULL, substation_parser_version = NULL, project_type = NULL, updated_at_ms = ?6, last_opened_at_ms = ?7 WHERE id = ?8",
                params![path_identity, info.name, info.size, info.modified_ms, info.sha256, now, now, id],
            )
            .map_err(|e| format!("更新项目记录失败: {}", e))?;
            source_event = Some("changed");
        } else {
            // 源文件未变化时不要为了 last_opened_at_ms 强制写库。打开 GIM 的
            // 主流程只需要 project_id 和已有 parser_version；若另一个旧实例
            // 暂时持有 SQLite 写锁，非必要写入会阻断缓存命中和后续读取。
            source_event = Some("unchanged");
        }

        query_record(&conn, id)
    } else {
        // 插入新记录（parser_version = NULL，表示尚无索引）
        conn.execute(
            "INSERT INTO gim_project (path, name, size, modified_ms, sha256, parser_version, line_parser_version, substation_parser_version, created_at_ms, updated_at_ms, last_opened_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6, ?7, ?8)",
            params![path_identity, info.name, info.size, info.modified_ms, info.sha256, now, now, now],
        )
        .map_err(|e| format!("插入项目记录失败: {}", e))?;

        query_record(&conn, conn.last_insert_rowid())
    };
    // Never write to stdout while holding the DB mutex. Portable Windows apps may
    // inherit a closed/broken output handle; println! would panic and poison it.
    drop(conn);
    let mut stdout = std::io::stdout().lock();
    write_project_diagnostic(&mut stdout, format_args!(
        "[GIM project check] canonical_ms={} lock_ms={} total_ms={}",
        canonical_ms, lock_ms, check_ms));
    if let Some(event) = source_event {
        write_project_diagnostic(&mut stdout, format_args!("[GIM project source] {}", event));
    }
    write_project_diagnostic(&mut stdout, format_args!(
        "[GIM project result] total_ms={:.3} success={}",
        started.elapsed().as_secs_f64()*1000.0, result.is_ok()));
    result
}

pub(super) fn write_project_diagnostic(writer: &mut impl Write, message: std::fmt::Arguments<'_>) {
    let _ = writer.write_fmt(message);
    let _ = writer.write_all(b"\n");
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

/// 校验写入请求携带的源 GIM 身份仍是当前项目身份。
///
/// 工程切换可能与 IPC 写入并发发生；仅靠前端 await 前后的代次检查无法
/// 覆盖命令执行期间的竞态。把 SHA-256 绑定到数据库项目记录，可阻止旧
/// 工程的延迟提交覆盖同一路径已更新的新源文件缓存。
pub(super) fn ensure_project_source_sha(
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
