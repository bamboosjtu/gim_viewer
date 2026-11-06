//! Settings, recent projects, source authorization and cache deletion.

use rusqlite::params;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use super::cache_paths::{remove_cache_dir_if_safe};
use super::projects::{ensure_project_exists};
use super::{DbState, now_ms};

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
    pub last_opened_at_ms: u64,
}

/// 读取全部应用设置。密钥只保存在本地 SQLite，不进入构建产物。
#[tauri::command]
pub fn get_app_settings(
    state: tauri::State<'_, DbState>,
) -> Result<HashMap<String, String>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM app_setting")
        .map_err(|e| format!("查询应用设置失败: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取应用设置失败: {}", e))?;
    let mut settings = HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|e| format!("读取应用设置行失败: {}", e))?;
        settings.insert(key, value);
    }
    Ok(settings)
}

/// 写入单个应用设置；空值表示清除该项。
#[tauri::command]
pub fn set_app_setting(
    state: tauri::State<'_, DbState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 128 {
        return Err("设置键无效".to_string());
    }
    if value.len() > 4096 {
        return Err("设置值过长".to_string());
    }
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    conn.execute(
        "INSERT INTO app_setting(key, value, updated_at_ms) VALUES(?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms",
        params![key, value, now_ms() as i64],
    )
    .map_err(|e| format!("保存应用设置失败: {}", e))?;
    Ok(())
}

/// 列出所有缓存的项目（只读，按最近打开排序）
#[tauri::command]
pub fn list_cached_projects(state: tauri::State<'_, DbState>) -> Result<Vec<CachedProjectSummary>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, path, project_type, parser_version, size, modified_ms, updated_at_ms, last_opened_at_ms
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
                last_opened_at_ms: row.get(8)?,
            })
        })
        .map_err(|e| format!("映射项目列表失败: {}", e))?;
    let result = projects
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集项目列表失败: {}", e))?;
    Ok(result)
}

/// 更新最近打开时间；只在成功打开后调用，不参与打开关键路径。
#[tauri::command]
pub fn touch_gim_project_opened(state: tauri::State<'_, DbState>, project_id: i64) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    conn.execute(
        "UPDATE gim_project SET last_opened_at_ms = ?1 WHERE id = ?2",
        params![now_ms(), project_id],
    )
    .map_err(|e| format!("更新最近打开时间失败: {}", e))?;
    Ok(())
}

/// 授权打开最近工程：路径只能来自数据库中的 gim_project 记录，
/// 页面不能传入任意路径。用于“最近工程”/“继续上次工程”。
#[tauri::command]
pub fn authorize_cached_gim_project(
    access: tauri::State<'_, crate::AuthorizedFilePaths>,
    state: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<String, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    let path: String = conn
        .query_row(
            "SELECT path FROM gim_project WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取最近工程失败: {}", e))?;
    drop(conn);
    crate::authorize_selected_path(&access, Path::new(&path), Some("gim"))
}

/// 删除指定项目的全部缓存（DB 记录 + 磁盘文件）
///
/// 删除全部项目索引表 + gim_project 记录，并尝试删除磁盘缓存目录。
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

    super::schema::clear_project_tables(&tx, project_id)?;

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
    let app_dir = crate::application_data_dir(&app_handle)
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

    let device_lod_dir = app_dir.join("device-lod").join(project_id.to_string());
    if device_lod_dir.exists() {
        match remove_cache_dir_if_safe(&device_lod_dir, "设备派生缓存") {
            Ok(true) => disk_messages.push("设备 LOD/空间目录缓存已删除".to_string()),
            Ok(false) => {},
            Err(e) => disk_messages.push(format!("设备派生缓存删除失败: {}", e)),
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
