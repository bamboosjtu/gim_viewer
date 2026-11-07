//! Transactional substation source/index persistence and geometry references.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use super::cache_paths::{
    CacheValidationContext,
    ensure_cache_project_id,
    readable_source_of_size,
    validate_entry_path,
};
use super::projects::{ensure_project_exists, ensure_project_source_sha};
use super::{
    DbState,
    MAX_LINE_TEXT_BYTES,
    PARSER_VERSION,
    SUBSTATION_PARSER_VERSION,
    count_rows,
    now_ms,
};
use super::semantic_pack::{substation_pack_contains};
use super::validation_profile::{ValidationSpan};

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
    pub raw_properties_json: Option<String>,
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
    pub source_design_file: Option<String>,
    pub model_id: String,
    pub ifc_name: String,
    pub ifc_file: String,
    pub device_count: i64,
    pub device_cbm: String,
    pub sort_order: i64,
}

#[derive(Debug, Deserialize)]
pub struct FamPropertyPayload {
    pub source_line: Option<i64>,
    pub raw_property_json: Option<String>,
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
    pub capability_summary_json: Option<String>,
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
            || f.source_design_file.as_ref().map(|v| v.len() > 4096).unwrap_or(false)
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

/// Tauri command：保存 GIM 索引（事务：先删后插）
///
/// Publish a CBM project index; DEV-only projects legitimately have no IFC.
#[tauri::command]
pub async fn save_gim_index(
    app_handle: tauri::AppHandle,
    payload: GimIndexPayload,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<DbState>();
        let mut conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
        save_gim_index_connection(&mut conn, payload)
    }).await.map_err(|e| format!("索引后台任务失败: {}", e))?
}

