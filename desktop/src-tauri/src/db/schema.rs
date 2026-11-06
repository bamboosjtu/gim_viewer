//! SQLite schema and migrations; no file-cache or IPC responsibilities.

use rusqlite::Connection;

fn create_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS gim_project (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            modified_ms INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            parser_version TEXT,
            line_parser_version TEXT,
            substation_parser_version TEXT,
            project_type TEXT,
            substation_capability_summary_json TEXT,
            substation_index_receipt_json TEXT,
            substation_properties_complete INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            last_opened_at_ms INTEGER NOT NULL,
            UNIQUE(path)
        );
        CREATE INDEX IF NOT EXISTS idx_gim_project_sha256 ON gim_project(sha256);
        CREATE INDEX IF NOT EXISTS idx_gim_project_path ON gim_project(path);

        CREATE TABLE IF NOT EXISTS app_setting (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS substation_gim_entry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            entry_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            entry_type TEXT NOT NULL,
            local_cache_path TEXT,
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
            raw_properties_json TEXT,
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
            source_design_file TEXT,
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
            source_line INTEGER NOT NULL,
            raw_property_json TEXT,
            UNIQUE(project_id, source_path, source_line)
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

        ",
    )
    .map_err(|e| format!("初始化数据库表失败: {}", e))?;

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
            normalized_ref_value TEXT,
            file_name_lower TEXT,
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

    Ok(())
}

/// Unreleased physical schema. Remove the development database after structural changes.
pub(super) fn initialize_schema(conn: &Connection) -> Result<(), String> {
    create_schema(conn)?;
    conn.pragma_update(None,"user_version",1).map_err(|e|e.to_string())
}

pub(super) const PER_PROJECT_TABLES: &[&str] = &[
    "substation_gim_entry", "substation_cbm_node", "substation_ifc_model",
    "substation_file_dev_entry", "substation_fam_property", "substation_dev_property",
    "substation_dev_solid_model", "substation_dev_sub_device", "substation_phm_solid_model",
    "powerline_cbm_node", "powerline_cbm_child", "powerline_cbm_ref", "powerline_file_stat",
    "powerline_fam_property", "powerline_dev_property", "powerline_cache_session",
];
pub(super) fn clear_project_tables(conn: &Connection, project_id: i64) -> Result<(), String> {
    for table in PER_PROJECT_TABLES {
        conn.execute(&format!("DELETE FROM {table} WHERE project_id=?1"), [project_id]).map_err(|e|e.to_string())?;
    }
    Ok(())
}
