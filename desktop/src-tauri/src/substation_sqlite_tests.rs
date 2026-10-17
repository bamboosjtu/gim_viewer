use super::*;

/// Manual native registration probe. Each invocation is a fresh Rust process;
/// it uses a dedicated on-disk DB, never the application's existing cache.
#[test]
#[ignore = "requires GIM_PROJECT_CHECK_SOURCE and GIM_PROJECT_CHECK_DIR"]
fn project_registration_native_profile() {
    use std::io::Read;
    let source=PathBuf::from(std::env::var_os("GIM_PROJECT_CHECK_SOURCE").expect("explicit source GIM required"));
    let directory=PathBuf::from(std::env::var_os("GIM_PROJECT_CHECK_DIR").expect("isolated output directory required"));
    assert!(source.is_absolute() && directory.is_absolute());
    stdfs::create_dir_all(&directory).unwrap();
    let identity_started=Instant::now();
    let metadata=stdfs::metadata(&source).unwrap();
    let mut hash=sha2::Sha256::new();let mut file=stdfs::File::open(&source).unwrap();let mut buffer=vec![0_u8;1024*1024];
    loop {let count=file.read(&mut buffer).unwrap();if count==0 {break;}hash.update(&buffer[..count]);}
    let sha=format!("{:x}",hash.finalize());
    let identity_ms=identity_started.elapsed().as_secs_f64()*1000.0;
    let input=FileInfoInput{path:source.to_string_lossy().to_string(),name:source.file_name().unwrap().to_string_lossy().to_string(),
        size:metadata.len(),modified_ms:metadata.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,sha256:sha.clone()};
    let conn=Connection::open(directory.join("registration.db")).unwrap();
    conn.busy_timeout(std::time::Duration::from_millis(100)).unwrap();
    conn.pragma_update(None,"journal_mode","WAL").unwrap();initialize_schema(&conn).unwrap();
    let count:i64=conn.query_row("SELECT COUNT(*) FROM gim_project",[],|row|row.get(0)).unwrap();
    let phase=if count==0 {"first-registration"} else {"new-process-registration-hit"};
    // An unchanged warm registration must stay read-only even with an unrelated
    // writer holding the WAL write reservation.
    let writer=Connection::open(directory.join("registration.db")).unwrap();
    if count>0 {writer.execute_batch("BEGIN IMMEDIATE").unwrap();}
    let state=DbState(Mutex::new(conn));let started=Instant::now();
    let record=upsert_gim_project_inner(&state,input).unwrap();let elapsed_ms=started.elapsed().as_secs_f64()*1000.0;
    if count>0 {writer.execute_batch("ROLLBACK").unwrap();}
    let result=serde_json::json!({"scope":"Native registration core only; no Tauri WebView, semantic restore or geometry", "pid":std::process::id(),
        "phase":phase,"source_sha256":sha,"source_bytes":metadata.len(),"identity_ms":identity_ms,"registration_ms":elapsed_ms,"project_id":record.id,
        "other_writer_reserved":count>0});
    stdfs::write(directory.join(format!("registration-{}.json",std::process::id())),serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    println!("NATIVE_PROJECT_PROFILE {}",result);
}

fn project(conn: &Connection, id: i64, sha: &str) {
    conn.execute("INSERT INTO gim_project(id,path,name,size,modified_ms,sha256,created_at_ms,updated_at_ms,last_opened_at_ms) VALUES(?1,?2,'fixture',0,0,?3,0,0,0)",
        params![id, format!("fixture-{}.gim", id), sha]).unwrap();
}

#[test]
fn semantic_receipt_rejects_truncation_changed_sha_and_pending_or_failed_publication() {
    let mut conn=Connection::open_in_memory().unwrap();
    initialize_schema(&conn).unwrap(); project(&conn,1,"source-a");
    let value=serde_json::json!({"project_id":1,"source_sha256":"source-a",
        "entries":[{"entry_path":"CBM/model.ifc","file_name":"model.ifc","entry_type":"IFC","file_size":1}],
        "cbm_nodes":[{"node_key":"CBM/project.cbm","path":"CBM/project.cbm","name":"project","sort_order":0}],
        "ifc_models":[{"model_id":"model","name":"model","entry_path":"CBM/model.ifc"}],
        "file_dev_entries":[],"fam_properties":[{"source_path":"CBM/props.fam","section_name":"design","prop_key":"key","prop_value":"value","sort_order":0,"source_line":1}],"dev_properties":[]});
    save_gim_index_connection(&mut conn,serde_json::from_value(value.clone()).unwrap()).unwrap();
    assert!(!substation_index_receipt_matches(&conn,1));
    save_geometry_refs_connection(&mut conn,serde_json::from_value(serde_json::json!({"project_id":1,"source_sha256":"source-a","dev_solid_models":[],"dev_sub_devices":[],"phm_solid_models":[]})).unwrap()).unwrap();
    assert!(substation_index_receipt_matches(&conn,1));
    { let tx=conn.unchecked_transaction().unwrap(); tx.execute("DELETE FROM substation_fam_property",[]).unwrap(); assert!(!substation_index_receipt_matches(&tx,1)); }
    assert!(substation_index_receipt_matches(&conn,1));
    { let tx=conn.unchecked_transaction().unwrap(); tx.execute("UPDATE gim_project SET sha256='source-b' WHERE id=1",[]).unwrap(); assert!(!substation_index_receipt_matches(&tx,1)); }
    let mut old=value.clone(); old["source_sha256"]=serde_json::json!("stale-source");
    assert!(save_gim_index_connection(&mut conn,serde_json::from_value(old).unwrap()).is_err());
    assert!(substation_index_receipt_matches(&conn,1));
    save_gim_index_connection(&mut conn,serde_json::from_value(value).unwrap()).unwrap();
    assert!(!substation_index_receipt_matches(&conn,1));
}

#[test]
fn semantic_source_missing_wrong_size_and_empty_file_are_distinct() {
    let dir=std::env::temp_dir().join(format!("gim-source-readability-{}",std::process::id()));
    std::fs::create_dir_all(&dir).unwrap(); let path=dir.join("empty.fam");
    std::fs::write(&path,b"").unwrap();
    assert!(readable_source_of_size(&path,0)); assert!(!readable_source_of_size(&path,1));
    std::fs::remove_file(&path).unwrap(); assert!(!readable_source_of_size(&path,0));
    std::fs::remove_dir(dir).unwrap();
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
        assert!(!substation_index_receipt_matches(&conn,pid));
        let pending: Option<String> = conn.query_row("SELECT substation_parser_version FROM gim_project WHERE id=?1",params![pid],|r|r.get(0)).unwrap();
        assert!(pending.is_none());
        save_gim_index_connection(&mut conn, serde_json::from_value(request["index"].clone()).unwrap()).unwrap();
        save_geometry_refs_connection(&mut conn, refs).unwrap();
        assert!(substation_index_receipt_matches(&conn,pid));
        drop(conn);
        // Warm read reopens the on-disk SQLite database; no payload substitution.
        let conn = Connection::open(&sqlite_path).unwrap();
        assert!(substation_index_receipt_matches(&conn,pid));
        // Truncated properties / interrupted index and source identity changes
        // are rejected independently of whether any DEV GLB has completed.
        {
            let tx=conn.unchecked_transaction().unwrap();
            tx.execute("DELETE FROM substation_cbm_node WHERE rowid=(SELECT rowid FROM substation_cbm_node WHERE project_id=?1 LIMIT 1)",params![pid]).unwrap();
            assert!(!substation_index_receipt_matches(&tx,pid));
        }
        {
            let tx=conn.unchecked_transaction().unwrap();
            tx.execute("UPDATE gim_project SET sha256='changed-source' WHERE id=?1",params![pid]).unwrap();
            assert!(!substation_index_receipt_matches(&tx,pid));
        }
        let warm = get_gim_index_connection(&conn, pid).unwrap();
        let reachable = query_reachable_geometry_filtered(&conn,pid,true,true,None).unwrap();
        let filter = request["filter"].as_array().map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect());
        let filtered = query_reachable_geometry_filtered(&conn,pid,true,true,filter.as_ref()).unwrap();
        output.push(serde_json::json!({"index":warm,"reachable":reachable,"filtered":filtered,"version":SUBSTATION_PARSER_VERSION}));
    }
    std::fs::write(output_path,serde_json::to_vec(&output).unwrap()).unwrap();
}

