//! Domain cache validity and source/attribute completeness checks.

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::Manager;
use super::cache_paths::{
    CacheValidationContext,
    cache_project_root_for_batch,
    readable_source_of_size,
};
use super::geometry_cache::{
    check_geometry_cache_manifest,
    check_geometry_cache_manifest_structure,
    check_geometry_cache_version_file,
};
use super::projects::{ensure_project_exists};
use super::{
    DbState,
    GEOMETRY_CACHE_VERSION,
    LINE_PARSER_VERSION,
    PARSER_VERSION,
    SUBSTATION_PARSER_VERSION,
    cache_miss_reason,
    count_rows,
    parser_domain_version_matches,
};
use super::semantic_pack::{
    LINE_SEMANTIC_INDEX_FILE,
    LINE_SEMANTIC_PACK_FILE,
    read_line_semantic_pack_files,
    semantic_error,
};
use super::substation_index::{
    missing_substation_sources_with_context,
    substation_index_receipt_matches,
    substation_light_source_scan,
};
use super::validation_profile::{ValidationProfile, ValidationSpan};

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
    /// v22：线路/变电独立缓存 domain 版本（旧字段保留兼容）。
    pub stored_line_parser_version: Option<String>,
    pub current_line_parser_version: String,
    pub line_parser_version_match: bool,
    pub stored_substation_parser_version: Option<String>,
    pub current_substation_parser_version: String,
    pub substation_parser_version_match: bool,
    /// invalid 时给出可操作的首要原因；多个原因以 `; ` 分隔。
    pub cache_miss_reason: Option<String>,
    pub valid: bool,
    /// 旧缓存记录中的工程类型，仅用于诊断，不参与本次校验分支选择。
    pub project_type: Option<String>,
    /// 本次校验实际使用的源工程类型。它来自当前 GIM source magic。
    pub validated_project_type: String,
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
    /// v6（方案 C）: GLB geometry cache 是否完整有效（版本标记、manifest
    /// 结构及每个 GLB 文件均通过校验）。版本/文件不匹配只影响 geometry
    /// domain，不影响 source/index cache 的有效性。
    pub geometry_cache_version_match: bool,
    /// v6（方案 C）: 当前 GEOMETRY_CACHE_VERSION（供前端诊断显示）
    pub current_geometry_cache_version: String,
    /// 版本标记文件本身是否匹配；与单个 GLB 文件完整性分开。
    pub geometry_cache_version_file_match: bool,
    /// manifest 可解析、source SHA 和条目结构是否完整；不检查每个 GLB 文件。
    /// 该值为 true 时允许前端按 DEV 隔离缺失/截断 GLB。
    pub geometry_cache_manifest_valid: bool,
    /// 变电基础索引/IFC source cache 是否有效（不包含几何版本）。
    pub substation_semantic_cache_valid: bool,
    /// 两阶段发布的第二阶段是否已完成（几何引用 + FAM/DEV 属性）。
    pub substation_properties_complete: bool,
    /// DEV GLB geometry cache 是否有效。
    pub geometry_cache_valid: bool,
}

/// v5: 线路工程 FAM/DEV 属性缓存诊断结果（内部辅助结构，供 validate/diagnostic 共用）
#[derive(Debug, Clone, Default)]
pub(super) struct LineAttrDiagnostic {
    pub(super) fam_source_count: u64,
    pub(super) dev_source_count: u64,
    pub(super) expected_fam_ref_count: u64,
    pub(super) expected_dev_ref_count: u64,
    pub(super) missing_fam_sources: Vec<String>,
    pub(super) missing_dev_sources: Vec<String>,
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
pub(super) fn compute_line_attr_diagnostic(
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
pub(super) fn inspect_line_semantic_pack(
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
/// v4 增强：根据调用方传入的 source project type 分支校验逻辑
/// - transmission_line：valid = parser_version_match && line_cbm_node_count > 0
/// - substation：保持原有 IFC/cache 校验逻辑
///
/// v5 增强（transmission_line 分支）：
/// - valid 增加 line_fam_source_count > 0 条件（FAM 属性必须存在）
/// - 输出 line_dev_source_count / line_expected_fam_ref_count / missing_* 诊断字段
#[tauri::command]
pub async fn validate_gim_cache(
    app_handle: tauri::AppHandle,
    project_id: i64,
    expected_project_type: String,
) -> Result<GimCacheValidation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<DbState>();
        validate_gim_cache_blocking(app_handle.clone(), state, project_id, expected_project_type)
    }).await.map_err(|e| format!("缓存后台校验失败: {}", e))?
}