pub(super) fn save_gim_index_connection(conn: &mut Connection, payload: GimIndexPayload) -> Result<(), String> {

    validate_index_payload(&payload)?;

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
            "INSERT INTO substation_cbm_node (project_id, node_key, parent_key, path, name, entity_name, classify_name, fam_path, dev_path, ifc_file, ifc_guid, transform_matrix, sort_order, created_at_ms, raw_properties_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
                n.raw_properties_json,
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
            "INSERT INTO substation_file_dev_entry (project_id, model_id, ifc_name, ifc_file, device_count, device_cbm, sort_order, created_at_ms, source_design_file)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![pid, f.model_id, f.ifc_name, f.ifc_file, f.device_count, f.device_cbm, f.sort_order, now, f.source_design_file],
        )
        .map_err(|e| format!("插入 substation_file_dev_entry 失败: {}", e))?;
    }

    // substation_fam_property
    for fp in &payload.fam_properties {
        tx.execute(
            "INSERT INTO substation_fam_property (project_id, source_path, section_name, prop_key, prop_value, sort_order, created_at_ms, raw_property_json, source_line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![pid, fp.source_path, fp.section_name, fp.prop_key, fp.prop_value, fp.sort_order, now, fp.raw_property_json, fp.source_line.unwrap_or(fp.sort_order + 1)],
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
        "UPDATE gim_project SET parser_version = NULL, substation_parser_version = NULL, substation_index_receipt_json = NULL, substation_properties_complete = 0, project_type = 'substation', updated_at_ms = ?1, substation_capability_summary_json = ?3 WHERE id = ?2",
        params![now, pid, payload.capability_summary_json],
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
    pub raw_properties_json: Option<String>,
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

// Publication receipt belongs to the existing semantic domain. It detects
// truncated/deleted index rows on the next open without depending on GLBs.
fn substation_index_receipt(conn: &Connection, project_id: i64) -> Result<String, String> {
    let _timing = ValidationSpan::new("receipt");
    let sha: String = conn.query_row("SELECT sha256 FROM gim_project WHERE id=?1", params![project_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut counts = std::collections::BTreeMap::new();
    for table in ["substation_gim_entry", "substation_cbm_node", "substation_ifc_model",
        "substation_file_dev_entry", "substation_fam_property", "substation_dev_property",
        "substation_dev_solid_model", "substation_dev_sub_device", "substation_phm_solid_model"] {
        counts.insert(table, count_rows(conn,table,project_id)?);
    }
    if counts["substation_cbm_node"] == 0 || counts["substation_gim_entry"] == 0 {
        return Err("拒绝发布不完整变电语义索引".to_string());
    }
    serde_json::to_string(&serde_json::json!({"sha256":sha,"version":SUBSTATION_PARSER_VERSION,"counts":counts}))
        .map_err(|e| e.to_string())
}

pub(super) fn substation_index_receipt_matches(conn: &Connection, project_id: i64) -> bool {
    let stored: Option<String> = conn.query_row("SELECT substation_index_receipt_json FROM gim_project WHERE id=?1",params![project_id],|r|r.get(0)).ok().flatten();
    stored.is_some() && substation_index_receipt(conn,project_id).ok() == stored
}

/// Warm-open gate for the extracted-source completeness scan.
///
/// The receipt already binds the published index counts and parser version, and
/// every IFC source is verified separately, so a consistent index makes the
/// full scan of the extracted tree redundant. Geometry-cache structure is
/// deliberately not part of this decision: a project may publish semantic
/// index and parser version before DEV GLB caching finishes, and a missing
/// non-IFC source is recovered per entry by the geometry readers.
pub(super) fn substation_light_source_scan(
    has_index: bool,
    cbm_nodes_count: i64,
    ifc_entry_count: i64,
    cached_ifc_count: i64,
    missing_ifc_cache_paths: usize,
    parser_version_match: bool,
    receipt_valid: bool,
) -> bool {
    has_index
        && cbm_nodes_count > 0
        && cached_ifc_count == ifc_entry_count
        && missing_ifc_cache_paths == 0
        && parser_version_match
        && receipt_valid
}

pub(super) fn missing_substation_sources(conn: &Connection, app: &tauri::AppHandle, project_id: i64) -> Result<Vec<String>,String> {
    let context = CacheValidationContext::for_project(app, project_id).ok();
    missing_substation_sources_with_context(conn, project_id, context.as_ref())
}

pub(super) fn missing_substation_sources_with_context(conn: &Connection, project_id: i64, context: Option<&CacheValidationContext>) -> Result<Vec<String>,String> {
    let _timing = ValidationSpan::new("source_scan_path_files");
    let mut stmt = conn.prepare("SELECT entry_path, local_cache_path, file_size FROM substation_gim_entry WHERE project_id=?1").map_err(|e|e.to_string())?;
    let rows = stmt.query_map(params![project_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?))).map_err(|e|e.to_string())?;
    let mut missing = Vec::new();
    for row in rows {
        let (entry, local, size) = row.map_err(|e|e.to_string())?;
        let ext = entry.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(),"cbm"|"fam"|"dev"|"phm"|"mod"|"gl"|"stl"|"sch"|"std"|"sld") { continue; }
        let packed_ok = local.is_none()
            && size >= 0
            && context
                .map(|c| substation_pack_contains(&c.canonical_root, &entry, size as u64))
                .unwrap_or(false);
        let valid = packed_ok || local.as_deref().map(|p| {
            let path = std::path::Path::new(p);
            context.map(|c| c.contains(project_id, &entry, path).unwrap_or(false)).unwrap_or(false)
                && readable_source_of_size(path,size)
        }).unwrap_or(false);
        if !valid { missing.push(format!("{} (语义/原始几何源缓存不可读)",entry)); }
    }
    Ok(missing)
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
        raw_properties_json: row.get(15)?,
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
    pub source_design_file: Option<String>,
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
    pub source_line: i64,
    pub raw_property_json: Option<String>,
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
    pub capability_summary_json: Option<String>,
    pub entries: Vec<GimEntryRecord>,
    pub cbm_nodes: Vec<CbmNodeRecord>,
    pub ifc_models: Vec<IfcModelRecord>,
    pub file_dev_entries: Vec<FileDevEntryRecord>,
    pub fam_properties: Vec<FamPropertyRecord>,
    pub dev_properties: Vec<DevPropertyRecord>,
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
        source_design_file: row.get(9)?,
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
        source_line: row.get(9)?,
        raw_property_json: row.get(8)?,
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
    get_gim_index_connection(&conn, project_id)
}

pub(super) fn get_gim_index_connection(conn: &Connection, project_id: i64) -> Result<GetGimIndexResult, String> {
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
            "SELECT id, project_id, node_key, parent_key, path, name, entity_name, classify_name, fam_path, dev_path, ifc_file, ifc_guid, transform_matrix, sort_order, created_at_ms, raw_properties_json
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

    // 3. substation_ifc_model: INSERT follows cold load order. Preserve it:
    // model_id is a hash identity, not a presentation/loading order; changing
    // the first IFC also changes the project coordinate anchor.
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, model_id, name, entry_path, created_at_ms
             FROM substation_ifc_model
             WHERE project_id = ?1
             ORDER BY id ASC",
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
            "SELECT id, project_id, model_id, ifc_name, ifc_file, device_count, device_cbm, sort_order, created_at_ms, source_design_file
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
            "SELECT id, project_id, source_path, section_name, prop_key, prop_value, sort_order, created_at_ms, raw_property_json, source_line
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

    let capability_summary_json = conn.query_row(
        "SELECT substation_capability_summary_json FROM gim_project WHERE id = ?1",
        params![project_id], |row| row.get::<_, Option<String>>(0),
    ).map_err(|e| format!("读取 capability summary 失败: {}", e))?;
    Ok(GetGimIndexResult {
        capability_summary_json,
        entries,
        cbm_nodes,
        ifc_models,
        file_dev_entries,
        fam_properties,
        dev_properties,
    })
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
        if !lower.ends_with(".mod") && !lower.ends_with(".gl") && !lower.ends_with(".stl") && !lower.ends_with(".phm") {
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
pub async fn save_geometry_refs(
    app_handle: tauri::AppHandle,
    payload: GeometryRefsPayload,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<DbState>();
        let mut conn = state.0.lock().map_err(|e| format!("获取数据库锁失败: {}", e))?;
        save_geometry_refs_connection(&mut conn, payload)
    }).await.map_err(|e| format!("几何引用后台任务失败: {}", e))?
}

pub(super) fn save_geometry_refs_connection(conn: &mut Connection, payload: GeometryRefsPayload) -> Result<(), String> {

    validate_geometry_refs_payload(&payload)?;
    ensure_project_exists(&conn, payload.project_id)?;
    ensure_project_source_sha(&conn, payload.project_id, payload.source_sha256.as_deref())?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    let pid = payload.project_id;

    replace_geometry_refs(&tx, &payload, now)?;

    // 几何引用链写入成功后才提交变电缓存 ready 状态；任何前置索引或
    // 引用链失败都保持 parser_version=NULL，下次打开会完整重建。
    let receipt = substation_index_receipt(&tx,pid)?;
    tx.execute(
        "UPDATE gim_project SET parser_version = ?1, substation_parser_version = ?2, project_type = 'substation', updated_at_ms = ?3, substation_index_receipt_json = ?5 WHERE id = ?4",
        params![PARSER_VERSION, SUBSTATION_PARSER_VERSION, now, pid, receipt],
    )
    .map_err(|e| format!("提交变电缓存版本失败: {}", e))?;

    tx.commit()
        .map_err(|e| format!("提交几何引用链事务失败: {}", e))?;
    Ok(())
}

/// 两阶段发布的第二阶段负载：几何引用 + FAM/DEV 属性。
#[derive(Debug, Deserialize)]
pub struct SubstationSemanticRestPayload {
    pub project_id: i64,
    pub source_sha256: Option<String>,
    pub refs: GeometryRefsPayload,
    pub fam_properties: Vec<FamPropertyPayload>,
    pub dev_properties: Vec<DevPropertyPayload>,
    #[serde(default)]
    pub capability_summary_json: Option<String>,
}

/// Tauri command：补写变电索引的几何引用与 FAM/DEV 属性。
///
/// 第一阶段只用内存中的树/关系提交 entries + 树 + IFC + 关系 + receipt，
/// 让暖启动立即可用；本阶段在后台补写较慢的引用与属性，并在同一事务内
/// 重算 receipt、置 `substation_properties_complete=1`。失败时第一阶段
/// 的缓存仍然有效，下次暖启动会重试本阶段。
#[tauri::command]
pub async fn save_substation_semantic_rest(
    app_handle: tauri::AppHandle,
    payload: SubstationSemanticRestPayload,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<DbState>();
        let mut conn = state
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        save_substation_semantic_rest_connection(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("索引补写后台任务失败: {}", e))?
}

fn save_substation_semantic_rest_connection(
    conn: &mut Connection,
    payload: SubstationSemanticRestPayload,
) -> Result<(), String> {
    if payload.refs.project_id != payload.project_id {
        return Err("索引补写与引用链的工程标识不一致".to_string());
    }
    validate_geometry_refs_payload(&payload.refs)?;
    ensure_project_exists(conn, payload.project_id)?;
    ensure_project_source_sha(
        conn,
        payload.project_id,
        payload
            .source_sha256
            .as_deref()
            .or(payload.refs.source_sha256.as_deref()),
    )?;
    let version: Option<String> = conn
        .query_row(
            "SELECT substation_parser_version FROM gim_project WHERE id = ?1",
            params![payload.project_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取变电版本失败: {}", e))?;
    if version.as_deref() != Some(SUBSTATION_PARSER_VERSION) {
        return Err("索引核心尚未提交，拒绝补写引用与属性".to_string());
    }
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let now = now_ms();
    let pid = payload.project_id;
    replace_geometry_refs(&tx, &payload.refs, now)?;
    for table in ["substation_fam_property", "substation_dev_property"] {
        tx.execute(&format!("DELETE FROM {table} WHERE project_id=?1"), params![pid]).map_err(|e|e.to_string())?;
    }
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO substation_fam_property (project_id, source_path, section_name, prop_key, prop_value, sort_order, created_at_ms, raw_property_json, source_line)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|e| format!("预处理 substation_fam_property 失败: {}", e))?;
        for fp in &payload.fam_properties {
            stmt.execute(params![
                pid,
                fp.source_path,
                fp.section_name,
                fp.prop_key,
                fp.prop_value,
                fp.sort_order,
                now,
                fp.raw_property_json,
                fp.source_line.unwrap_or(fp.sort_order + 1)
            ])
            .map_err(|e| format!("插入 substation_fam_property 失败: {}", e))?;
        }
    }
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO substation_dev_property (project_id, dev_path, prop_key, prop_value, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| format!("预处理 substation_dev_property 失败: {}", e))?;
        for dp in &payload.dev_properties {
            stmt.execute(params![pid, dp.dev_path, dp.prop_key, dp.prop_value, now])
                .map_err(|e| format!("插入 substation_dev_property 失败: {}", e))?;
        }
    }
    let receipt = substation_index_receipt(&tx, pid)?;
    tx.execute(
        "UPDATE gim_project SET substation_index_receipt_json = ?1, substation_properties_complete = 1, substation_capability_summary_json = COALESCE(?4, substation_capability_summary_json), updated_at_ms = ?2 WHERE id = ?3",
        params![receipt, now, pid, payload.capability_summary_json],
    )
    .map_err(|e| format!("提交索引补写凭据失败: {}", e))?;
    tx.commit()
        .map_err(|e| format!("提交索引补写事务失败: {}", e))?;
    Ok(())
}

fn replace_geometry_refs(tx: &Connection, payload: &GeometryRefsPayload, now: u64) -> Result<(), String> {
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

    Ok(())
}
