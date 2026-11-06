//! Chunked line graph/attribute transactions and queries.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::Path;
use super::cache_paths::{ensure_cache_project_id, validate_entry_path};
use super::projects::{ensure_project_exists, ensure_project_source_sha};
use super::{DbState, LINE_PARSER_VERSION, MAX_LINE_TEXT_BYTES, PARSER_VERSION, now_ms};

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

pub(super) fn clear_powerline_tables(tx: &rusqlite::Transaction, pid: i64) -> Result<(), String> {
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
pub(super) fn invalidate_line_parser_version(tx: &rusqlite::Transaction, pid: i64) -> Result<(), String> {
    tx.execute(
        "UPDATE gim_project SET parser_version = NULL, line_parser_version = NULL WHERE id = ?1",
        params![pid],
    )
    .map_err(|e| format!("清空线路 parser_version 失败: {}", e))?;
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
pub(super) fn insert_line_attr_chunk(
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
        "UPDATE gim_project SET parser_version = ?1, line_parser_version = ?2, project_type = 'transmission_line', updated_at_ms = ?3 WHERE id = ?4",
        params![PARSER_VERSION, LINE_PARSER_VERSION, now, project_id],
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
