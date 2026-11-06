//! Read-only project/cache diagnostics for the frontend.

use rusqlite::params;
use serde::Serialize;
use std::fs as stdfs;
use super::cache_paths::{is_expected_cache_path};
use super::cache_validation::{
    LineAttrDiagnostic,
    compute_line_attr_diagnostic,
    inspect_line_semantic_pack,
};
use super::geometry_cache::{
    check_geometry_cache_manifest,
    check_geometry_cache_manifest_structure,
    check_geometry_cache_version_file,
};
use super::{
    DbState,
    GEOMETRY_CACHE_VERSION,
    LINE_PARSER_VERSION,
    PARSER_VERSION,
    SUBSTATION_PARSER_VERSION,
    cache_miss_reason,
    count_rows,
    db_path,
    parser_domain_version_matches,
};
use super::substation_index::{missing_substation_sources, substation_index_receipt_matches};

// ==================== 诊断 command ====================

/// 单个 IFC 缓存文件诊断
#[derive(Debug, Serialize)]
pub struct IfcCacheFileDiagnostic {
    pub entry_path: String,
    pub local_cache_path: Option<String>,
    pub exists: bool,
    pub file_size: Option<u64>,
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
    pub stored_line_parser_version: Option<String>,
    pub current_line_parser_version: String,
    pub line_parser_version_match: bool,
    pub stored_substation_parser_version: Option<String>,
    pub current_substation_parser_version: String,
    pub substation_parser_version_match: bool,
    pub cache_miss_reason: Option<String>,
    /// 线路 semantic source 的完整性状态；missing 表示旧 SQLite 缓存可用但
    /// 尚未生成 pack，invalid 表示 pack/index 整体损坏，必须重建而不能 partial fallback。
    pub line_semantic_pack_status: String,
    pub line_semantic_pack_error: Option<String>,
    /// 变电 GLB geometry cache 是否完整有效。线路工程不把该字段纳入
    /// valid，但仍返回它以便诊断 JSON 明确区分几何缓存域。
    pub geometry_cache_version_match: bool,
    pub current_geometry_cache_version: String,
    pub geometry_cache_version_file_match: bool,
    pub geometry_cache_manifest_valid: bool,
    pub substation_semantic_cache_valid: bool,
    pub geometry_cache_valid: bool,
    pub valid: bool,

    pub ifc_cache_files: Vec<IfcCacheFileDiagnostic>,

    // Fragments 缓存诊断

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

