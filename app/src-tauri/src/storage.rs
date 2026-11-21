pub use gim_native_core::{ProjectMeta, ImportFile, Prepared, TextEntry};
use gim_native_core::{NativeError, NativeErrorCode};
use gim_native_core::{extract_from_path_with_quota};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{fs, io::{ErrorKind, Read}, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::{SystemTime, UNIX_EPOCH}};
use std::{collections::HashMap,sync::{Mutex,OnceLock}};

#[derive(Clone,PartialEq,Eq)]
struct SourceStamp {
    length:u64,modified:Option<SystemTime>,created:Option<SystemTime>,
    #[cfg(unix)] device:u64,
    #[cfg(unix)] inode:u64,
}
fn source_stamp(metadata:&fs::Metadata)->SourceStamp {
    #[cfg(unix)] use std::os::unix::fs::MetadataExt;
    SourceStamp {length:metadata.len(),modified:metadata.modified().ok(),created:metadata.created().ok(),
        #[cfg(unix)] device:metadata.dev(),#[cfg(unix)] inode:metadata.ino()}
}
// A private source is immutable after import. Reuse its verified SHA only while
// filesystem identity is unchanged; a changed stamp must pass SHA validation again.
static SOURCE_PROOFS:OnceLock<Mutex<HashMap<PathBuf,SourceStamp>>>=OnceLock::new();
#[cfg(test)] static SOURCE_HASH_READS:OnceLock<Mutex<HashMap<PathBuf,u64>>>=OnceLock::new();

pub use gim_native_core::MOBILE_PARSER_VERSION as PARSER;




fn sqlite_error(error: rusqlite::Error) -> NativeError {
    use rusqlite::ErrorCode;
    let code = match &error {
        rusqlite::Error::SqliteFailure(failure, _) => match failure.code {
            ErrorCode::PermissionDenied | ErrorCode::ReadOnly => NativeErrorCode::Unauthorized,
            ErrorCode::SystemIoFailure | ErrorCode::DiskFull | ErrorCode::CannotOpen
            | ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => NativeErrorCode::Io,
            ErrorCode::OutOfMemory | ErrorCode::TooBig => NativeErrorCode::ResourceLimit,
            _ => NativeErrorCode::IndexInvalid,
        },
        _ => NativeErrorCode::IndexInvalid,
    };
    NativeError::new(code, error.to_string())
}
fn index_json_error(error: serde_json::Error) -> NativeError {
    NativeError::new(NativeErrorCode::IndexInvalid, error.to_string())
}
fn internal(error: impl std::fmt::Display) -> NativeError {
    NativeError::new(NativeErrorCode::Internal, error.to_string())
}
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
pub fn validate_id(id: &str) -> Result<(), NativeError> { if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) { Ok(()) } else { Err(NativeError::new(NativeErrorCode::InvalidInput, "无效工程 ID")) } }
pub fn dir(root: &Path, id: &str) -> Result<PathBuf, NativeError> { validate_id(id)?; Ok(root.join("projects").join(id)) }
fn database(root: &Path, id: &str) -> Result<Connection, NativeError> {
    let path = dir(root, id)?.join("cache/project.sqlite");
    if !path.is_file() { return Err(NativeError::new(NativeErrorCode::IndexInvalid, "工程缓存不存在")); }
    let db=Connection::open(path).map_err(sqlite_error)?;
    let version:i64=db.pragma_query_value(None,"user_version",|row|row.get(0)).map_err(sqlite_error)?;
    if version!=i64::from(gim_native_core::DATABASE_SCHEMA_VERSION) {
        return Err(NativeError::new(NativeErrorCode::SchemaUnsupported,"线路开发缓存 schema 不受支持，请删除开发缓存后重建"));
    }
    Ok(db)
}
fn initialize_cache_schema(db:&Connection)->Result<(),NativeError> {
    db.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE entries(key TEXT PRIMARY KEY,path TEXT NOT NULL,text TEXT NOT NULL); CREATE TABLE semantics(parser TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE previews(key TEXT PRIMARY KEY,json TEXT NOT NULL);").map_err(sqlite_error)?;
    db.pragma_update(None,"user_version",gim_native_core::DATABASE_SCHEMA_VERSION).map_err(sqlite_error)
}
pub fn read_meta(root: &Path, id: &str) -> Result<ProjectMeta, NativeError> { serde_json::from_slice(&fs::read(dir(root, id)?.join("metadata.json")).map_err(NativeError::from)?).map_err(index_json_error) }
pub fn validate_source(root: &Path, id: &str) -> Result<(), NativeError> {
    let meta = read_meta(root, id)?;
    let path=dir(root,id)?.join("source/original.gim");
    let mut file = fs::File::open(&path).map_err(NativeError::from)?;
    let before=source_stamp(&file.metadata().map_err(NativeError::from)?);
    if meta.id != id || meta.sha256 != id || before.length != meta.size { return Err(NativeError::new(NativeErrorCode::SourceChanged,"私有源包身份或大小不匹配")); }
    let proofs=SOURCE_PROOFS.get_or_init(||Mutex::new(HashMap::new()));
    {
        let mut verified=proofs.lock().map_err(internal)?;
        if before.modified.is_some()&&verified.get(&path)==Some(&before) {return Ok(());}
        verified.remove(&path);
    }
    #[cfg(test)] {let mut reads=SOURCE_HASH_READS.get_or_init(||Mutex::new(HashMap::new())).lock().unwrap();*reads.entry(path.clone()).or_default()+=1;}
    let mut header = [0u8; 7]; file.read_exact(&mut header).map_err(NativeError::from)?;
    if &header != b"GIMPKGT" { return Err(NativeError::new(NativeErrorCode::SourceChanged,"私有源包类型错误，不能使用线路缓存")); }
    let mut digest = Sha256::new(); digest.update(header); let mut buffer = [0u8; 256*1024];
    loop { let n = file.read(&mut buffer).map_err(NativeError::from)?; if n == 0 { break; } digest.update(&buffer[..n]); }
    if format!("{:x}", digest.finalize()) != id { return Err(NativeError::new(NativeErrorCode::SourceChanged,"私有源包 SHA 校验失败，不能使用缓存")); }
    if source_stamp(&file.metadata().map_err(NativeError::from)?)!=before || source_stamp(&fs::metadata(&path).map_err(NativeError::from)?)!=before {
        return Err(NativeError::new(NativeErrorCode::SourceChanged,"源包在身份验证期间已被替换"));
    }
    let mut verified=proofs.lock().map_err(internal)?;
    if verified.len()>=256 {if let Some(old)=verified.keys().next().cloned(){verified.remove(&old);}}
    if before.modified.is_some(){verified.insert(path,before);}
    Ok(())
}
/// Source identity is rechecked; only the bounded header, never the archive, crosses IPC.
pub fn header(root: &Path, id: &str) -> Result<Vec<u8>, NativeError> {
    validate_source(root, id)?;
    let file = fs::File::open(dir(root, id)?.join("source/original.gim")).map_err(NativeError::from)?;
    let mut bytes = Vec::new(); file.take(1024 * 1024 + 7).read_to_end(&mut bytes).map_err(NativeError::from)?;
    let end = (7..bytes.len()).find(|&i| bytes[i..].starts_with(&[0x37,0x7a,0xbc,0xaf,0x27,0x1c]) || bytes[i..].starts_with(&[0x50,0x4b,0x03,0x04])).ok_or_else(|| NativeError::new(NativeErrorCode::InputCorrupt, "头部搜索窗口内未找到压缩载荷"))?;
    bytes.truncate(end); Ok(bytes)
}
fn write_meta(path: &Path, meta: &ProjectMeta) -> Result<(), NativeError> {
    let temp = path.join("metadata.pending"); fs::write(&temp, serde_json::to_vec(meta).map_err(internal)?).map_err(NativeError::from)?;
    let target = path.join("metadata.json");
    // Android rename replaces atomically. On Windows the destination must first be removed.
    #[cfg(target_os = "windows")]
    if target.exists() { fs::remove_file(&target).map_err(NativeError::from)?; }
    fs::rename(temp, target).map_err(NativeError::from)
}
pub fn list(root: &Path) -> Vec<ProjectMeta> {
    let mut result = vec![];
    if let Ok(entries) = fs::read_dir(root.join("projects")) { for entry in entries.flatten() { let id = entry.file_name().to_string_lossy().into_owned(); if let Ok(meta) = read_meta(root, &id) { result.push(meta); } } }
    result.sort_by_key(|m| std::cmp::Reverse(m.last_opened_at)); result
}
pub fn source(root: &Path, id: &str, path: &str) -> Result<String, NativeError> {
    if path.len() > 4096 || !["cbm", "fam", "dev", "phm", "mod"].contains(&path.rsplit('.').next().unwrap_or("").to_lowercase().as_str()) { return Err(NativeError::new(NativeErrorCode::InvalidPath, "只允许查看业务对象关联的文本来源")); }
    validate_source(root,id)?;
    database(root, id)?.query_row("SELECT text FROM entries WHERE key=?1", [normalize_entry_key(path)], |r| r.get(0)).map_err(sqlite_error)
}
fn stored_text_entries(root: &Path, id: &str) -> Result<Vec<TextEntry>, NativeError> {
    let db = database(root, id)?;
    let mut statement = db.prepare("SELECT path,text FROM entries ORDER BY rowid").map_err(sqlite_error)?;
    let rows = statement.query_map([], |r| Ok(TextEntry { path: r.get(0)?, text: r.get(1)? })).map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}
pub fn text_entries(root: &Path, id: &str) -> Result<Vec<TextEntry>, NativeError> {
    validate_source(root, id)?;
    match stored_text_entries(root, id) {
        Ok(v) if !v.is_empty()=>Ok(v),
        Err(error) if error.code != NativeErrorCode::IndexInvalid => Err(error),
        _=>{rebuild_entries(root,id)?;stored_text_entries(root,id)}
    }
}
fn rebuild_entries(root: &Path, id: &str) -> Result<(), NativeError> {
    let project = dir(root, id)?; let meta = read_meta(root, id)?; let source = project.join("source/original.gim");
    let mut file = fs::File::open(&source).map_err(NativeError::from)?;
    if file.metadata().map_err(NativeError::from)?.len() != meta.size || meta.sha256 != id { return Err(NativeError::new(NativeErrorCode::SourceChanged,"私有源包身份不匹配，不能重建缓存")); }
    let mut hash = Sha256::new(); let mut buffer = [0u8; 256*1024];
    loop { let n = file.read(&mut buffer).map_err(NativeError::from)?; if n == 0 { break; } hash.update(&buffer[..n]); }
    if format!("{:x}", hash.finalize()) != id { return Err(NativeError::new(NativeErrorCode::SourceChanged,"私有源包 SHA 校验失败，不能重建缓存")); }
    drop(file);
    let pending = project.join("cache/project.rebuilding.sqlite"); if pending.exists() { fs::remove_file(&pending).map_err(NativeError::from)?; }
    let result = (|| {
        let mut db = Connection::open(&pending).map_err(sqlite_error)?;
        initialize_cache_schema(&db)?;
        let tx = db.transaction().map_err(sqlite_error)?;
        let quota = gim_native_core::extraction_limits().mobile.clone();
        let decoded = extract_from_path_with_quota(&source, &quota, |path, bytes| {
            if ["cbm","fam","dev","phm","mod"].contains(&path.rsplit('.').next().unwrap_or("").to_lowercase().as_str()) {
                let text = String::from_utf8(bytes).map_err(|_| NativeError::new(NativeErrorCode::InputCorrupt, format!("文本编码无效: {}", path)))?;
                tx.execute("INSERT INTO entries(key,path,text) VALUES(?1,?2,?3)",params![normalize_entry_key(&path),path,text.trim_start_matches('\u{feff}')]).map_err(sqlite_error)?;
            }
            Ok(())
        })?;
        if decoded.magic != "GIMPKGT" { return Err(NativeError::new(NativeErrorCode::SourceChanged, "私有源包类型错误")); }
        tx.commit().map_err(sqlite_error)?; drop(db);
        let target = project.join("cache/project.sqlite");
        #[cfg(target_os = "windows")]
        if target.exists() { fs::remove_file(&target).map_err(NativeError::from)?; }
        fs::rename(&pending, target).map_err(NativeError::from)
    })();
    if pending.exists() { let _ = fs::remove_file(&pending); }
    result
}
pub fn cached(root: &Path, id: &str) -> Result<Option<serde_json::Value>, NativeError> {
    Ok(checked_cache(root,id)?.map(|(value,_)| value))
}
pub fn cached_json(root: &Path, id: &str) -> Result<Option<String>, NativeError> {
    Ok(checked_cache(root,id)?.map(|(_,json)| json))
}
pub fn recover_cache_miss<T>(result: Result<Option<T>, NativeError>) -> Result<Option<T>, NativeError> {
    match result {
        Err(error) if error.code == NativeErrorCode::IndexInvalid => Ok(None),
        result => result,
    }
}
fn checked_cache(root: &Path, id: &str) -> Result<Option<(serde_json::Value,String)>, NativeError> {
    validate_source(root, id)?;
    if read_meta(root,id)?.parser_version != PARSER { return Ok(None); }
    let db = database(root, id)?;
    // Warm open checks the semantic table; text pages are read only when their sources are needed.
    let check: String = db.query_row("PRAGMA quick_check(semantics)", [], |r| r.get(0)).map_err(sqlite_error)?;
    if check != "ok" { return Ok(None); }
    let mut q = db.prepare("SELECT json FROM semantics WHERE parser=?1").map_err(sqlite_error)?;
    let mut rows = q.query([PARSER]).map_err(sqlite_error)?;
    if let Some(row) = rows.next().map_err(sqlite_error)? {
        let text: String = row.get(0).map_err(sqlite_error)?; let payload: serde_json::Value = serde_json::from_str(&text).map_err(index_json_error)?;
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
pub fn touch(root: &Path, id: &str) -> Result<(), NativeError> { let mut m = read_meta(root, id)?; m.last_opened_at = now(); write_meta(&dir(root, id)?, &m) }
pub fn delete(root: &Path, id: &str) -> Result<(), NativeError> {
    let d=dir(root,id)?;
    if let Some(proofs)=SOURCE_PROOFS.get(){if let Ok(mut verified)=proofs.lock(){verified.remove(&d.join("source/original.gim"));}}
    if d.exists(){fs::remove_dir_all(d).map_err(NativeError::from)?;}Ok(())
}
fn invalid_stage() -> NativeError {
    NativeError::new(NativeErrorCode::InvalidPath, "导入文件必须来自应用私有暂存目录")
}

fn import_root(root: &Path) -> PathBuf {
    root.join("projects").join(".imports")
}

fn validate_import_root(root: &Path) -> Result<PathBuf, NativeError> {
    let expected = import_root(&root.canonicalize()?);
    let actual = expected.canonicalize()?;
    if actual != expected || !actual.is_dir() { return Err(invalid_stage()); }
    Ok(actual)
}

/// The SAF copy has exactly one direct attempt directory under .imports.
fn staged_file(root: &Path, input: &Path) -> Result<Option<PathBuf>, NativeError> {
    let imports = validate_import_root(root)?;
    let attempt = input.parent().ok_or_else(invalid_stage)?;
    let attempt_name = attempt.file_name().ok_or_else(invalid_stage)?;
    let parent = attempt.parent().ok_or_else(invalid_stage)?;
    if input.file_name().and_then(|name| name.to_str()) != Some("original.gim")
        || parent.canonicalize()? != imports
    {
        return Err(invalid_stage());
    }
    let metadata = match fs::symlink_metadata(input) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let actual = match input.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || actual != imports.join(attempt_name).join("original.gim") {
        return Err(invalid_stage());
    }
    Ok(Some(actual))
}

pub fn clean_imports(root: &Path) -> Result<(), NativeError> {
    fs::create_dir_all(root)?;
    let projects = root.canonicalize()?.join("projects");
    fs::create_dir_all(&projects)?;
    if projects.canonicalize()? != projects { return Err(invalid_stage()); }
    let staging = projects.join(".imports");
    // Setup runs before this process can start SAF copies or claim a stage.
    match fs::symlink_metadata(&staging) {
        Ok(_) => fs::remove_dir_all(validate_import_root(root)?)?,
        Err(error) if error.kind() == ErrorKind::NotFound => {},
        Err(error) => return Err(error.into()),
    }
    fs::create_dir(&staging)?;
    for meta in list(root).into_iter().filter(|m| m.parser_version.is_empty()) { delete(root, &meta.id)?; }
    Ok(())
}
pub fn discard(root: &Path, input: &str) -> Result<(), NativeError> {
    let Some(path) = staged_file(root, Path::new(input))? else { return Ok(()); };
    match fs::remove_file(&path) {
        Ok(()) => fs::remove_dir_all(path.parent().ok_or_else(invalid_stage)?).map_err(NativeError::from),
        // A prepare may already have claimed original.gim by renaming it.
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn check_staged_size(size: u64, declared_size: u64) -> Result<(), NativeError> {
    let limit = gim_native_core::extraction_limits().mobile.max_archive_bytes;
    if size > limit {
        return Err(NativeError::new(NativeErrorCode::ResourceLimit, format!("文件超过 {} 字节导入限额", limit)));
    }
    if size != declared_size {
        return Err(NativeError::new(NativeErrorCode::SourceChanged, "暂存文件大小不匹配"));
    }
    Ok(())
}

pub fn prepare(root: &Path, input: ImportFile, cancelled: &AtomicBool, mut progress: impl FnMut(&str, u64, Option<u64>)) -> Result<Prepared, NativeError> {
    let staged = staged_file(root, Path::new(&input.path))?.ok_or_else(|| {
        NativeError::new(NativeErrorCode::SourceChanged, "暂存文件已不可用")
    })?;
    let staging = staged.parent().ok_or_else(invalid_stage)?.to_path_buf();
    let input_path = staging.join("preparing.gim");
    // Rename and discard's remove_file compete for the same path. Only the
    // winner owns the directory, so discard cannot delete a live preparation.
    fs::rename(&staged, &input_path)?;
    let result = (|| {
        let mut file = fs::File::open(&input_path).map_err(NativeError::from)?;
        let size = file.metadata()?.len();
        check_staged_size(size, input.size)?;
        if size < 7 { return Err(NativeError::new(NativeErrorCode::InputCorrupt, "暂存文件缺少完整 GIM 文件头")); }
        let mut header = [0u8; 7]; file.read_exact(&mut header)?;
        if &header != b"GIMPKGT" { return Err(NativeError::new(NativeErrorCode::UnsupportedFormat, "当前移动端只支持 GIMPKGT 输电线路工程")); }
        let mut digest = Sha256::new(); digest.update(header);
        let mut buffer = [0u8; 256 * 1024]; let mut done = 7u64;
        loop { if cancelled.load(Ordering::Relaxed) { return Err(NativeError::new(NativeErrorCode::Cancelled,"导入已取消")); } let n = file.read(&mut buffer).map_err(NativeError::from)?; if n == 0 { break; } digest.update(&buffer[..n]); done += n as u64; if done % (1024 * 1024) < buffer.len() as u64 { progress("识别工程与校验", done, Some(size)); } }
        let sha = format!("{:x}", digest.finalize()); if sha != input.sha256 { return Err(NativeError::new(NativeErrorCode::SourceChanged, "SHA 校验失败")); }
        drop(file);
        let project = dir(root, &sha)?;
        if project.exists() { let meta = read_meta(root, &sha)?; if meta.sha256 != sha || meta.size != size { return Err(NativeError::new(NativeErrorCode::SourceChanged,"现有工程身份不匹配")); } let cache = recover_cache_miss(cached(root, &sha))?; touch(root, &sha)?; return Ok(Prepared { meta, duplicate: true, cache }); }
        fs::create_dir_all(staging.join("source")).map_err(NativeError::from)?;
        fs::create_dir_all(staging.join("cache/semantic")).map_err(NativeError::from)?;
        fs::create_dir_all(staging.join("cache/previews")).map_err(NativeError::from)?;
        let mut db = Connection::open(staging.join("cache/project.sqlite")).map_err(sqlite_error)?;
        initialize_cache_schema(&db)?;
        let tx = db.transaction().map_err(sqlite_error)?; let mut count = 0u64;
        progress("解压归档", 0, None);
        let quota = gim_native_core::extraction_limits().mobile.clone();
        let metadata = extract_from_path_with_quota(&input_path, &quota, |path, bytes| {
            if cancelled.load(Ordering::Relaxed) { return Err(NativeError::new(NativeErrorCode::Cancelled,"导入已取消")); }
            count += 1;
            if ["cbm", "fam", "dev", "phm", "mod"].contains(&path.rsplit('.').next().unwrap_or("").to_lowercase().as_str()) {
                let text = String::from_utf8(bytes).map_err(|_| NativeError::new(NativeErrorCode::InputCorrupt, format!("文本编码无效: {}", path)))?;
                tx.execute("INSERT INTO entries(key,path,text) VALUES (?1,?2,?3)", params![normalize_entry_key(&path), path, text.trim_start_matches('\u{feff}')]).map_err(sqlite_error)?;
            }
            if count % 200 == 0 { progress("解压归档", count, None); } Ok(())
        })?;
        tx.commit().map_err(sqlite_error)?; drop(db);
        if metadata.magic != "GIMPKGT" { return Err(NativeError::new(NativeErrorCode::UnsupportedFormat, "只支持线路工程")); }
        if cancelled.load(Ordering::Relaxed) { return Err(NativeError::new(NativeErrorCode::Cancelled,"导入已取消")); }
        fs::rename(&input_path, staging.join("source/original.gim")).map_err(NativeError::from)?;
        let name = metadata.project_name.filter(|n| !n.trim().is_empty()).unwrap_or(input.name.trim_end_matches(".gim").to_string());
        let meta = ProjectMeta { id: sha.clone(), name, sha256: sha, size, imported_at: now(), last_opened_at: now(), parser_version: String::new(), counts: serde_json::json!({}) };
        write_meta(&staging, &meta)?;
        fs::rename(&staging, &project).map_err(NativeError::from)?;
        Ok(Prepared { meta, duplicate: false, cache: None })
    })();
    if staging.exists() { let _ = fs::remove_dir_all(staging); }
    result
}
#[cfg(test)]
pub fn commit(root: &Path, id: &str, payload: serde_json::Value) -> Result<(), NativeError> {
    commit_json(root,id,serde_json::to_string(&payload).map_err(internal)?)
}
pub fn commit_json(root: &Path, id: &str, json: String) -> Result<(), NativeError> {
    validate_source(root, id)?;
    if json.len() > 64*1024*1024 { return Err(NativeError::new(NativeErrorCode::ResourceLimit, "语义缓存超过 64 MiB 限额")); }
    let payload: serde_json::Value = serde_json::from_str(&json).map_err(|error| NativeError::new(NativeErrorCode::InvalidInput, error.to_string()))?;
    let mut meta = read_meta(root, id)?;
    if payload["id"] != id || payload["sourceSha256"] != meta.sha256 || payload["sourceSize"] != meta.size { return Err(NativeError::new(NativeErrorCode::SourceChanged, "缓存源身份不匹配")); }
    if payload["parserVersion"] != PARSER { return Err(NativeError::new(NativeErrorCode::SchemaUnsupported, "缓存解析契约不匹配")); }
    let mut db = database(root, id)?; let tx = db.transaction().map_err(sqlite_error)?;
    tx.execute("DELETE FROM semantics", []).map_err(sqlite_error)?;
    tx.execute("INSERT INTO semantics(parser,json) VALUES(?1,?2)", params![PARSER, json]).map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
    meta.name = payload["name"].as_str().unwrap_or(&meta.name).to_string(); meta.parser_version = PARSER.into(); meta.counts = payload["counts"].clone(); write_meta(&dir(root, id)?, &meta)
}
pub fn preview(root: &Path, id: &str, key: &str, data: Option<serde_json::Value>) -> Result<Option<serde_json::Value>, NativeError> {
    if key.len() > 8192 { return Err(NativeError::new(NativeErrorCode::InvalidInput, "无效预览键")); }
    let db = database(root, id)?;
    if let Some(v) = data { db.execute("INSERT OR REPLACE INTO previews(key,json) VALUES(?1,?2)", params![key, serde_json::to_string(&v).map_err(internal)?]).map_err(sqlite_error)?; return Ok(Some(v)); }
    let mut q = db.prepare("SELECT json FROM previews WHERE key=?1").map_err(sqlite_error)?; let mut rows = q.query([key]).map_err(sqlite_error)?;
    if let Some(row) = rows.next().map_err(sqlite_error)? { let text: String = row.get(0).map_err(sqlite_error)?; Ok(Some(serde_json::from_str(&text).map_err(index_json_error)?)) } else { Ok(None) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_details_reuse_identity_proof_and_reject_same_size_replacement() {
        let root=crate::workspace_test_temp().join(format!("source-detail-{}-{}",std::process::id(),now()));
        let bytes=b"GIMPKGT-original";let id=format!("{:x}",Sha256::digest(bytes));let project=dir(&root,&id).unwrap();
        fs::create_dir_all(project.join("source")).unwrap();fs::create_dir_all(project.join("cache")).unwrap();
        let path=project.join("source/original.gim");fs::write(&path,bytes).unwrap();
        write_meta(&project,&ProjectMeta{id:id.clone(),name:"fixture".into(),sha256:id.clone(),size:bytes.len() as u64,imported_at:0,last_opened_at:0,parser_version:PARSER.into(),counts:serde_json::json!({})}).unwrap();
        let db=Connection::open(project.join("cache/project.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE entries(key TEXT PRIMARY KEY,path TEXT,text TEXT);INSERT INTO entries VALUES('unit.cbm','unit.cbm','original text');").unwrap();db.pragma_update(None,"user_version",gim_native_core::DATABASE_SCHEMA_VERSION).unwrap();drop(db);
        for _ in 0..4 {assert_eq!(source(&root,&id,"unit.cbm").unwrap(),"original text");}
        assert_eq!(SOURCE_HASH_READS.get().unwrap().lock().unwrap().get(&path),Some(&1));
        let db=Connection::open(project.join("cache/project.sqlite")).unwrap();db.pragma_update(None,"user_version",2).unwrap();
        assert_eq!(source(&root,&id,"unit.cbm").unwrap_err().code,NativeErrorCode::SchemaUnsupported);
        assert_eq!(db.query_row("SELECT text FROM entries",[],|row|row.get::<_,String>(0)).unwrap(),"original text");
        db.pragma_update(None,"user_version",gim_native_core::DATABASE_SCHEMA_VERSION).unwrap();drop(db);
        fs::write(&path,b"GIMPKGT-replaced").unwrap();
        fs::File::options().write(true).open(&path).unwrap().set_times(fs::FileTimes::new().set_modified(SystemTime::now()+std::time::Duration::from_secs(5))).unwrap();
        assert_eq!(source(&root,&id,"unit.cbm").unwrap_err().code,NativeErrorCode::SourceChanged);
        assert_eq!(SOURCE_HASH_READS.get().unwrap().lock().unwrap().get(&path),Some(&2));
        delete(&root,&id).unwrap();assert!(!SOURCE_PROOFS.get().unwrap().lock().unwrap().contains_key(&path));fs::remove_dir_all(root).unwrap();
    }
    fn test_payload(id: &str, size: u64, name: &str) -> serde_json::Value {
        serde_json::json!({"id":id,"sourceSha256":id,"sourceSize":size,"parserVersion":PARSER,"name":name,"objects":[{"id":"root","kind":"project"}],"rawWires":[],"tree":{"objectId":"root","children":[]},"counts":{"project":1,"line":0,"strain":0,"tower":0,"span":0,"cross":0}})
    }
    #[test]
    fn staged_quota_and_identity_mismatch_have_distinct_contract_codes() {
        let limit = gim_native_core::extraction_limits().mobile.max_archive_bytes;
        assert!(check_staged_size(limit, limit).is_ok());
        let quota = check_staged_size(limit + 1, limit + 1).unwrap_err();
        assert_eq!(serde_json::to_value(quota).unwrap()["code"], "RESOURCE_LIMIT");
        let identity = check_staged_size(limit, limit - 1).unwrap_err();
        assert_eq!(serde_json::to_value(identity).unwrap()["code"], "SOURCE_CHANGED");
        assert_eq!(validate_id("invalid").unwrap_err().code, NativeErrorCode::InvalidInput);
    }

    #[test]
    fn recovered_start_cleans_interrupted_attempts_and_keeps_committed_project() {
        let root = crate::workspace_test_temp().join(format!("gim-import-recover-{}-{}", std::process::id(), now()));
        clean_imports(&root).unwrap();
        let staging = import_root(&root);
        let interrupted_copy = staging.join("copy");
        fs::create_dir(&interrupted_copy).unwrap();
        fs::write(interrupted_copy.join("original.gim"), b"partial copy").unwrap();

        let interrupted_prepare = staging.join("prepare");
        fs::create_dir(&interrupted_prepare).unwrap();
        fs::write(interrupted_prepare.join("preparing.gim"), b"claimed copy").unwrap();
        discard(&root, &interrupted_prepare.join("original.gim").to_string_lossy()).unwrap();
        assert!(interrupted_prepare.join("preparing.gim").is_file());

        let incomplete_id = "a".repeat(64);
        let published_id = "b".repeat(64);
        for (id, parser_version) in [(&incomplete_id, ""), (&published_id, PARSER)] {
            let project = dir(&root, id).unwrap();
            fs::create_dir(&project).unwrap();
            write_meta(&project, &ProjectMeta {
                id: id.clone(), name: "fixture".into(), sha256: id.clone(), size: 1,
                imported_at: 0, last_opened_at: 0, parser_version: parser_version.into(),
                counts: serde_json::json!({}),
            }).unwrap();
        }

        clean_imports(&root).unwrap();
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
        assert!(!dir(&root, &incomplete_id).unwrap().exists());
        assert_eq!(read_meta(&root, &published_id).unwrap().parser_version, PARSER);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepare_and_discard_reject_nested_staging_paths() {
        let root = crate::workspace_test_temp().join(format!("gim-invalid-stage-{}-{}", std::process::id(), now()));
        clean_imports(&root).unwrap();
        let nested = import_root(&root).join("attempt").join("nested");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("original.gim");
        fs::write(&file, b"unexpected nested source").unwrap();
        let input = ImportFile { path: file.to_string_lossy().into(), name: "fixture.gim".into(), sha256: String::new(), size: 0 };
        assert_eq!(prepare(&root, input, &AtomicBool::new(false), |_, _, _| {}).unwrap_err().code, NativeErrorCode::InvalidPath);
        assert_eq!(discard(&root, &file.to_string_lossy()).unwrap_err().code, NativeErrorCode::InvalidPath);
        assert!(file.is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn damaged_cache_rebuild_preserves_original_source_and_cleans_pending_database() {
        let root = crate::workspace_test_temp().join(format!("gim-repair-{}-{}", std::process::id(), now())); clean_imports(&root).unwrap();
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
        let root = crate::workspace_test_temp().join(format!("gim-cancel-{}-{}", std::process::id(), now()));
        clean_imports(&root).unwrap(); let stage = root.join("projects/.imports/one"); fs::create_dir(&stage).unwrap();
        let bytes = b"GIMPKGTcancel-test"; let path = stage.join("original.gim"); fs::write(&path, bytes).unwrap();
        let input = ImportFile { path: path.to_string_lossy().into(), name: "test.gim".into(), size: bytes.len() as u64, sha256: format!("{:x}", Sha256::digest(bytes)) };
        let err = prepare(&root, input, &AtomicBool::new(true), |_,_,_| {}).err().unwrap();
        assert_eq!(err.code, NativeErrorCode::Cancelled); assert!(!stage.exists()); assert!(list(&root).is_empty());
        let outside = root.join("original.gim"); fs::write(&outside, bytes).unwrap();
        assert!(discard(&root, &outside.to_string_lossy()).is_err()); assert!(outside.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn semantic_commit_checks_source_identity() {
        let root = crate::workspace_test_temp().join(format!("gim-mobile-test-{}", now())); let bytes = b"GIMPKGT"; let id = format!("{:x}", Sha256::digest(bytes)); let p = dir(&root, &id).unwrap(); fs::create_dir_all(p.join("cache")).unwrap(); fs::create_dir_all(p.join("source")).unwrap(); fs::write(p.join("source/original.gim"),bytes).unwrap();
        let m = ProjectMeta { id: id.clone(), name: "test".into(), sha256: id.clone(), size: 7, imported_at: 0, last_opened_at: 0, parser_version: String::new(), counts: serde_json::json!({}) }; write_meta(&p, &m).unwrap();
        let db = Connection::open(p.join("cache/project.sqlite")).unwrap(); db.execute_batch("CREATE TABLE semantics(parser TEXT PRIMARY KEY,json TEXT NOT NULL);").unwrap();db.pragma_update(None,"user_version",gim_native_core::DATABASE_SCHEMA_VERSION).unwrap();drop(db);
        let bad = serde_json::json!({"id":id,"sourceSha256":"wrong","sourceSize":7,"parserVersion":PARSER}); assert!(commit(&root, &id, bad).is_err()); assert!(cached(&root, &id).unwrap().is_none());
        let good = test_payload(&id, 7, "saved"); commit(&root, &id, good.clone()).unwrap(); assert_eq!(cached(&root, &id).unwrap(), Some(good.clone()));
        assert_eq!(serde_json::from_str::<serde_json::Value>(&cached_json(&root,&id).unwrap().unwrap()).unwrap(),good);
        // A prior semantic contract must rebuild from the existing private source, not require reimport.
        let mut old = good.clone(); old["parserVersion"] = serde_json::json!("unsupported-parser");
        let db = database(&root, &id).unwrap();
        db.execute("DELETE FROM semantics", []).unwrap();
        db.execute("INSERT INTO semantics(parser,json) VALUES(?1,?2)", params!["unsupported-parser", old.to_string()]).unwrap(); drop(db);
        assert!(cached_json(&root,&id).unwrap().is_none());
        assert_eq!(fs::read(p.join("source/original.gim")).unwrap(), bytes);
        commit(&root, &id, good.clone()).unwrap(); assert_eq!(cached(&root, &id).unwrap(), Some(good));
        fs::write(p.join("source/original.gim"), b"GIMPKGS").unwrap();
        assert!(cached_json(&root,&id).unwrap_err().message.contains("类型")); assert!(text_entries(&root,&id).is_err());
        fs::write(p.join("source/original.gim"), b"GIMPKGTchanged").unwrap();
        assert!(cached_json(&root,&id).unwrap_err().message.contains("大小"));
        let mut m = read_meta(&root,&id).unwrap(); m.size = 14; write_meta(&p,&m).unwrap();
        assert!(cached_json(&root,&id).unwrap_err().message.contains("SHA"));
        delete(&root, &id).unwrap(); assert!(!p.exists()); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn header_reads_only_prefix_and_rejects_changed_source() {
        let root = crate::workspace_test_temp().join(format!("gim-header-test-{}", now()));
        let mut bytes = vec![0u8; 784]; bytes[..7].copy_from_slice(b"GIMPKGT");
        bytes.extend_from_slice(&[0x37,0x7a,0xbc,0xaf,0x27,0x1c]); bytes.extend_from_slice(b"archive bytes");
        let id = format!("{:x}", Sha256::digest(&bytes)); let p = dir(&root,&id).unwrap();
        fs::create_dir_all(p.join("source")).unwrap(); fs::write(p.join("source/original.gim"), &bytes).unwrap();
        let m = ProjectMeta { id:id.clone(),name:"anonymous".into(),sha256:id.clone(),size:bytes.len() as u64,imported_at:0,last_opened_at:0,parser_version:PARSER.into(),counts:serde_json::json!({}) };
        write_meta(&p,&m).unwrap(); assert_eq!(header(&root,&id).unwrap(),bytes[..784]);
        bytes[20] = 1; fs::write(p.join("source/original.gim"), &bytes).unwrap();
        assert!(header(&root,&id).unwrap_err().message.contains("SHA")); assert!(header(&root,"../escape").is_err());
        fs::remove_dir_all(root).unwrap();
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

fn normalize_entry_key(path: &str) -> String { path.replace('\\', "/").to_lowercase() }