fn validate_gim_cache_blocking(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    project_id: i64,
    expected_project_type: String,
) -> Result<GimCacheValidation, String> {
    let _profile = if expected_project_type == "substation" { Some(ValidationProfile::begin()) } else { None };
    let _total = ValidationSpan::new("total");
    let lock_timing = ValidationSpan::new("database_lock_wait");
    let locked = state.0.lock().map_err(|e| format!("获取数据库锁失败: {e}"))?;
    let revision = locked.query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0)).map_err(|e|e.to_string())?;
    let data_version:i64=locked.pragma_query_value(None,"data_version",|r|r.get(0)).map_err(|e|e.to_string())?;
    let conn=validation_snapshot(&locked)?;
    drop(locked);
    drop(lock_timing);
    ensure_project_exists(&conn, project_id)?;

    let cbm_nodes_count = count_rows(&conn, "substation_cbm_node", project_id)?;
    let ifc_models_count = count_rows(&conn, "substation_ifc_model", project_id)?;
    let file_dev_entries_count = count_rows(&conn, "substation_file_dev_entry", project_id)?;
    let line_cbm_node_count = count_rows(&conn, "powerline_cbm_node", project_id)?;
    let has_index = cbm_nodes_count > 0 || ifc_models_count > 0 || line_cbm_node_count > 0;

    // 读取旧共享版本、domain 版本和工程类型。旧版本字段只用于迁移兼容
    // 与诊断；有效性按工程类型选择独立 domain。
    let _sql = ValidationSpan::new("validation_body_including_io");
    let version_timing = ValidationSpan::new("sqlite_version_query");
    let (
        stored_parser_version,
        stored_line_parser_version,
        stored_substation_parser_version,
        project_type,
        source_sha256,
    ): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    ) = conn
        .query_row(
            "SELECT parser_version, line_parser_version, substation_parser_version, project_type, sha256 FROM gim_project WHERE id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|e| format!("读取项目版本失败: {}", e))?;

    drop(version_timing);
    if expected_project_type != "transmission_line" && expected_project_type != "substation" {
        return Err(format!(
            "缓存校验需要明确的源工程类型，收到: {}",
            expected_project_type
        ));
    }
    // 关键边界：校验分支由当前 GIM source magic 决定，不能由旧缓存中的
    // project_type 反向决定。旧字段保留在响应中，只供诊断和迁移观察。
    let is_line = expected_project_type == "transmission_line";
    let stored_project_type_match = project_type
        .as_deref()
        .map(|stored| stored == expected_project_type)
        .unwrap_or(true);
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

    // 方案 C：校验 GLB 几何缓存版本。版本不匹配只影响 geometry domain；
    // 下方 semantic_cache_valid 不依赖该值，前端会复用 source/index 并
    // 单独重建 DEV GLB。
    let geometry_cache_version_file_match =
        check_geometry_cache_version_file(&app_handle, project_id);
    let geometry_cache_manifest_valid = check_geometry_cache_manifest_structure(
        &app_handle,
        project_id,
        &source_sha256,
    );
    let geometry_structure_valid = geometry_cache_version_file_match && geometry_cache_manifest_valid;
    // Warm open must not stat/open every DEV GLB and every extracted source file
    // before it can show the first IFC/DEV progress. A structurally valid
    // manifest plus a matching parser/index receipt is enough to enter the
    // per-entry fast path; missing/truncated entries are isolated there.
    let geometry_cache_version_match = if is_line {
        false
    } else if geometry_structure_valid {
        true
    } else {
        check_geometry_cache_manifest(&app_handle, project_id, &source_sha256)
    };
    let substation_receipt_valid = if is_line {
        false
    } else {
        substation_index_receipt_matches(&conn, project_id)
    };
    let substation_properties_complete = if is_line {
        false
    } else {
        conn.query_row(
            "SELECT COALESCE(substation_properties_complete, 0) FROM gim_project WHERE id = ?1",
            params![project_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .unwrap_or(false)
    };

    // v4: 根据 project_type 分支校验
    // v5: transmission_line 增加 line_fam_source_count > 0 条件
    // substation（或 null/unknown）：保持原有 IFC/cache 校验逻辑
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

    let (ifc_entry_count, cached_ifc_count, missing_cache_paths, semantic_cache_valid) = if is_line {
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
        let context = CacheValidationContext::for_project(&app_handle, project_id).ok();
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
        let ifc_timing = ValidationSpan::new("ifc_source_files");
        for r in rows {
            let (entry_path, local_cache_path, expected_size) =
                r.map_err(|e| format!("读取 IFC entry 失败: {}", e))?;
            ifc_entry_count += 1;
            match local_cache_path {
                Some(p) if !p.is_empty() => {
                    let path = std::path::Path::new(&p);
                    if !context.as_ref().map(|c| c.contains(project_id, &entry_path, path).unwrap_or(false)).unwrap_or(false) {
                        missing_cache_paths.push(format!("{} (缓存路径不匹配)", entry_path));
                    } else if readable_source_of_size(path, expected_size) {
                        cached_ifc_count += 1;
                    } else {
                        missing_cache_paths.push(format!("{} (缓存不可读或大小不匹配)", entry_path));
                    }
                }
                _ => {
                    missing_cache_paths.push(entry_path);
                }
            }
        }

        drop(ifc_timing);
        // The IFC sources are cheap to verify and are needed for cold far
        // geometry. The remaining CBM/FAM/DEV/PHM/MOD/STL sources are not:
        // their absence is isolated by the per-entry geometry readers, and a
        // project can legitimately publish its semantic index before any GLB
        // geometry cache exists. Gating this fast path on the geometry cache
        // structure therefore made every warm open of a large project (tens of
        // thousands of entries) re-stat the whole extracted tree, which cost
        // more than the cold validation of an empty index.
        let light_source_scan = substation_light_source_scan(
            has_index,
            ifc_models_count,
            cbm_nodes_count,
            ifc_entry_count as i64,
            cached_ifc_count as i64,
            missing_cache_paths.len(),
            parser_version_match,
            substation_receipt_valid,
        );
        if !light_source_scan {
            missing_cache_paths.extend(missing_substation_sources_with_context(&conn,project_id,context.as_ref())?);
        }
        let valid = has_index
            && ifc_models_count > 0
            && ifc_entry_count > 0
            && cbm_nodes_count > 0
            && cached_ifc_count == ifc_entry_count
            && missing_cache_paths.is_empty()
            && parser_version_match
            && substation_receipt_valid;

        (
            ifc_entry_count,
            cached_ifc_count,
            missing_cache_paths,
            valid,
        )
    };

    let valid = semantic_cache_valid && stored_project_type_match;
    let substation_semantic_cache_valid = !is_line && semantic_cache_valid && stored_project_type_match;

    let mut miss_reasons = Vec::new();
    if !parser_version_match {
        let domain = if is_line { "line" } else { "substation" };
        let stored = if is_line {
            stored_line_parser_version.as_deref().or(stored_parser_version.as_deref())
        } else {
            stored_substation_parser_version.as_deref().or(stored_parser_version.as_deref())
        }
        .unwrap_or("(未设置)");
        let current = if is_line { LINE_PARSER_VERSION } else { SUBSTATION_PARSER_VERSION };
        miss_reasons.push(format!("{}_PARSER_VERSION_MISMATCH:{} -> {}", domain.to_ascii_uppercase(), stored, current));
    }
    if !stored_project_type_match {
        miss_reasons.push(format!(
            "PROJECT_TYPE_MISMATCH:{} -> {}",
            project_type.as_deref().unwrap_or("(未设置)"),
            expected_project_type
        ));
    }
    if is_line {
        if line_cbm_node_count == 0 { miss_reasons.push("LINE_GRAPH_EMPTY".to_string()); }
        if line_attr_diag.fam_source_count == 0 { miss_reasons.push("LINE_FAM_SOURCE_EMPTY".to_string()); }
        if line_semantic_pack_status == "invalid" {
            miss_reasons.push(line_semantic_pack_error.clone().unwrap_or_else(|| "LINE_SEMANTIC_PACK_INVALID".to_string()));
        }
    } else {
        if !has_index { miss_reasons.push("SUBSTATION_INDEX_EMPTY".to_string()); }
        if !substation_receipt_valid { miss_reasons.push("SUBSTATION_INDEX_RECEIPT_INVALID".to_string()); }
        if ifc_models_count == 0 { miss_reasons.push("IFC_MODEL_EMPTY".to_string()); }
        if ifc_entry_count == 0 { miss_reasons.push("IFC_ENTRY_EMPTY".to_string()); }
        if cbm_nodes_count == 0 { miss_reasons.push("CBM_NODE_EMPTY".to_string()); }
        if !missing_cache_paths.is_empty() {
            miss_reasons.push(format!("IFC_CACHE_MISSING:{}", missing_cache_paths.len()));
        }
        if !geometry_cache_version_file_match {
            miss_reasons.push("GEOMETRY_CACHE_VERSION_MISMATCH".to_string());
        } else if !geometry_cache_manifest_valid {
            miss_reasons.push("GEOMETRY_MANIFEST_INVALID".to_string());
        } else if !geometry_cache_version_match {
            // Manifest/source structure is usable; only one or more individual
            // GLB files are missing, truncated, or have an invalid header.
            // The warm fast path can isolate those DEV entries.
            miss_reasons.push("GEOMETRY_CACHE_ENTRY_INVALID".to_string());
        }
    }

    // The snapshot must not outlive a concurrent publish/delete on the owner connection.
    let locked = state.0.lock().map_err(|e|e.to_string())?;
    if locked.query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0)).map_err(|e|e.to_string())? != revision || locked.pragma_query_value(None,"data_version",|r|r.get::<_,i64>(0)).map_err(|e|e.to_string())? != data_version {
        return Err("缓存校验期间数据库已更新，请重试".to_string());
    }
    super::ensure_project_source_sha(&locked, project_id, Some(&source_sha256))?;
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
        stored_line_parser_version,
        current_line_parser_version: LINE_PARSER_VERSION.to_string(),
        line_parser_version_match,
        stored_substation_parser_version,
        current_substation_parser_version: SUBSTATION_PARSER_VERSION.to_string(),
        substation_parser_version_match,
        cache_miss_reason: cache_miss_reason(miss_reasons),
        valid,
        project_type,
        validated_project_type: expected_project_type,
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
        geometry_cache_version_file_match,
        geometry_cache_manifest_valid,
        substation_semantic_cache_valid,
        substation_properties_complete,
        geometry_cache_valid: geometry_cache_version_match,
    })
}

pub(super) fn validation_snapshot(locked:&rusqlite::Connection)->Result<rusqlite::Connection,String> {
    let mut conn = if let Some(path) = locked.path().filter(|path|!path.is_empty()) {
        let snapshot=rusqlite::Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e|e.to_string())?;
        snapshot.execute_batch("BEGIN").map_err(|e|e.to_string())?;
        snapshot.query_row("SELECT COUNT(*) FROM sqlite_master",[],|r|r.get::<_,i64>(0)).map_err(|e|e.to_string())?;
        snapshot
    } else {rusqlite::Connection::open_in_memory().map_err(|e|e.to_string())?};
    if locked.path().map(|path|path.is_empty()).unwrap_or(true) {
        let backup=rusqlite::backup::Backup::new(locked,&mut conn).map_err(|e|e.to_string())?;
        backup.run_to_completion(256,std::time::Duration::ZERO,None).map_err(|e|e.to_string())?;
    }
    Ok(conn)
}