    // 1. 查询 gim_project 基本信息（含旧共享版本、domain 版本、project_type）
    let project = conn
        .query_row(
            "SELECT id, path, name, size, modified_ms, sha256, parser_version, line_parser_version, substation_parser_version, project_type FROM gim_project WHERE id = ?1",
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
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .map_err(|e| format!("查询项目失败: {}", e))?;

    let project_type = project.9.clone();
    let is_line = project_type.as_deref() == Some("transmission_line");
    let stored_line_parser_version = project.7.clone();
    let stored_substation_parser_version = project.8.clone();
    let line_parser_version_match = parser_domain_version_matches(
        stored_line_parser_version.as_deref(),
        LINE_PARSER_VERSION,
    );
    let substation_parser_version_match = parser_domain_version_matches(
        stored_substation_parser_version.as_deref(),
        SUBSTATION_PARSER_VERSION,
    );
    let parser_version_match = if is_line {
        line_parser_version_match
    } else {
        substation_parser_version_match
    };

    // 与 validate_gim_cache 使用同一套几何域判定。诊断 JSON 必须能解释
    // 为什么打开流程没有命中，不能只显示共享 parser_version。
    let geometry_cache_version_file_match =
        check_geometry_cache_version_file(app_handle, project.0);
    let geometry_cache_manifest_valid = check_geometry_cache_manifest_structure(
        app_handle,
        project.0,
        &project.5,
    );
    let geometry_cache_version_match = geometry_cache_version_file_match
        && check_geometry_cache_manifest(app_handle, project.0, &project.5);

    // 线路 semantic pack 是独立于 SQLite graph/attribute 的 source cache。
    // missing 允许旧缓存走 SQLite fallback；invalid 则必须整体重建。
    let (line_semantic_pack_status, line_semantic_pack_error) = if is_line {
        inspect_line_semantic_pack(app_handle, project.0)
    } else {
        ("missing".to_string(), None)
    };

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

    let mut ifc_entry_count: u64 = 0;
    let mut cached_ifc_count: u64 = 0;
    let mut missing_cache_paths: Vec<String> = Vec::new();
    let mut ifc_cache_files: Vec<IfcCacheFileDiagnostic> = Vec::new();

    for r in rows {
        let (entry_path, local_cache_path, expected_size) =
            r.map_err(|e| format!("读取 IFC entry 失败: {}", e))?;
        ifc_entry_count += 1;

        let (exists, file_size) = match &local_cache_path {
            Some(p) if !p.is_empty() => {
                let path = std::path::Path::new(p);
                let expected_path = is_expected_cache_path(app_handle, project.0, &entry_path, path)
                    .unwrap_or(false);
                if !expected_path {
                    missing_cache_paths.push(format!("{} (缓存路径不匹配)", entry_path));
                    (false, None)
                } else if path.exists() {
                    let size = stdfs::metadata(path).map(|m| m.len()).ok();
                    if expected_size >= 0 && size == Some(expected_size as u64) {
                        cached_ifc_count += 1;
                    } else {
                        missing_cache_paths.push(format!(
                            "{} (大小不匹配: 期望 {}, 实际 {})",
                            entry_path,
                            expected_size,
                            size.unwrap_or(0)
                        ));
                    }
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

    // v4: 根据 project_type 分支 valid 判断
    // v5: transmission_line 增加 line_fam_source_count > 0 条件
    // - substation（或 null/unknown）：保持原有 IFC 缓存校验逻辑
    // v5: 线路工程计算 FAM/DEV 属性诊断字段
    let line_attr_diag = if is_line {
        compute_line_attr_diagnostic(&conn, project_id)?
    } else {
        LineAttrDiagnostic::default()
    };
    if !is_line { missing_cache_paths.extend(missing_substation_sources(&conn,app_handle,project_id)?); }
    let semantic_cache_valid = if is_line {
        parser_version_match
            && line_cbm_node_count > 0
            && line_attr_diag.fam_source_count > 0
            && line_semantic_pack_status != "invalid"
    } else {
        has_index
            && ifc_models_count > 0
            && ifc_entry_count > 0
            && cached_ifc_count == ifc_entry_count
            && missing_cache_paths.is_empty()
            && parser_version_match
            && substation_index_receipt_matches(&conn,project_id)
    };
    let valid = semantic_cache_valid;
    let substation_semantic_cache_valid = !is_line && semantic_cache_valid;

    let mut miss_reasons = Vec::new();
    if !parser_version_match {
        let domain = if is_line { "LINE" } else { "SUBSTATION" };
        let stored = if is_line {
            stored_line_parser_version.as_deref().or(project.6.as_deref())
        } else {
            stored_substation_parser_version.as_deref().or(project.6.as_deref())
        }
        .unwrap_or("(未设置)");
        let current = if is_line { LINE_PARSER_VERSION } else { SUBSTATION_PARSER_VERSION };
        miss_reasons.push(format!("{}_PARSER_VERSION_MISMATCH:{} -> {}", domain, stored, current));
    }
    if is_line {
        if line_cbm_node_count == 0 { miss_reasons.push("LINE_GRAPH_EMPTY".to_string()); }
        if line_attr_diag.fam_source_count == 0 { miss_reasons.push("LINE_FAM_SOURCE_EMPTY".to_string()); }
        if line_semantic_pack_status == "invalid" {
            miss_reasons.push(line_semantic_pack_error.clone().unwrap_or_else(|| "LINE_SEMANTIC_PACK_INVALID".to_string()));
        }
    } else {
        if !has_index { miss_reasons.push("SUBSTATION_INDEX_EMPTY".to_string()); }
        if ifc_models_count == 0 { miss_reasons.push("IFC_MODEL_EMPTY".to_string()); }
        if ifc_entry_count == 0 { miss_reasons.push("IFC_ENTRY_EMPTY".to_string()); }
        if !missing_cache_paths.is_empty() {
            miss_reasons.push(format!("IFC_CACHE_MISSING:{}", missing_cache_paths.len()));
        }
        if !geometry_cache_version_file_match {
            miss_reasons.push("GEOMETRY_CACHE_VERSION_MISMATCH".to_string());
        } else if !geometry_cache_manifest_valid {
            miss_reasons.push("GEOMETRY_MANIFEST_INVALID".to_string());
        } else if !geometry_cache_version_match {
            miss_reasons.push("GEOMETRY_CACHE_ENTRY_INVALID".to_string());
        }
    }

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
        stored_line_parser_version,
        current_line_parser_version: LINE_PARSER_VERSION.to_string(),
        line_parser_version_match,
        stored_substation_parser_version,
        current_substation_parser_version: SUBSTATION_PARSER_VERSION.to_string(),
        substation_parser_version_match,
        cache_miss_reason: cache_miss_reason(miss_reasons),
        line_semantic_pack_status,
        line_semantic_pack_error,
        geometry_cache_version_match,
        current_geometry_cache_version: GEOMETRY_CACHE_VERSION.to_string(),
        geometry_cache_version_file_match,
        geometry_cache_manifest_valid,
        substation_semantic_cache_valid,
        geometry_cache_valid: geometry_cache_version_match,
        valid,
        ifc_cache_files,
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
