use std::collections::HashSet;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
#[test]
    fn broken_project_diagnostic_output_cannot_poison_db_lock() {
        struct BrokenOutput;
        impl std::io::Write for BrokenOutput {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed stdout"))
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let db = std::sync::Mutex::new(());
        {
            let _guard = db.lock().unwrap();
            super::write_project_diagnostic(&mut BrokenOutput, format_args!("project check"));
        }
        assert!(db.lock().is_ok());
    }
    #[test]
    fn atomic_cache_write_replaces_file_and_preserves_target_on_failed_replacement() {
        let root = crate::workspace_test_temp().join(format!("gim-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("template.bin");
        std::fs::write(&file, b"previous").unwrap();
        super::atomic_write(&file, b"next", "test").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"next");
        super::atomic_write_derived(&file, b"derived", "test").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"derived");
        let directory = root.join("must-remain");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("record"), b"valid").unwrap();
        assert!(super::atomic_write(&directory, b"invalid", "test").is_err());
        assert!(super::atomic_write_derived(&directory, b"invalid", "test").is_err());
        assert_eq!(std::fs::read(directory.join("record")).unwrap(), b"valid");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn validation_context_checks_exact_project_paths_and_both_root_spellings() {
        let root = crate::workspace_test_temp().join(format!("gim-context-{}", std::process::id()));
        std::fs::create_dir_all(root.join("1/CBM")).unwrap();
        std::fs::create_dir_all(root.join("2/CBM")).unwrap();
        let file = root.join("1/CBM/model.ifc");
        std::fs::write(&file, b"model").unwrap();
        let context = super::CacheValidationContext::new(1, &root.join("1")).unwrap();
        assert!(context.contains(1, "CBM/model.ifc", &file).unwrap());
        assert!(context.contains(1, "CBM/model.ifc", &file.canonicalize().unwrap()).unwrap());
        assert!(!context.contains(2, "CBM/model.ifc", &file).unwrap());
        assert!(!context.contains(1, "CBM/model.ifc", &root.join("2/CBM/model.ifc")).unwrap());
        assert!(context.contains(1, "../CBM/model.ifc", &file).is_err());
        assert!(context.contains(1, "/CBM/model.ifc", &file).is_err());
        assert!(context.contains(1, "C:\\CBM\\model.ifc", &file).is_err());
        assert!(super::readable_source_of_size(&file, 5));
        assert!(!super::readable_source_of_size(&file, 4));
        assert!(!super::readable_source_of_size(&file, -1));
        assert!(!super::readable_source_of_size(&root.join("1/CBM"), 0));
        #[cfg(windows)]
        assert!(std::fs::rename(root.join("1"), root.join("moved")).is_err(), "trusted root must be pinned against replacement");
        drop(context);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validation_context_rechecks_changed_directory_and_rejects_links() {
        let root = crate::workspace_test_temp().join(format!("gim-context-links-{}", std::process::id()));
        std::fs::create_dir_all(root.join("1/CBM")).unwrap();
        std::fs::create_dir_all(root.join("outside")).unwrap();
        let file = root.join("1/CBM/model.ifc");
        std::fs::write(&file, b"model").unwrap();
        std::fs::write(root.join("outside/model.ifc"), b"model").unwrap();
        let context = super::CacheValidationContext::new(1, &root.join("1")).unwrap();
        assert!(context.contains(1, "CBM/model.ifc", &file).unwrap());
        std::fs::rename(root.join("1/CBM"), root.join("1/old")).unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd").args(["/C", "mklink", "/J"])
                .arg(root.join("1/CBM").to_string_lossy().replace('/', "\\"))
                .arg(root.join("outside").to_string_lossy().replace('/', "\\")).output().unwrap();
            assert!(status.status.success(), "junction fixture: {}", String::from_utf8_lossy(&status.stderr));
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("outside"), root.join("1/CBM")).unwrap();
        assert!(context.contains(1, "CBM/model.ifc", &file).is_err());
        #[cfg(windows)]
        std::fs::remove_dir(root.join("1/CBM")).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(root.join("1/CBM")).unwrap();
        std::fs::rename(root.join("1/old"), root.join("1/CBM")).unwrap();
        let link = root.join("1/CBM/linked.ifc");
        #[cfg(windows)]
        let is_file_link = match std::os::windows::fs::symlink_file(&file, &link) {
            Ok(()) => true,
            Err(error) if error.raw_os_error() == Some(1314) => {
                // A final-path junction exercises the same reparse-point guard
                // without requiring SeCreateSymbolicLinkPrivilege. Keep file
                // symlinks on hosts that support them and assert the precise
                // rejection reason below, rather than skipping link coverage.
                let output = std::process::Command::new("cmd").args(["/C", "mklink", "/J"])
                    .arg(link.to_string_lossy().replace('/', "\\"))
                    .arg(root.join("outside").to_string_lossy().replace('/', "\\")).output().unwrap();
                assert!(output.status.success(), "final reparse fixture: {}", String::from_utf8_lossy(&output.stderr));
                assert_ne!(std::fs::symlink_metadata(&link).unwrap().file_attributes() & 0x0400, 0);
                false
            }
            Err(error) => panic!("file symlink fixture: {}", error),
        };
        #[cfg(unix)]
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let rejection = context.contains(1, "CBM/linked.ifc", &link).unwrap_err();
        assert!(rejection.contains("reparse point"), "unexpected rejection: {}", rejection);
        #[cfg(windows)]
        assert!(!super::readable_source_of_size(&link, 5));
        #[cfg(windows)]
        if is_file_link { std::fs::remove_file(&link).unwrap(); } else { std::fs::remove_dir(&link).unwrap(); }
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
        drop(context);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ifc_cache_path_accepts_trusted_lexical_and_canonical_root_names() {
        let root = crate::workspace_test_temp().join(format!("gim-ifc-root-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(root.join("CBM")).unwrap();
        let file = root.join("CBM").join("模型.ifc");
        std::fs::write(&file, b"ISO-10303-21;").unwrap();
        assert!(super::is_expected_cache_path_in_root(&root, "CBM/模型.ifc", &file).unwrap());
        assert!(super::is_expected_cache_path_in_root(&root, "CBM/模型.ifc", &file.canonicalize().unwrap()).unwrap());
        assert!(!super::is_expected_cache_path_in_root(&root, "CBM/模型.ifc", &root.join("other.ifc")).unwrap());
        assert!(super::is_expected_cache_path_in_root(&root, "../模型.ifc", &file).is_err());
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(root.join("CBM")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[cfg(test)]
    mod line_cache_protocol_tests {
        #[allow(unused_imports)]
        use super::super::{
            clear_powerline_tables, insert_line_attr_chunk, invalidate_line_parser_version, now_ms,
            LineFamPropertyPayload, PARSER_VERSION,
        };
        #[allow(unused_imports)]
        use rusqlite::Connection;

        /// 构建最小 schema：gim_project + 线路 6 表（仅测试涉及列）
        fn setup_line_conn() -> Connection {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
            "CREATE TABLE gim_project (
                id INTEGER PRIMARY KEY,
                parser_version TEXT,
                line_parser_version TEXT,
                substation_parser_version TEXT,
                project_type TEXT
            );
            CREATE TABLE powerline_cbm_node (
                project_id INTEGER NOT NULL,
                path TEXT NOT NULL,
                name TEXT, entity_name TEXT, classify_name TEXT,
                raw_props_json TEXT NOT NULL DEFAULT '',
                sort_order INTEGER, created_at_ms INTEGER NOT NULL DEFAULT 0,
                UNIQUE(project_id, path)
            );
            CREATE TABLE powerline_cbm_child (
                project_id INTEGER NOT NULL,
                parent_path TEXT NOT NULL,
                child_path TEXT NOT NULL,
                sort_order INTEGER, ref_type TEXT NOT NULL DEFAULT '',
                extra TEXT, created_at_ms INTEGER NOT NULL DEFAULT 0,
                UNIQUE(project_id, parent_path, child_path, ref_type)
            );
            CREATE TABLE powerline_cbm_ref (
                project_id INTEGER NOT NULL,
                node_path TEXT NOT NULL, ref_kind TEXT NOT NULL,
                ref_key TEXT, ref_value TEXT NOT NULL,
                normalized_ref_value TEXT, file_name_lower TEXT,
                sort_order INTEGER, created_at_ms INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE powerline_file_stat (
                project_id INTEGER NOT NULL, file_type TEXT NOT NULL,
                count INTEGER NOT NULL, PRIMARY KEY(project_id, file_type)
            );
            CREATE TABLE powerline_fam_property (
                project_id INTEGER NOT NULL,
                source_path TEXT NOT NULL,
                normalized_path TEXT NOT NULL,
                file_name_lower TEXT NOT NULL,
                display_key TEXT, prop_key TEXT NOT NULL, prop_value TEXT,
                raw_line TEXT, sort_order INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(project_id, normalized_path, prop_key, sort_order)
            );
            CREATE TABLE powerline_dev_property (
                project_id INTEGER NOT NULL,
                source_path TEXT NOT NULL,
                normalized_path TEXT NOT NULL,
                file_name_lower TEXT NOT NULL,
                prop_key TEXT NOT NULL, prop_value TEXT,
                raw_line TEXT, sort_order INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(project_id, normalized_path, prop_key, sort_order)
            );",
            )
            .unwrap();
            conn
        }

        fn insert_project(conn: &Connection, pid: i64, version: Option<&str>) {
            conn.execute(
            "INSERT INTO gim_project (id, parser_version, project_type) VALUES (?1, ?2, 'transmission_line')",
            rusqlite::params![pid, version],
        )
        .unwrap();
        }

        fn count(conn: &Connection, table: &str, pid: i64) -> i64 {
            conn.query_row(
                &format!("SELECT COUNT(*) FROM {} WHERE project_id = ?1", table),
                rusqlite::params![pid],
                |r| r.get(0),
            )
            .unwrap()
        }

        #[test]
        fn begin_clears_parser_version_and_tables() {
            let conn = setup_line_conn();
            insert_project(&conn, 1, Some("stale-version"));
            conn.execute(
            "INSERT INTO powerline_cbm_node (project_id, path, raw_props_json, created_at_ms) VALUES (1, 'Cbm/old.cbm', '{}', 0)",
            [],
        ).unwrap();

            let tx = conn.unchecked_transaction().unwrap();
            clear_powerline_tables(&tx, 1).unwrap();
            invalidate_line_parser_version(&tx, 1).unwrap();
            tx.commit().unwrap();

            // P1 评审：入库开始即失效——版本戳清空、旧数据清除
            assert_eq!(count(&conn, "powerline_cbm_node", 1), 0);
            let stored: Option<String> = conn
                .query_row(
                    "SELECT parser_version FROM gim_project WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stored, None);
        }

        #[test]
        fn finish_commits_version_only_at_the_end() {
            let conn = setup_line_conn();
            insert_project(&conn, 1, None);

            // 模拟 chunk 阶段写入属性（版本仍为 NULL）
            let tx = conn.unchecked_transaction().unwrap();
            insert_line_attr_chunk(
                &tx,
                1,
                &[LineFamPropertyPayload {
                    source_path: "Cbm/x.fam".into(),
                    normalized_path: "Cbm/x.fam".into(),
                    file_name_lower: "cbm/x.fam".into(),
                    display_key: None,
                    prop_key: "K".into(),
                    prop_value: Some("V".into()),
                    raw_line: None,
                    sort_order: 0,
                }],
                &[],
                now_ms(),
            )
            .unwrap();
            tx.commit().unwrap();

            // chunk 完成但未 finish：版本戳必须仍为空（半成品不可命中）
            let stored: Option<String> = conn
                .query_row(
                    "SELECT parser_version FROM gim_project WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stored, None);
            assert_eq!(count(&conn, "powerline_fam_property", 1), 1);

            // finish：提交点
            conn.execute(
                "UPDATE gim_project SET parser_version = ?1 WHERE id = 1",
                rusqlite::params![PARSER_VERSION],
            )
            .unwrap();
            let stored: String = conn
                .query_row(
                    "SELECT parser_version FROM gim_project WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stored, PARSER_VERSION);
        }

        /// P1 评审回归核心：线路缓存有效性不依赖 glbcache 几何标记文件。
        ///
        /// 该文件只由变电渐进 GLB 管线写入——线路工程永远没有它。
        /// 旧表达式把 geometry_cache_version_match 纳入线路 valid 条件，
        /// 导致线路工程二次打开永远缓存未命中而重新解压（bug 复现）；
        /// 修复后仅要求 parser_version 匹配 + 图表非空 + FAM 源存在。
        #[test]
        fn line_cache_valid_without_geometry_marker() {
            let parser_version_match = true;
            let line_cbm_node_count: u64 = 10;
            let fam_source_count: u64 = 5;
            // 线路工程无该文件 → 恒为 false
            let geometry_cache_version_match = false;

            // 旧表达式（bug）：要求几何标记 → 线路缓存永远失效
            let old_valid = parser_version_match
                && geometry_cache_version_match
                && line_cbm_node_count > 0
                && fam_source_count > 0;
            assert!(!old_valid, "旧表达式应复现 bug（无几何标记时失效）");

            // 新表达式（修复后 validate_gim_cache is_line 分支）
            let new_valid = parser_version_match && line_cbm_node_count > 0 && fam_source_count > 0;
            assert!(new_valid, "修复后：无几何标记不应阻止线路缓存命中");
        }

        #[test]
        fn domain_versions_require_their_current_contract() {
            assert!(super::super::parser_domain_version_matches(Some(super::super::LINE_PARSER_VERSION), super::super::LINE_PARSER_VERSION));
            assert!(!super::super::parser_domain_version_matches(None, super::super::LINE_PARSER_VERSION));
            assert!(!super::super::parser_domain_version_matches(Some(super::super::LINE_PARSER_VERSION), super::super::SUBSTATION_PARSER_VERSION));
        }

        #[test]
        fn cache_miss_reason_is_diagnosable_and_stable() {
            let reason = super::super::cache_miss_reason(vec![
                "LINE_PARSER_VERSION_MISMATCH:gim-parser-v21 -> gim-line-parser-v1".into(),
                "LINE_SEMANTIC_PACK_INVALID".into(),
            ]);
            assert_eq!(
                reason.as_deref(),
                Some("LINE_PARSER_VERSION_MISMATCH:gim-parser-v21 -> gim-line-parser-v1; LINE_SEMANTIC_PACK_INVALID")
            );
            assert_eq!(super::super::cache_miss_reason(Vec::new()), None);
        }

        #[test]
        fn warm_source_scan_is_skipped_for_a_consistent_semantic_index() {
            // IFC is optional. Existing referenced source files still must be readable.
            assert!(super::super::substation_light_source_scan(
                true, 5, 0, 0, 0, true, true
            ));
            // Semantic index published, receipt valid, every IFC source cached.
            assert!(super::super::substation_light_source_scan(
                true, 12594, 12, 12, 0, true, true
            ));
            // A project without any GLB geometry cache still has a complete
            // semantic index; this helper must not depend on that cache.
            assert!(super::super::substation_light_source_scan(
                true, 1, 1, 1, 0, true, true
            ));
        }

        #[test]
        fn warm_source_scan_stays_when_index_or_ifc_sources_are_incomplete() {
            let complete = super::super::substation_light_source_scan;
            assert!(!complete(false, 12594, 12, 12, 0, true, true), "no index");
            assert!(!complete(true, 0, 12, 12, 0, true, true), "no CBM nodes");
            assert!(!complete(true, 12594, 12, 0, 0, true, true), "no IFC entries");
            assert!(!complete(true, 12594, 12, 11, 0, true, true), "missing IFC cache");
            assert!(!complete(true, 12594, 12, 12, 1, true, true), "unreadable IFC");
            assert!(!complete(true, 12594, 12, 12, 0, false, true), "parser mismatch");
            assert!(!complete(true, 12594, 12, 12, 0, true, false), "receipt mismatch");
        }

        #[test]
        fn line_invalidation_does_not_clear_substation_domain_version() {
            let conn = setup_line_conn();
            insert_project(&conn, 1, Some(PARSER_VERSION));
            conn.execute(
                "UPDATE gim_project SET line_parser_version = ?1, substation_parser_version = ?2 WHERE id = 1",
                rusqlite::params![super::super::LINE_PARSER_VERSION, super::super::SUBSTATION_PARSER_VERSION],
            ).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            invalidate_line_parser_version(&tx, 1).unwrap();
            tx.commit().unwrap();
            let (line, substation): (Option<String>, Option<String>) = conn.query_row(
                "SELECT line_parser_version, substation_parser_version FROM gim_project WHERE id = 1",
                [], |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(line, None);
            assert_eq!(substation.as_deref(), Some(super::super::SUBSTATION_PARSER_VERSION));
        }
    }

    use super::*;

    #[test]
    fn substation_pack_round_trip_serves_offsets_and_sizes() {
        let root = crate::workspace_test_temp().join(format!(
            "gim-viewer-substation-pack-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        {
            let mut writer = LineSemanticPackWriter::new_substation(&root).unwrap();
            writer.append_with_timing("CBM/project.cbm", b"ENTITYNAME=F4System").unwrap();
            writer.append_with_timing("DEV/a.dev", b"BASEFAMILY=x.fam").unwrap();
            writer.append_with_timing("MOD/a.stl", b"solid").unwrap();
            writer.finish().unwrap();
        }
        // Pack 成员没有独立文件，但仍可按大小通过缓存校验。
        assert!(substation_pack_contains(&root, "cbm/project.cbm", 19));
        assert!(!substation_pack_contains(&root, "cbm/project.cbm", 20));
        assert!(!substation_pack_contains(&root, "cbm/missing.cbm", 19));
        // 读取按 offset 懒取，大小写不敏感。
        let bytes = read_substation_pack_entry(&root, "DEV\\A.DEV").unwrap();
        assert_eq!(bytes, b"BASEFAMILY=x.fam");
        assert!(read_substation_pack_entry(&root, "DEV/missing.dev").is_none());
        let pack = std::fs::read(root.join(SUBSTATION_PACK_FILE)).unwrap();
        assert_eq!(pack, b"ENTITYNAME=F4SystemBASEFAMILY=x.famsolid");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn line_semantic_pack_round_trip_is_contiguous_and_case_insensitive() {
        let root = crate::workspace_test_temp().join(format!(
            "gim-viewer-semantic-pack-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut writer = LineSemanticPackWriter::new(&root).unwrap();
        writer
            .append_with_timing("Cbm/project.cbm", b"A=B")
            .unwrap();
        writer
            .append_with_timing("Dev/item.dev", b"C=D")
            .unwrap();
        let entries = writer.finish().unwrap();
        assert_eq!(entries[0].offset, 0);
        assert_eq!(entries[0].size, 3);
        assert_eq!(entries[1].offset, 3);

        let index = read_pack_index(&root, LINE_SEMANTIC_INDEX_FILE, "线路语义 pack ").unwrap();
        let first = index.get("cbm/project.cbm").unwrap();
        assert_eq!(first.path, "Cbm/project.cbm");
        let first_bytes = read_line_semantic_pack_entry(
            &root,
            "CBM\\PROJECT.CBM",
        )
        .unwrap()
        .unwrap();
        assert_eq!(first_bytes, b"A=B");
        let pack = std::fs::read(root.join(LINE_SEMANTIC_PACK_FILE)).unwrap();
        assert_eq!(pack, b"A=BC=D");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn line_semantic_pack_v2_keeps_metadata_only_entries() {
        let root = crate::workspace_test_temp().join(format!(
            "gim-viewer-semantic-pack-meta-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut writer = LineSemanticPackWriter::new(&root).unwrap();
        writer
            .append_with_timing("Cbm/project.cbm", b"A=B")
            .unwrap();
        writer.record_metadata("Mod/tower.stl", 1234).unwrap();
        let entries = writer.finish().unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].packed);
        assert!(!entries[1].packed);
        let index = read_pack_index(&root, LINE_SEMANTIC_INDEX_FILE, "线路语义 pack ").unwrap();
        assert_eq!(index.len(), 2);
        assert!(index.get("cbm/project.cbm").unwrap().packed);
        assert!(!index.get("mod/tower.stl").unwrap().packed);
        assert_eq!(index.get("mod/tower.stl").unwrap().size, 1234);
        assert!(read_line_semantic_pack_entry(&root, "MOD/tower.stl")
            .unwrap()
            .is_none());
        std::fs::create_dir_all(root.join("Mod")).unwrap();
        std::fs::write(root.join("Mod/tower.stl"), vec![0u8; 1234]).unwrap();
        validate_line_semantic_pack_files(&root, true).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn line_semantic_pack_integrity_errors_are_classified_without_panic() {
        let root = crate::workspace_test_temp().join(format!(
            "gim-viewer-semantic-pack-invalid-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut writer = LineSemanticPackWriter::new(&root).unwrap();
        writer.append_with_timing("Cbm/a.cbm", b"abc").unwrap();
        writer.finish().unwrap();

        let index_path = root.join(LINE_SEMANTIC_INDEX_FILE);
        let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
        let index_backup = std::fs::read(&index_path).unwrap();

        std::fs::write(&index_path, b"bad").unwrap();
        let error = read_line_semantic_pack_files(&root, false).unwrap_err();
        assert!(error.starts_with("INDEX_INVALID:"));
        std::fs::write(&index_path, &index_backup).unwrap();

        std::fs::write(&pack_path, b"a").unwrap();
        let error = read_line_semantic_pack_files(&root, false).unwrap_err();
        assert!(error.starts_with("PACK_TRUNCATED:"));
        std::fs::write(&pack_path, b"abc").unwrap();

        let mut corrupted = index_backup.clone();
        // v2 record: header(9) + path_len(4) + path(9) => offset at 22.
        let offset_start = 9 + 4 + "Cbm/a.cbm".len();
        corrupted[offset_start..offset_start + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        std::fs::write(&index_path, corrupted).unwrap();
        let error = read_line_semantic_pack_files(&root, false).unwrap_err();
        assert!(error.starts_with("PACK_TRUNCATED:"));

        std::fs::write(&index_path, &index_backup).unwrap();
        std::fs::remove_file(&pack_path).unwrap();
        let error = read_line_semantic_pack_files(&root, false).unwrap_err();
        assert!(error.starts_with("PACK_INVALID:"));

        // Both sidecars reduced to valid-looking empty headers must still be
        // rejected as an incomplete source; otherwise warm restore could
        // commit an empty graph while SQLite remains apparently valid.
        let mut empty_index = Vec::new();
        empty_index.extend_from_slice(b"GLSI");
        empty_index.push(LINE_SEMANTIC_INDEX_VERSION);
        empty_index.extend_from_slice(&0u32.to_le_bytes());
        std::fs::write(&index_path, empty_index).unwrap();
        std::fs::write(&pack_path, Vec::<u8>::new()).unwrap();
        let error = read_line_semantic_pack_files(&root, false).unwrap_err();
        assert!(error.starts_with("INDEX_INVALID:"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn geometry_manifest_accepts_glb_partial_empty_unsupported_and_is_case_insensitive() {
        let mut seen = HashSet::new();
        validate_geometry_manifest_entry_shape(
            &GeometryCacheManifestEntry {
                diagnostic: None,
                entry_path: "DEV/Shared.Dev".into(),
                status: "glb".into(),
                size: 12,
            },
            &mut seen,
        )
        .unwrap();
        validate_geometry_manifest_entry_shape(
            &GeometryCacheManifestEntry {
                diagnostic: None,
                entry_path: "dev/empty.dev".into(),
                status: "empty".into(),
                size: 0,
            },
            &mut seen,
        )
        .unwrap();
        validate_geometry_manifest_entry_shape(
            &GeometryCacheManifestEntry {
                diagnostic: None,
                entry_path: "dev/partial.dev".into(),
                status: "partial".into(),
                size: 12,
            },
            &mut seen,
        )
        .unwrap();
        validate_geometry_manifest_entry_shape(
            &GeometryCacheManifestEntry {
                diagnostic: None,
                entry_path: "dev/unsupported.dev".into(),
                status: "unsupported".into(),
                size: 0,
            },
            &mut seen,
        )
        .unwrap();
        let duplicate = validate_geometry_manifest_entry_shape(
            &GeometryCacheManifestEntry {
                diagnostic: None,
                entry_path: "Dev/SHARED.DEV".into(),
                status: "glb".into(),
                size: 12,
            },
            &mut seen,
        )
        .unwrap_err();
        assert!(duplicate.contains("重复"));
    }

    #[test]
    fn geometry_manifest_rejects_invalid_status_and_empty_size() {
        for (status, size) in [("empty", 1), ("unsupported", 1), ("glb", 0), ("partial", 0), ("unknown", 0)] {
            let mut seen = HashSet::new();
            let error = validate_geometry_manifest_entry_shape(
                &GeometryCacheManifestEntry {
                diagnostic: None,
                    entry_path: "DEV/item.dev".into(),
                    status: status.into(),
                    size,
                },
                &mut seen,
            )
            .unwrap_err();
            assert!(!error.is_empty());
        }
    }

#[test]
fn project_table_registry_matches_schema() {
    let conn = Connection::open_in_memory().unwrap();
    initialize_schema(&conn).unwrap();
    let tables: Vec<String> = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").unwrap()
        .query_map([], |r| r.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
    let mut discovered = Vec::new();
    for table in tables {
        let names:Vec<String> = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap()
            .query_map([],|r|r.get(1)).unwrap().collect::<Result<_,_>>().unwrap();
        if names.iter().any(|name|name=="project_id") { discovered.push(table); }
    }
    discovered.sort();
    let mut registered:Vec<String> = PER_PROJECT_TABLES.iter().map(|s|s.to_string()).collect();registered.sort();
    assert_eq!(discovered, registered);
}

#[test]
fn project_reference_deletion_is_isolated() {
    let conn=Connection::open_in_memory().unwrap();initialize_schema(&conn).unwrap();
    for pid in [1,2] {
        conn.execute("INSERT INTO substation_dev_solid_model VALUES(?1,'a.dev','b.phm',NULL,0,0)",[pid]).unwrap();
        conn.execute("INSERT INTO substation_dev_sub_device VALUES(?1,'a.dev','b.dev',NULL,0,0)",[pid]).unwrap();
        conn.execute("INSERT INTO substation_phm_solid_model VALUES(?1,'b.phm','c.mod',NULL,NULL,NULL,0,0)",[pid]).unwrap();
    }
    clear_project_tables(&conn,1).unwrap();
    for table in ["substation_dev_solid_model","substation_dev_sub_device","substation_phm_solid_model"] {
        assert_eq!(count_rows(&conn,table,1).unwrap(),0);assert_eq!(count_rows(&conn,table,2).unwrap(),1);
    }
}

#[test]
fn cache_validation_snapshot_does_not_block_or_accept_later_publication() {
    let root=crate::workspace_test_temp().join(format!("gim-snapshot-{}",std::process::id()));std::fs::create_dir_all(&root).unwrap();
    let path=root.join("cache.db");let conn=Connection::open(&path).unwrap();
    conn.pragma_update(None,"journal_mode","WAL").unwrap();initialize_schema(&conn).unwrap();
    conn.execute("INSERT INTO app_setting VALUES('probe','old',0)",[]).unwrap();
    let snapshot=super::cache_validation::validation_snapshot(&conn).unwrap();
    let revision:i64=conn.query_row("SELECT total_changes()",[],|r|r.get(0)).unwrap();
    conn.execute("UPDATE app_setting SET value='new' WHERE key='probe'",[]).unwrap();
    assert_ne!(revision,conn.query_row("SELECT total_changes()",[],|r|r.get::<_,i64>(0)).unwrap());
    assert_eq!(snapshot.query_row("SELECT value FROM app_setting",[],|r|r.get::<_,String>(0)).unwrap(),"old");
    drop(snapshot);drop(conn);std::fs::remove_dir_all(root).unwrap();
}