/// Read-only native path replay. Opt-in; this is not a Tauri/WebView run.
#[test]
fn validation_path_replay() {
    let Ok(base)=std::env::var("GIM_VALIDATION_REPLAY") else { return };
    let base=std::path::PathBuf::from(base);
    let conn=Connection::open_with_flags(base.join("gim_cache.db"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let _profile=ValidationProfile::begin();let _total=ValidationSpan::new("total");
    assert!(substation_index_receipt_matches(&conn,1));
    let root=base.join("extracted").join("1");
    let mut stmt=conn.prepare("SELECT entry_path,local_cache_path,file_size FROM substation_gim_entry WHERE project_id=1").unwrap();
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?))).unwrap();
    let mut n=0;
    for row in rows {let (entry,path,size)=row.unwrap();let ext=entry.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(),"ifc"|"cbm"|"fam"|"dev"|"phm"|"mod"|"gl"|"stl"|"sch"|"std"|"sld") {continue;}
        let path=std::path::PathBuf::from(path.unwrap());assert!(is_expected_cache_path_in_root(&root,&entry,&path).unwrap());assert!(readable_source_of_size(&path,size));n+=1;
    }
    eprintln!("validation_path_replay files={}",n);
}

#[test]
fn source_invalid_manifest_requires_diagnostic_and_zero_bytes() {
    let mut e=GeometryCacheManifestEntry{entry_path:"DEV/bad.dev".into(),status:"source-invalid".into(),size:0,diagnostic:Some("typed bbox rejection; MOD/bad.mod".into())};
    assert!(validate_geometry_manifest_entry_shape(&e,&mut HashSet::new()).is_ok());
    e.diagnostic=None;assert!(validate_geometry_manifest_entry_shape(&e,&mut HashSet::new()).is_err());
    e.diagnostic=Some("typed source diagnostic".into());e.size=12;assert!(validate_geometry_manifest_entry_shape(&e,&mut HashSet::new()).is_err());
    assert_ne!(GEOMETRY_CACHE_VERSION,"geometry-cache-v8-occurrence");
}
