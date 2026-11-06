//! IFC Fragments file ownership, records and validation.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::fs as stdfs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use super::cache_paths::{
    atomic_write,
    ensure_cache_parent,
    ensure_cache_project_id,
    reject_link,
    validate_entry_path,
};
use super::cache_protocol::{decode_binary_cache_write_request};
use super::projects::{ensure_project_exists, ensure_project_source_sha};
use super::{DbState, FRAGMENTS_CACHE_VERSION, now_ms};
use super::semantic_pack::{normalize_cache_lookup_path};
use super::validation_profile::{ValidationSpan};

// ===== Fragments 缓存 =====

/// Fragments 文件完整性校验：记录大小必须为正且与磁盘实际大小完全一致。
/// 单纯“存在且非空”无法识别截断文件。
pub(super) fn fragment_file_size_matches(stored: i64, actual: u64) -> bool {
    stored > 0 && actual == stored as u64
}

/// 诊断侧的 Fragments 版本兼容判断。
///
/// 前端实际写入的是 `fragments-cache-vN|fragments@...|web-ifc@...`，
/// Rust 侧只知道基础 schema 版本，因此诊断应识别同一基础版本的组合键；
/// 运行时 `validate_fragment_cache` 仍使用前端传入的完整组合键做严格匹配。
pub(super) fn fragment_cache_version_matches(stored: &str) -> bool {
    stored == FRAGMENTS_CACHE_VERSION
        || stored.starts_with(&format!("{}|", FRAGMENTS_CACHE_VERSION))
}

/// 判断变电项目的 Fragments cache 是否覆盖全部 IFC。该域仅用于诊断/选择
/// cache source，绝不参与默认开关或基础 semantic cache 的有效性判断。
pub(super) fn check_fragments_cache_complete(
    app_handle: &tauri::AppHandle,
    conn: &Connection,
    project_id: i64,
    source_sha256: &str,
    ifc_entry_count: u64,
) -> bool {
    let _timing = ValidationSpan::new("fragments");
    if ifc_entry_count == 0 {
        return false;
    }
    let mut expected_sizes = std::collections::HashMap::<String, i64>::new();
    let Ok(mut ifc_stmt) = conn.prepare(
        "SELECT entry_path, file_size FROM substation_gim_entry
         WHERE project_id = ?1 AND entry_type = 'IFC'",
    ) else {
        return false;
    };
    let Ok(ifc_rows) = ifc_stmt.query_map(params![project_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    }) else {
        return false;
    };
    for row in ifc_rows.flatten() {
        expected_sizes.insert(normalize_cache_lookup_path(&row.0), row.1);
    }

    let Ok(mut stmt) = conn.prepare(
        "SELECT entry_path, source_gim_sha256, source_ifc_size, fragment_file_size, fragments_version
         FROM substation_fragment_cache WHERE project_id = ?1",
    ) else {
        return false;
    };
    let Ok(rows) = stmt.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    }) else {
        return false;
    };
    let mut valid_entries = std::collections::HashSet::new();
    for row in rows.flatten() {
        let (entry_path, source, source_size, frag_size, version) = row;
        let key = normalize_cache_lookup_path(&entry_path);
        let Some(expected_size) = expected_sizes.get(&key) else { continue; };
        if source != source_sha256
            || *expected_size != source_size
            || !fragment_cache_version_matches(&version)
        {
            continue;
        }
        let Ok(path) = fragment_cache_file_path(app_handle, project_id, &entry_path) else {
            continue;
        };
        let Ok(actual_size) = stdfs::metadata(path).map(|meta| meta.len()) else { continue; };
        if fragment_file_size_matches(frag_size, actual_size) {
            valid_entries.insert(key);
        }
    }
    valid_entries.len() as u64 == ifc_entry_count && expected_sizes.len() as u64 == ifc_entry_count
}

/// 计算 Fragments 缓存文件路径：app_data_dir/fragments/{project_id}/{safe_entry_path}.frag
/// entry_path 通过组件级校验（只允许 Normal 组件），防止 ../ 和 \..\ 穿越。
/// 最终路径必须位于 app_data_dir/fragments/{project_id}/ 下。
pub(super) fn fragment_cache_file_path(
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
