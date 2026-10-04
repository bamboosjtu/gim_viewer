use super::*;

fn project(conn: &Connection, id: i64, sha: &str) {
    conn.execute("INSERT INTO gim_project(id,path,name,size,modified_ms,sha256,created_at_ms,updated_at_ms,last_opened_at_ms) VALUES(?1,?2,'fixture',0,0,?3,0,0,0)",
        params![id, format!("fixture-{}.gim", id), sha]).unwrap();
}

#[test]
fn fam_schema_migrates_without_losing_existing_rows() {
    let conn = Connection::open_in_memory().unwrap();
    initialize_schema(&conn).unwrap();
    project(&conn, 1, "old");
    conn.execute_batch("DROP TABLE substation_fam_property;
        CREATE TABLE substation_fam_property(id INTEGER PRIMARY KEY,project_id,source_path,section_name,prop_key,prop_value,sort_order,created_at_ms,raw_property_json,
            UNIQUE(project_id,source_path,section_name,prop_key));
        INSERT INTO substation_fam_property VALUES(1,1,'DEV/old.fam','design','key','value',7,0,'{\"rawLine\":\"key=value\"}');
        UPDATE gim_project SET substation_parser_version='gim-substation-parser-v24',line_parser_version='gim-line-parser-v1';").unwrap();
    migrate_fam_rows(&conn).unwrap();
    migrate_fam_rows(&conn).unwrap();
    let old: (String, String, i64) = conn.query_row("SELECT prop_value,raw_property_json,source_line FROM substation_fam_property", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(old, ("value".into(), "{\"rawLine\":\"key=value\"}".into(),1));
    conn.execute("INSERT INTO substation_fam_property(project_id,source_path,section_name,prop_key,prop_value,sort_order,created_at_ms,source_line) VALUES(1,'DEV/old.fam','design','key','other',8,0,2)", []).unwrap();
    let versions: (String,String) = conn.query_row("SELECT substation_parser_version,line_parser_version FROM gim_project", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_ne!(versions.0, SUBSTATION_PARSER_VERSION); // old semantic domain rebuilds
    assert_eq!(versions.1, LINE_PARSER_VERSION);
    project(&conn, 2, "legacy-v22");
    conn.execute("UPDATE gim_project SET project_type='substation',parser_version='gim-parser-v22' WHERE id=2", []).unwrap();
    initialize_schema(&conn).unwrap();
    let migrated_version: String = conn.query_row("SELECT substation_parser_version FROM gim_project WHERE id=2", [], |row| row.get(0)).unwrap();
    assert_eq!(migrated_version, "gim-substation-parser-v22");
    assert!(!parser_domain_version_matches(Some(&migrated_version), Some("gim-parser-v22"), SUBSTATION_PARSER_VERSION, LEGACY_SUBSTATION_PARSER_VERSIONS));
}

/// Test-only file exchange. TS tests feed actual production payloads and restore
/// only these SELECT results. Strict gate fails if no output file is produced.
#[test]
fn substation_sqlite_exchange() {
    let Ok(input_path) = std::env::var("GIM_SQLITE_INPUT") else { return };
    let output_path = std::env::var("GIM_SQLITE_OUTPUT").unwrap();
    let input: serde_json::Value = serde_json::from_slice(&std::fs::read(input_path).unwrap()).unwrap();
    let mut output = Vec::new();
    for (ordinal, request) in input.as_array().unwrap().iter().enumerate() {
        let sqlite_path = std::path::Path::new(&output_path).parent().unwrap().join(format!("fixture-{}.db", ordinal));
        let mut conn = Connection::open(&sqlite_path).unwrap();
        initialize_schema(&conn).unwrap();
        let index: GimIndexPayload = serde_json::from_value(request["index"].clone()).unwrap();
        let refs: GeometryRefsPayload = serde_json::from_value(request["refs"].clone()).unwrap();
        let pid = index.project_id;
        project(&conn, pid, index.source_sha256.as_deref().unwrap_or("fixture"));
        if request["migrate"].as_bool().unwrap_or(false) {
            conn.execute_batch("DROP TABLE substation_fam_property;
                CREATE TABLE substation_fam_property(id INTEGER PRIMARY KEY,project_id,source_path,section_name,prop_key,prop_value,sort_order,created_at_ms,raw_property_json,
                    UNIQUE(project_id,source_path,section_name,prop_key));
                INSERT INTO substation_fam_property VALUES(1,1,'DEV/legacy.fam','design','key','old',0,0,NULL);").unwrap();
            migrate_fam_rows(&conn).unwrap();
        }
        // Only production INSERT/SELECT results cross back into the TS restore.
        save_gim_index_connection(&mut conn, index).unwrap();
        save_gim_index_connection(&mut conn, serde_json::from_value(request["index"].clone()).unwrap()).unwrap();
        save_geometry_refs_connection(&mut conn, refs).unwrap();
        drop(conn);
        // Warm read reopens the on-disk SQLite database; no payload substitution.
        let conn = Connection::open(&sqlite_path).unwrap();
        let warm = get_gim_index_connection(&conn, pid).unwrap();
        let reachable = query_reachable_geometry_filtered(&conn,pid,true,true,None).unwrap();
        let filter = request["filter"].as_array().map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect());
        let filtered = query_reachable_geometry_filtered(&conn,pid,true,true,filter.as_ref()).unwrap();
        output.push(serde_json::json!({"index":warm,"reachable":reachable,"filtered":filtered,"version":SUBSTATION_PARSER_VERSION}));
    }
    std::fs::write(output_path,serde_json::to_vec(&output).unwrap()).unwrap();
}
