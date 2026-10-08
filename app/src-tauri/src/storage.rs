use gim_native_core::{extract_from_path_with_quota, ExtractionQuota};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::{SystemTime, UNIX_EPOCH}};

pub const PARSER: &str = "mobile-powerline-v2";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta { pub id: String, pub name: String, pub sha256: String, pub size: u64, pub imported_at: u64, pub last_opened_at: u64, pub parser_version: String, pub counts: serde_json::Value }
#[derive(Serialize, Deserialize)]
pub struct ImportFile { pub path: String, pub name: String, pub sha256: String, pub size: u64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared { pub meta: ProjectMeta, pub duplicate: bool, pub cache: Option<serde_json::Value> }
#[derive(Serialize)]
pub struct TextEntry { pub path: String, pub text: String }
fn error<E: std::fmt::Display>(e: E) -> String { e.to_string() }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
pub fn validate_id(id: &str) -> Result<(), String> { if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) { Ok(()) } else { Err("无效工程 ID".into()) } }
pub fn dir(root: &Path, id: &str) -> Result<PathBuf, String> { validate_id(id)?; Ok(root.join("projects").join(id)) }
fn database(root: &Path, id: &str) -> Result<Connection, String> {
    let path = dir(root, id)?.join("cache/project.sqlite");
    if !path.is_file() { return Err("工程缓存不存在".into()); }
    Connection::open(path).map_err(error)
}
pub fn read_meta(root: &Path, id: &str) -> Result<ProjectMeta, String> { serde_json::from_slice(&fs::read(dir(root, id)?.join("metadata.json")).map_err(error)?).map_err(error) }
fn write_meta(path: &Path, meta: &ProjectMeta) -> Result<(), String> {
    let temp = path.join("metadata.pending"); fs::write(&temp, serde_json::to_vec(meta).map_err(error)?).map_err(error)?;
    let target = path.join("metadata.json");
    // Android rename replaces atomically. On Windows the destination must first be removed.
    #[cfg(target_os = "windows")]
    if target.exists() { fs::remove_file(&target).map_err(error)?; }
    fs::rename(temp, target).map_err(error)
}
pub fn list(root: &Path) -> Vec<ProjectMeta> {
    let mut result = vec![];
    if let Ok(entries) = fs::read_dir(root.join("projects")) { for entry in entries.flatten() { let id = entry.file_name().to_string_lossy().into_owned(); if let Ok(meta) = read_meta(root, &id) { result.push(meta); } } }
    result.sort_by_key(|m| std::cmp::Reverse(m.last_opened_at)); result
}
pub fn source(root: &Path, id: &str, path: &str) -> Result<String, String> {
    if path.len() > 4096 || !["cbm", "fam", "dev", "phm", "mod"].contains(&path.rsplit('.').next().unwrap_or("").to_lowercase().as_str()) { return Err("只允许查看业务对象关联的文本来源".into()); }
    database(root, id)?.query_row("SELECT text FROM entries WHERE key=?1", [path.replace('\\', "/").to_lowercase()], |r| r.get(0)).map_err(error)
}
fn stored_text_entries(root: &Path, id: &str) -> Result<Vec<TextEntry>, String> {
    let db = database(root, id)?;
    let mut statement = db.prepare("SELECT path,text FROM entries ORDER BY rowid").map_err(error)?;
    let rows = statement.query_map([], |r| Ok(TextEntry { path: r.get(0)?, text: r.get(1)? })).map_err(error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(error)
}
pub fn text_entries(root: &Path, id: &str) -> Result<Vec<TextEntry>, String> {
    match stored_text_entries(root, id) { Ok(v) if !v.is_empty() => Ok(v), _ => { rebuild_entries(root, id)?; stored_text_entries(root, id) } }
}
fn rebuild_entries(root: &Path, id: &str) -> Result<(), String> {
    let project = dir(root, id)?; let meta = read_meta(root, id)?; let source = project.join("source/original.gim");
    let mut file = fs::File::open(&source).map_err(error)?;
    if file.metadata().map_err(error)?.len() != meta.size || meta.sha256 != id { return Err("私有源包身份不匹配，不能重建缓存".into()); }
    let mut hash = Sha256::new(); let mut buffer = [0u8; 256*1024];
    loop { let n = file.read(&mut buffer).map_err(error)?; if n == 0 { break; } hash.update(&buffer[..n]); }
    if format!("{:x}", hash.finalize()) != id { return Err("私有源包 SHA 校验失败，不能重建缓存".into()); }
    drop(file);
    let pending = project.join("cache/project.rebuilding.sqlite"); if pending.exists() { fs::remove_file(&pending).map_err(error)?; }
    let result = (|| {
        let mut db = Connection::open(&pending).map_err(error)?;
        db.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE entries(key TEXT PRIMARY KEY,path TEXT NOT NULL,text TEXT NOT NULL); CREATE TABLE semantics(parser TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE previews(key TEXT PRIMARY KEY,json TEXT NOT NULL);").map_err(error)?;
        let tx = db.transaction().map_err(error)?;
        let quota = ExtractionQuota { max_archive_bytes: 256*1024*1024, max_entries: 100000, max_file_bytes: 64*1024*1024, max_total_uncompressed_bytes: 512*1024*1024, max_compression_ratio: 200 };
        let decoded = extract_from_path_with_quota(&source, &quota, |path, bytes| {
            if ["cbm","fam","dev","phm","mod"].contains(&path.rsplit('.').next().unwrap_or("").to_lowercase().as_str()) {
                let text = String::from_utf8(bytes).map_err(|_| format!("文本编码无效: {}", path))?;
                tx.execute("INSERT INTO entries(key,path,text) VALUES(?1,?2,?3)",params![path.replace('\\',"/").to_lowercase(),path,text.trim_start_matches('\u{feff}')]).map_err(error)?;
            }
            Ok(())
        })?;
        if decoded.magic != "GIMPKGT" { return Err("私有源包类型错误".into()); }
        tx.commit().map_err(error)?; drop(db);
        let target = project.join("cache/project.sqlite");
        #[cfg(target_os = "windows")]
        if target.exists() { fs::remove_file(&target).map_err(error)?; }
        fs::rename(&pending, target).map_err(error)
    })();
    if pending.exists() { let _ = fs::remove_file(&pending); }
    result
}
pub fn cached(root: &Path, id: &str) -> Result<Option<serde_json::Value>, String> {
    Ok(checked_cache(root,id)?.map(|(value,_)| value))
}
pub fn cached_json(root: &Path, id: &str) -> Result<Option<String>, String> {
    Ok(checked_cache(root,id)?.map(|(_,json)| json))
}
fn checked_cache(root: &Path, id: &str) -> Result<Option<(serde_json::Value,String)>, String> {
    if read_meta(root,id)?.parser_version != PARSER { return Ok(None); }
    let db = database(root, id)?;
    // Warm open checks the semantic table; text pages are read only when their sources are needed.
    let check: String = db.query_row("PRAGMA quick_check(semantics)", [], |r| r.get(0)).map_err(error)?;
    if check != "ok" { return Ok(None); }
    let mut q = db.prepare("SELECT json FROM semantics WHERE parser=?1").map_err(error)?;
    let mut rows = q.query([PARSER]).map_err(error)?;
    if let Some(row) = rows.next().map_err(error)? {
        let text: String = row.get(0).map_err(error)?; let payload: serde_json::Value = serde_json::from_str(&text).map_err(error)?;
        let meta = read_meta(root, id)?;
        if payload["id"] != id || payload["sourceSha256"] != meta.sha256 || payload["sourceSize"] != meta.size || payload["parserVersion"] != PARSER { return Ok(None); }
        if !payload["objects"].is_array() || !payload["rawWires"].is_array() || !payload["tree"]["children"].is_array() { return Ok(None); }
        let objects = payload["objects"].as_array().unwrap();
        let mut ids = std::collections::HashSet::new(); let mut counts = serde_json::Map::new();
        for kind in ["project","line","strain","tower","span","cross"] { counts.insert(kind.into(),serde_json::json!(objects.iter().filter(|o| o["kind"] == kind).count())); }
        if objects.is_empty() || objects.iter().any(|o| o["id"].as_str().map(|id| !ids.insert(id)).unwrap_or(true)) || payload["counts"] != serde_json::Value::Object(counts) || !ids.contains(payload["tree"]["objectId"].as_str().unwrap_or("")) { return Ok(None); }
        Ok(Some((payload,text)))
    } else { Ok(None) }
}
pub fn touch(root: &Path, id: &str) -> Result<(), String> { let mut m = read_meta(root, id)?; m.last_opened_at = now(); write_meta(&dir(root, id)?, &m) }
pub fn delete(root: &Path, id: &str) -> Result<(), String> { let d = dir(root, id)?; if d.exists() { fs::remove_dir_all(d).map_err(error)?; } Ok(()) }
pub fn clean_imports(root: &Path) -> Result<(), String> {
    let staging = root.join("projects/.imports"); if staging.exists() { fs::remove_dir_all(&staging).map_err(error)?; } fs::create_dir_all(staging).map_err(error)?;
    for meta in list(root).into_iter().filter(|m| m.parser_version.is_empty()) { delete(root, &meta.id)?; }
    Ok(())
}
pub fn discard(root: &Path, input: &str) -> Result<(), String> {
    let imports = root.join("projects/.imports").canonicalize().map_err(error)?;
    let path = PathBuf::from(input);
    if !path.exists() { return Ok(()); }
    let path = path.canonicalize().map_err(error)?;
    let parent = path.parent().ok_or("缺少暂存目录")?;
    if path.file_name().and_then(|v| v.to_str()) != Some("original.gim") || parent.parent() != Some(imports.as_path()) { return Err("无效暂存文件".into()); }
    fs::remove_dir_all(parent).map_err(error)
}
pub fn prepare(root: &Path, input: ImportFile, cancelled: &AtomicBool, mut progress: impl FnMut(&str, u64, Option<u64>)) -> Result<Prepared, String> {
    let imports = root.join("projects/.imports").canonicalize().map_err(error)?;
    let input_path = PathBuf::from(&input.path).canonicalize().map_err(error)?;
    if !input_path.starts_with(&imports) || input_path.file_name().and_then(|s| s.to_str()) != Some("original.gim") { return Err("导入文件必须来自应用私有暂存目录".into()); }
    let staging = input_path.parent().ok_or("缺少暂存目录")?.to_path_buf();
    let result = (|| {
        let mut file = fs::File::open(&input_path).map_err(error)?;
        let size = file.metadata().map_err(error)?.len(); if size > 256 * 1024 * 1024 || size != input.size { return Err("文件大小不匹配或超过限额".into()); }
        let mut header = [0u8; 7]; file.read_exact(&mut header).map_err(error)?;
        if &header != b"GIMPKGT" { return Err("当前移动端只支持 GIMPKGT 输电线路工程".into()); }
        let mut digest = Sha256::new(); digest.update(header);
        let mut buffer = [0u8; 256 * 1024]; let mut done = 7u64;
        loop { if cancelled.load(Ordering::Relaxed) { return Err("导入已取消".into()); } let n = file.read(&mut buffer).map_err(error)?; if n == 0 { break; } digest.update(&buffer[..n]); done += n as u64; if done % (1024 * 1024) < buffer.len() as u64 { progress("识别工程与校验", done, Some(size)); } }
        let sha = format!("{:x}", digest.finalize()); if sha != input.sha256 { return Err("SHA 校验失败".into()); }
        drop(file);
        let project = dir(root, &sha)?;
        if project.exists() { let meta = read_meta(root, &sha)?; if meta.sha256 != sha || meta.size != size { return Err("现有工程身份不匹配".into()); } let cache = cached(root, &sha).unwrap_or(None); touch(root, &sha)?; return Ok(Prepared { meta, duplicate: true, cache }); }
        fs::create_dir_all(staging.join("source")).map_err(error)?;
        fs::create_dir_all(staging.join("cache/semantic")).map_err(error)?;
        fs::create_dir_all(staging.join("cache/previews")).map_err(error)?;
        let mut db = Connection::open(staging.join("cache/project.sqlite")).map_err(error)?;
        db.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE entries(key TEXT PRIMARY KEY,path TEXT NOT NULL,text TEXT NOT NULL); CREATE TABLE semantics(parser TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE previews(key TEXT PRIMARY KEY,json TEXT NOT NULL);").map_err(error)?;
        let tx = db.transaction().map_err(error)?; let mut count = 0u64;
        progress("解压归档", 0, None);
        let quota = ExtractionQuota { max_archive_bytes: 256*1024*1024, max_entries: 100000, max_file_bytes: 64*1024*1024, max_total_uncompressed_bytes: 512*1024*1024, max_compression_ratio: 200 };
        let metadata = extract_from_path_with_quota(&input_path, &quota, |path, bytes| {
            if cancelled.load(Ordering::Relaxed) { return Err("导入已取消".into()); }
            count += 1;
            if ["cbm", "fam", "dev", "phm", "mod"].contains(&path.rsplit('.').next().unwrap_or("").to_lowercase().as_str()) {
                let text = String::from_utf8(bytes).map_err(|_| format!("文本编码无效: {}", path))?;
                tx.execute("INSERT INTO entries(key,path,text) VALUES (?1,?2,?3)", params![path.to_lowercase(), path, text.trim_start_matches('\u{feff}')]).map_err(error)?;
            }
            if count % 200 == 0 { progress("解压归档", count, None); } Ok(())
        })?;
        tx.commit().map_err(error)?; drop(db);
        if metadata.magic != "GIMPKGT" { return Err("只支持线路工程".into()); }
        if cancelled.load(Ordering::Relaxed) { return Err("导入已取消".into()); }
        fs::rename(&input_path, staging.join("source/original.gim")).map_err(error)?;
        let name = metadata.project_name.filter(|n| !n.trim().is_empty()).unwrap_or(input.name.trim_end_matches(".gim").to_string());
        let meta = ProjectMeta { id: sha.clone(), name, sha256: sha, size, imported_at: now(), last_opened_at: now(), parser_version: String::new(), counts: serde_json::json!({}) };
        write_meta(&staging, &meta)?;
        fs::rename(&staging, &project).map_err(error)?;
        Ok(Prepared { meta, duplicate: false, cache: None })
    })();
    if staging.exists() { let _ = fs::remove_dir_all(staging); }
    result
}
#[cfg(test)]
pub fn commit(root: &Path, id: &str, payload: serde_json::Value) -> Result<(), String> {
    commit_json(root,id,serde_json::to_string(&payload).map_err(error)?)
}
pub fn commit_json(root: &Path, id: &str, json: String) -> Result<(), String> {
    if json.len() > 64*1024*1024 { return Err("语义缓存超过 64 MiB 限额".into()); }
    let payload: serde_json::Value = serde_json::from_str(&json).map_err(error)?;
    let mut meta = read_meta(root, id)?;
    if payload["id"] != id || payload["sourceSha256"] != meta.sha256 || payload["sourceSize"] != meta.size || payload["parserVersion"] != PARSER { return Err("缓存契约或源身份不匹配".into()); }
    let mut db = database(root, id)?; let tx = db.transaction().map_err(error)?;
    tx.execute("DELETE FROM semantics", []).map_err(error)?;
    tx.execute("INSERT INTO semantics(parser,json) VALUES(?1,?2)", params![PARSER, json]).map_err(error)?;
    tx.commit().map_err(error)?;
    meta.name = payload["name"].as_str().unwrap_or(&meta.name).to_string(); meta.parser_version = PARSER.into(); meta.counts = payload["counts"].clone(); write_meta(&dir(root, id)?, &meta)
}
pub fn preview(root: &Path, id: &str, key: &str, data: Option<serde_json::Value>) -> Result<Option<serde_json::Value>, String> {
    if key.len() > 8192 { return Err("无效预览键".into()); }
    let db = database(root, id)?;
    if let Some(v) = data { db.execute("INSERT OR REPLACE INTO previews(key,json) VALUES(?1,?2)", params![key, serde_json::to_string(&v).map_err(error)?]).map_err(error)?; return Ok(Some(v)); }
    let mut q = db.prepare("SELECT json FROM previews WHERE key=?1").map_err(error)?; let mut rows = q.query([key]).map_err(error)?;
    if let Some(row) = rows.next().map_err(error)? { let text: String = row.get(0).map_err(error)?; Ok(Some(serde_json::from_str(&text).map_err(error)?)) } else { Ok(None) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_payload(id: &str, size: u64, name: &str) -> serde_json::Value {
        serde_json::json!({"id":id,"sourceSha256":id,"sourceSize":size,"parserVersion":PARSER,"name":name,"objects":[{"id":"root","kind":"project"}],"rawWires":[],"tree":{"objectId":"root","children":[]},"counts":{"project":1,"line":0,"strain":0,"tower":0,"span":0,"cross":0}})
    }
    #[test] fn damaged_cache_rebuild_preserves_original_source_and_cleans_pending_database() {
        let root = std::env::temp_dir().join(format!("gim-repair-{}-{}", std::process::id(), now())); clean_imports(&root).unwrap();
        let mut archive = std::io::Cursor::new(Vec::new());
        { let mut zip = zip::ZipWriter::new(&mut archive); zip.start_file("Cbm/project.cbm",zip::write::SimpleFileOptions::default()).unwrap(); std::io::Write::write_all(&mut zip,b"ENTITYNAME=F1System").unwrap(); zip.finish().unwrap(); }
        let mut bytes = b"GIMPKGT".to_vec(); bytes.extend([0u8;32]); bytes.extend(archive.into_inner());
        let id = format!("{:x}", Sha256::digest(&bytes)); let stage = root.join("projects/.imports/repair"); fs::create_dir(&stage).unwrap(); let source = stage.join("original.gim"); fs::write(&source,&bytes).unwrap();
        prepare(&root,ImportFile { path:source.to_string_lossy().into(),name:"repair.gim".into(),sha256:id.clone(),size:bytes.len() as u64 },&AtomicBool::new(false),|_,_,_| {}).unwrap();
        commit(&root,&id,test_payload(&id,bytes.len() as u64,"repair")).unwrap();
        let p = dir(&root,&id).unwrap(); fs::write(p.join("cache/project.sqlite"),b"damaged").unwrap();
        assert!(cached(&root,&id).is_err()); let entries = text_entries(&root,&id).unwrap(); assert_eq!(entries.len(),1); assert!(entries[0].text.contains("F1System"));
        assert_eq!(fs::read(p.join("source/original.gim")).unwrap(),bytes); assert!(!p.join("cache/project.rebuilding.sqlite").exists()); assert!(cached(&root,&id).unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn project_ids_cannot_escape_private_root() { assert!(validate_id("../../outside").is_err()); assert!(validate_id(&"a".repeat(64)).is_ok()); assert!(validate_id(&"A".repeat(64)).is_err()); }
    #[test] fn cancellation_cleans_staging_and_discard_cannot_leave_import_scope() {
        let root = std::env::temp_dir().join(format!("gim-cancel-{}-{}", std::process::id(), now()));
        clean_imports(&root).unwrap(); let stage = root.join("projects/.imports/one"); fs::create_dir(&stage).unwrap();
        let bytes = b"GIMPKGTcancel-test"; let path = stage.join("original.gim"); fs::write(&path, bytes).unwrap();
        let input = ImportFile { path: path.to_string_lossy().into(), name: "test.gim".into(), size: bytes.len() as u64, sha256: format!("{:x}", Sha256::digest(bytes)) };
        let err = prepare(&root, input, &AtomicBool::new(true), |_,_,_| {}).err().unwrap();
        assert!(err.contains("取消")); assert!(!stage.exists()); assert!(list(&root).is_empty());
        let outside = root.join("original.gim"); fs::write(&outside, bytes).unwrap();
        assert!(discard(&root, &outside.to_string_lossy()).is_err()); assert!(outside.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn semantic_commit_checks_source_identity() {
        let root = std::env::temp_dir().join(format!("gim-mobile-test-{}", now())); let id = "b".repeat(64); let p = dir(&root, &id).unwrap(); fs::create_dir_all(p.join("cache")).unwrap();
        let m = ProjectMeta { id: id.clone(), name: "test".into(), sha256: id.clone(), size: 7, imported_at: 0, last_opened_at: 0, parser_version: String::new(), counts: serde_json::json!({}) }; write_meta(&p, &m).unwrap();
        let db = Connection::open(p.join("cache/project.sqlite")).unwrap(); db.execute_batch("CREATE TABLE semantics(parser TEXT PRIMARY KEY,json TEXT NOT NULL);").unwrap(); drop(db);
        let bad = serde_json::json!({"id":id,"sourceSha256":"wrong","sourceSize":7,"parserVersion":PARSER}); assert!(commit(&root, &id, bad).is_err()); assert!(cached(&root, &id).unwrap().is_none());
        let good = test_payload(&id, 7, "saved"); commit(&root, &id, good.clone()).unwrap(); assert_eq!(cached(&root, &id).unwrap(), Some(good.clone()));
        assert_eq!(serde_json::from_str::<serde_json::Value>(&cached_json(&root,&id).unwrap().unwrap()).unwrap(),good);
        delete(&root, &id).unwrap(); assert!(!p.exists()); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "Requires demo/line01.gim through line06.gim; run explicitly for the mobile release gate"]
    fn six_native_imports_deduplicate_and_remove_all_artifacts() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let root = repo.join("output/mobile-native-verification"); fs::create_dir_all(&root).unwrap(); clean_imports(&root).unwrap();
        for i in 1..=6 {
            let source = repo.join(format!("demo/line{:02}.gim", i)); assert!(source.is_file());
            let mut f = fs::File::open(&source).unwrap(); let mut hasher = Sha256::new(); let mut buffer = [0u8; 262144];
            loop { let n = f.read(&mut buffer).unwrap(); if n==0 {break} hasher.update(&buffer[..n]); }
            let sha = format!("{:x}", hasher.finalize()); let size = f.metadata().unwrap().len();
            let stage = root.join(format!("projects/.imports/test-{}",i)); fs::create_dir_all(&stage).unwrap(); fs::copy(&source,stage.join("original.gim")).unwrap();
            let input = ImportFile { path: stage.join("original.gim").to_string_lossy().into(), name: format!("line{:02}.gim",i), sha256:sha.clone(), size };
            let start = std::time::Instant::now(); let p = prepare(&root,input,&AtomicBool::new(false),|_,_,_|{}).unwrap(); assert!(!p.duplicate); assert!(cached(&root,&sha).unwrap().is_none());
            let entries=text_entries(&root,&sha).unwrap(); assert!(entries.iter().any(|e| e.path.to_lowercase().ends_with("project.cbm"))); assert!(entries.iter().all(|e| !e.path.to_lowercase().ends_with(".stl")));
            let payload=test_payload(&sha, size, "verified"); commit(&root,&sha,payload).unwrap();
            fs::create_dir_all(&stage).unwrap(); fs::copy(&source,stage.join("original.gim")).unwrap();
            let input=ImportFile { path:stage.join("original.gim").to_string_lossy().into(),name:"duplicate.gim".into(),sha256:sha.clone(),size };
            let dup=prepare(&root,input,&AtomicBool::new(false),|_,_,_|{}).unwrap(); assert!(dup.duplicate); assert!(dup.cache.is_some()); assert!(!stage.exists());
            println!("line{:02}: entries={} native_import_and_duplicate_ms={}",i,entries.len(),start.elapsed().as_millis());
            delete(&root,&sha).unwrap(); assert!(!dir(&root,&sha).unwrap().exists());
        }
    }
}
