//! DEV GLB/LOD cache validation, manifests and publication markers.

use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::{HashMap, HashSet};
use std::fs as stdfs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::Manager;
use super::cache_paths::{
    BatchCachePathResolver,
    atomic_write,
    ensure_cache_parent,
    ensure_cache_project_id,
    reject_link,
    validate_entry_path,
};
use super::cache_protocol::{
    BatchCacheFileResult,
    BinaryCacheWriteMeta,
    decode_binary_cache_write_request,
    encode_batch_cache_response,
};
use super::projects::{ensure_project_exists, ensure_project_source_sha};
use super::{DbState, GEOMETRY_CACHE_VERSION};
use super::semantic_pack::{normalize_cache_lookup_path};
use super::validation_profile::{ValidationSpan};

#[derive(Debug, Serialize, Deserialize)]
pub struct GeometryCacheManifestEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    pub entry_path: String,
    /// DEV 几何结果：`glb`/`partial` 表示有可加载的 GLB，`empty` 表示
    /// 确定性空几何，`unsupported` 表示源非空但当前 renderer 不支持。
    /// 旧 manifest 没有该字段，反序列化失败后会整体失效并重建。
    pub status: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GeometryCacheManifest {
    pub source_sha256: String,
    pub entries: Vec<GeometryCacheManifestEntry>,
}

// ===== GLB 几何缓存（方案 C：MOD → glTF 离线预序列化） =====

/// GLB warm fast path 的单次批读上限。前端按 manifest 中的 size 在此边界
/// 内组批；单个超大 DEV 允许独占一个批次，避免因为一个合法大模型直接回退
/// 原始 MOD。
const MAX_GLB_BATCH_FILES: usize = 256;

const MAX_GLB_BATCH_BYTES: u64 = 64 * 1024 * 1024;

const MAX_SINGLE_GLB_BYTES: u64 = 512 * 1024 * 1024;

/// 计算 GLB 缓存文件路径：app_data_dir/glbcache/{project_id}/{entry_path}.glb
///
/// 与 `cache_file_path`（extracted/）和 `fragment_cache_file_path`（fragments/）并列，
/// 独立目录存放序列化后的 glTF 二进制，便于版本失效时整体删除。
///
/// entry_path 通过组件级校验（只允许 Normal 组件），防止 ../ 和 \..\ 穿越。
fn glb_cache_file_path(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    entry_path: &str,
) -> Result<PathBuf, String> {
    ensure_cache_project_id(project_id)?;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;

    let safe_rel = validate_entry_path(entry_path)?;

    // 追加 .glb 后缀到文件名
    let mut glb_rel = safe_rel;
    let file_name = glb_rel
        .file_name()
        .map(|n| format!("{}.glb", n.to_string_lossy()))
        .ok_or("无法获取 glb 文件名")?;
    glb_rel.set_file_name(file_name);

    // 构建预期根目录：app_data_dir/glbcache/{project_id}
    let root = base.join("glbcache").join(project_id.to_string());
    if !root.exists() {
        stdfs::create_dir_all(&root).map_err(|e| format!("创建 glbcache 目录失败: {}", e))?;
    }
    reject_link(&root, " GLB")?;

    // 规范化根目录用于 containment 校验
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("规范化 glbcache 根目录失败: {}", e))?;

    let parent_rel = glb_rel.parent().unwrap_or_else(|| Path::new(""));
    let canonical_parent = ensure_cache_parent(&canonical_root, parent_rel, " GLB")?;
    let file_name = glb_rel.file_name().ok_or("无法获取 glb 文件名")?;
    let full = canonical_parent.join(file_name);

    if !full.starts_with(&canonical_root) {
        return Err("路径越界".to_string());
    }

    reject_link(&full, " GLB 文件")?;

    Ok(full)
}

/// Tauri command：以 Raw IPC 写入 GLB 缓存文件。
#[tauri::command]
pub fn write_glb_file_binary(
    app_handle: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let (meta, bytes) = decode_binary_cache_write_request(&request)?;
    let conn = app_handle.state::<DbState>();
    let guard = conn
        .0
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))?;
    ensure_project_exists(&guard, meta.project_id)?;
    // GLB 编译运行在后台；在命令真正落盘前再次核对源 GIM SHA，避免
    // 旧工程任务在同一 project_id 被源文件更新后覆盖新几何缓存。
    ensure_project_source_sha(
        &guard,
        meta.project_id,
        meta.source_gim_sha256.as_deref(),
    )?;
    drop(guard);
    let path = glb_cache_file_path(&app_handle, meta.project_id, &meta.entry_path)?;
    atomic_write(&path, &bytes, " GLB")?;
    Ok(path.to_string_lossy().to_string())
}

/// Tauri command：读取 GLB 缓存文件
///
/// 返回 `tauri::ipc::Response`（原始二进制），避免 `Vec<u8>` 经 JSON 序列化为
/// 数字数组带来的 3x 体积膨胀和解析开销。JS 侧 `invoke` 返回 `ArrayBuffer`。
#[tauri::command]
pub async fn read_glb_file(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
) -> Result<tauri::ipc::Response, String> {
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    let path = glb_cache_file_path(&app_handle, project_id, &entry_path)?;
    let bytes = stdfs::read(&path).map_err(|e| format!("读取 glb 缓存文件失败: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Per-template derived domain; publication is independent of whole-project geometry.
fn validate_device_lod_entry<'a>(entry: &'a str, source_sha: &str) -> Result<(&'a str, String), String> {
    let (store, key) = entry.split_once('/').ok_or("设备缓存键缺少域")?;
    let parts: Vec<&str> = key.split('|').collect();
    let bound_sha = match store {
        "templates" if parts.len() == 4 && parts[0] == GEOMETRY_CACHE_VERSION => parts[1],
        "catalog" if parts.len() == 4 && parts[0] == "dev-spatial-catalog-v2" && parts[1] == GEOMETRY_CACHE_VERSION => parts[2],
        _ => return Err("设备缓存域或版本无效".into()),
    };
    if source_sha.len() != 64 || !source_sha.bytes().all(|c| c.is_ascii_hexdigit()) || bound_sha != source_sha {
        return Err("设备缓存源身份不匹配".into());
    }
    Ok((store, format!("{:x}", sha2::Sha256::digest(key.as_bytes()))))
}

#[cfg(test)]
mod device_lod_key_tests {
    use super::*;
    #[test]
    fn source_bound_keys_accept_only_their_domain_version_and_sha() {
        let sha="a".repeat(64);
        let template=format!("templates/{}|{}|DEV/x.dev|lod0",GEOMETRY_CACHE_VERSION,sha);
        let catalog=format!("catalog/dev-spatial-catalog-v2|{}|{}|DEV/x.dev",GEOMETRY_CACHE_VERSION,sha);
        assert!(validate_device_lod_entry(&template,&sha).is_ok());
        assert!(validate_device_lod_entry(&catalog,&sha).is_ok());
        assert!(validate_device_lod_entry(&template,&"b".repeat(64)).is_err());
        assert!(validate_device_lod_entry(&template.replace("templates/","../"),&sha).is_err());
        assert!(validate_device_lod_entry(&catalog.replace("dev-spatial-catalog-v2","old"),&sha).is_err());
    }
}

fn device_lod_artifact_path(
    app: &tauri::AppHandle, project_id: i64, entry: &str, source_sha: &str,
) -> Result<PathBuf, String> {
    let (store, digest) = validate_device_lod_entry(entry, source_sha)?;
    let conn = app.state::<DbState>();
    let guard = conn.0.lock().map_err(|e| e.to_string())?;
    ensure_project_source_sha(&guard, project_id, Some(source_sha))?;
    drop(guard);
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("device-lod");
    if !base.exists() { stdfs::create_dir_all(&base).map_err(|e| e.to_string())?; }
    reject_link(&base, "设备派生缓存")?;
    let root = base.canonicalize().map_err(|e| e.to_string())?;
    let relative = PathBuf::from(project_id.to_string()).join(store);
    let parent = ensure_cache_parent(&root, &relative, "设备派生缓存")?;
    let path = parent.join(format!("{}.bin", digest));
    reject_link(&path, "设备派生缓存")?;
    Ok(path)
}

/// Bounded read batch: validate project identity and parent directories once per batch.
#[tauri::command]
pub async fn read_device_lod_artifacts(app_handle: tauri::AppHandle, project_id: i64, entry_paths: Vec<String>, source_gim_sha256: String, max_bytes: Option<u64>) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        if entry_paths.is_empty() || entry_paths.len() > 64 { return Err("设备缓存批量条目数无效".into()); }
        let byte_limit=max_bytes.unwrap_or(512*1024*1024);
        if byte_limit==0 || byte_limit>512*1024*1024 {return Err("设备缓存批量字节配额无效".into());}
        ensure_cache_project_id(project_id)?;
        let started = Instant::now();
        let validated = entry_paths.iter().map(|entry| validate_device_lod_entry(entry,&source_gim_sha256)).collect::<Result<Vec<_>,_>>()?;
        {
            let state = app_handle.state::<DbState>();
            let conn = state.0.lock().map_err(|e|e.to_string())?;
            ensure_project_source_sha(&conn,project_id,Some(&source_gim_sha256))?;
        }
        let base = app_handle.path().app_data_dir().map_err(|e|e.to_string())?.join("device-lod");
        if !base.exists() { stdfs::create_dir_all(&base).map_err(|e|e.to_string())?; }
        reject_link(&base,"设备派生缓存")?;
        let root = base.canonicalize().map_err(|e|e.to_string())?;
        let mut resolve_ms = started.elapsed().as_secs_f64()*1000.0;
        let mut read_ms = 0.0_f64;
        let mut parents = HashMap::new();
        let mut results = Vec::new(); let mut total = 0_u64; let mut hits = 0_u32;
        for (entry,(store,digest)) in entry_paths.iter().zip(validated) {
            let resolve_started=Instant::now();
            // Reuse canonicalization, not reparse-point trust: recheck mutable directory components per file.
            reject_link(&base,"设备派生缓存")?;
            reject_link(&root.join(project_id.to_string()),"设备派生缓存")?;
            reject_link(&root.join(project_id.to_string()).join(store),"设备派生缓存")?;
            if !parents.contains_key(store) {
                let parent = ensure_cache_parent(&root,&PathBuf::from(project_id.to_string()).join(store),"设备派生缓存")?;
                parents.insert(store,BatchCachePathResolver::new(&parent)?);
            }
            let path = parents.get_mut(store).unwrap().resolve(&format!("{}.bin",digest))?;
            resolve_ms+=resolve_started.elapsed().as_secs_f64()*1000.0;
            let read_started=Instant::now();
            let bytes = match stdfs::File::open(path) {
                Ok(file) => {
                    let size=file.metadata().map_err(|e|e.to_string())?.len();
                    if size > 128*1024*1024 || size>byte_limit { return Err("设备缓存单条超过配额".into()); }
                    if total+size>byte_limit {continue;} // Omitted rows are deferred, never reported as misses.
                    let mut bytes=Vec::new();file.take(128*1024*1024+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
                    if bytes.len()>128*1024*1024 { return Err("设备缓存单条超过配额".into()); }
                    total += bytes.len() as u64; if total>byte_limit { return Err("设备缓存批量超过配额".into()); }
                    hits+=1;Some(bytes)
                },
                Err(e) if e.kind()==std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.to_string()),
            };
            read_ms+=read_started.elapsed().as_secs_f64()*1000.0;
            results.push(BatchCacheFileResult{entry_path:entry.clone(),bytes});
        }
        Ok(tauri::ipc::Response::new(encode_batch_cache_response(results,total,hits,read_ms,resolve_ms,started)?))
    }).await.map_err(|e|format!("设备缓存批量读取失败: {}",e))?
}

#[tauri::command]
pub async fn write_device_lod_artifact(app_handle: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let (meta, bytes) = decode_binary_cache_write_request(&request)?;
    drop(request);
    tauri::async_runtime::spawn_blocking(move || write_device_lod_artifact_blocking(app_handle, meta, bytes))
        .await.map_err(|e| format!("设备缓存后台写入失败: {}", e))?
}

fn write_device_lod_artifact_blocking(app_handle: tauri::AppHandle, meta: BinaryCacheWriteMeta, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() > 128 * 1024 * 1024 { return Err("设备派生缓存超过单条配额".into()); }
    let source = meta.source_gim_sha256.as_deref().ok_or("设备缓存缺少源 SHA")?;
    let path = device_lod_artifact_path(&app_handle, meta.project_id, &meta.entry_path, source)?;
    atomic_write(&path, &bytes, "设备派生缓存")
}

#[tauri::command]
pub fn delete_device_lod_artifact(app_handle: tauri::AppHandle, project_id: i64, entry_path: String, source_gim_sha256: String) -> Result<(), String> {
    let path = device_lod_artifact_path(&app_handle, project_id, &entry_path, &source_gim_sha256)?;
    match stdfs::remove_file(path) { Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(e) => Err(e.to_string()) }
}

/// Tauri command：批量读取 DEV GLB 缓存文件。
///
/// 请求仍只携带受校验的 entry_path 列表，响应使用 GIMR v2 二进制 envelope，
/// 不把 GLB 编码成 JSON 数字数组。单条文件缺失返回 envelope 中的 null；
/// 前端根据 manifest 将其判定为对应 DEV 的 fast path 不可用，并仅对
/// 该 DEV 做 scoped 原始 MOD/STL 回退；manifest 结构本身损坏才整体重建。
#[tauri::command]
pub async fn batch_read_glb_files(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_paths: Vec<String>,
) -> Result<tauri::ipc::Response, String> {
    let total_started = Instant::now();
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    if entry_paths.len() > MAX_GLB_BATCH_FILES {
        return Err("批量读取 GLB 文件数量超过安全上限".to_string());
    }

    let mut results = Vec::with_capacity(entry_paths.len());
    let mut total_bytes: u64 = 0;
    let mut hit_count: u32 = 0;
    let mut resolve_ms = 0.0_f64;
    let mut read_ms = 0.0_f64;
    for entry_path in &entry_paths {
        let resolve_started = Instant::now();
        let path = match glb_cache_file_path(&app_handle, project_id, entry_path) {
            Ok(path) => path,
            Err(_) => {
                resolve_ms += resolve_started.elapsed().as_secs_f64() * 1000.0;
                results.push(BatchCacheFileResult {
                    entry_path: entry_path.clone(),
                    bytes: None,
                });
                continue;
            }
        };
        resolve_ms += resolve_started.elapsed().as_secs_f64() * 1000.0;
        let read_started = Instant::now();
        let bytes = match stdfs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            // 对权限/IO 错误也返回单条 miss；调用方会放弃 fast path，
            // 但不会把一个不可读的缓存当作完整几何继续提交。
            Err(_) => None,
        };
        read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
        if let Some(ref data) = bytes {
            hit_count = hit_count.saturating_add(1);
            total_bytes = total_bytes
                .checked_add(data.len() as u64)
                .ok_or_else(|| "批量读取 GLB 总量溢出".to_string())?;
            let oversized_single = entry_paths.len() == 1
                && data.len() as u64 <= MAX_SINGLE_GLB_BYTES;
            if total_bytes > MAX_GLB_BATCH_BYTES && !oversized_single {
                return Err(format!(
                    "批量读取 GLB 总量超过安全上限（>{} bytes）",
                    MAX_GLB_BATCH_BYTES
                ));
            }
        }
        results.push(BatchCacheFileResult {
            entry_path: entry_path.clone(),
            bytes,
        });
    }
    let out = encode_batch_cache_response(
        results,
        total_bytes,
        hit_count,
        read_ms,
        resolve_ms,
        total_started,
    )?;
    Ok(tauri::ipc::Response::new(out))
}

/// 方案 C：检查 GLB 几何缓存版本是否匹配。
///
/// 读取 `{app_data_dir}/glbcache/{project_id}/_version.txt` 文件内容
/// 与 GEOMETRY_CACHE_VERSION 常量比较。
///
/// 返回值：
/// - true：版本文件存在且内容等于 GEOMETRY_CACHE_VERSION
/// - false：版本文件不存在（首次打开或旧版本无 marker）/ 内容不匹配 / IO 错误
///
/// 注意：false 只表示 geometry domain 不可用；调用方不得据此删除整个
/// 项目 source/index cache，应进入 DEV geometry rebuild。
pub(super) fn check_geometry_cache_version_file(app_handle: &tauri::AppHandle, project_id: i64) -> bool {
    let base = match app_handle.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let marker = base
        .join("glbcache")
        .join(project_id.to_string())
        .join("_version.txt");
    if reject_link(&marker, "版本标记").is_err() {
        return false;
    }
    match stdfs::read_to_string(&marker) {
        Ok(content) => content.trim() == GEOMETRY_CACHE_VERSION,
        Err(_) => false,
    }
}

fn load_geometry_cache_manifest(
    app_handle: &tauri::AppHandle,
    project_id: i64,
) -> Option<GeometryCacheManifest> {
    let path = geometry_manifest_path(app_handle, project_id).ok()?;
    let bytes = stdfs::read(path).ok()?;
    serde_json::from_slice::<GeometryCacheManifest>(&bytes).ok()
}

/// 校验 manifest 的整体结构与 source 身份，但不检查每个 GLB 文件。
///
/// 该层级故意与文件完整性分开：manifest/version 可用时，单个 GLB
/// 缺失或截断应由前端 DEV 粒度 fast path 隔离，而不是迫使整个工程重建。
pub(super) fn check_geometry_cache_manifest_structure(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    source_sha256: &str,
) -> bool {
    let _timing = ValidationSpan::new("geometry_structure");
    let Some(manifest) = load_geometry_cache_manifest(app_handle, project_id) else {
        return false;
    };
    if manifest.source_sha256 != source_sha256 || manifest.entries.len() > 200_000 {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    manifest
        .entries
        .iter()
        .all(|entry| validate_geometry_manifest_entry_shape(entry, &mut seen).is_ok())
}

fn validate_glb_bytes(bytes: &[u8]) -> bool {
    // GLB header: magic "glTF", version 2, declared total length (LE u32).
    if bytes.len() < 12
        || &bytes[..4] != b"glTF"
        || u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) != 2
    {
        return false;
    }
    let declared = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    declared == bytes.len()
}

/// 校验磁盘上的 GLB 头，而不把完整文件读入 Rust 堆。
///
/// `validate_gim_cache` 在 warm restore 前会遍历 manifest；完整 GLB 内容随后
/// 由 `batch_read_glb_files` 统一读取一次。这里只读固定 12-byte header，避免
/// 预检阶段把每个 DEV 的 GLB 再完整读一遍。
fn validate_glb_file_header(path: &Path, expected_size: u64) -> bool {
    if expected_size < 12 || expected_size > u32::MAX as u64 {
        return false;
    }
    let Ok(mut file) = stdfs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; 12];
    use std::io::Read;
    if file.read_exact(&mut header).is_err() {
        return false;
    }
    &header[..4] == b"glTF"
        && u32::from_le_bytes([header[4], header[5], header[6], header[7]]) == 2
        && u32::from_le_bytes([header[8], header[9], header[10], header[11]]) as u64
            == expected_size
}

fn geometry_manifest_path(
    app_handle: &tauri::AppHandle,
    project_id: i64,
) -> Result<PathBuf, String> {
    ensure_cache_project_id(project_id)?;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    let root = base.join("glbcache").join(project_id.to_string());
    if !root.exists() {
        return Err("GLB 缓存目录不存在".to_string());
    }
    reject_link(&root, " GLB")?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("规范化 GLB 缓存目录失败: {}", e))?;
    let manifest = canonical_root.join("_manifest.json");
    reject_link(&manifest, " GLB manifest")?;
    Ok(manifest)
}

/// 校验一个 DEV geometry manifest 条目的结构。该检查不访问磁盘，供
/// `validate_gim_cache`、manifest 写入和单元测试共享；文件存在/GLB header
/// 校验由调用方在此结构检查通过后执行。
pub(super) fn validate_geometry_manifest_entry_shape(
    entry: &GeometryCacheManifestEntry,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let normalized_path = normalize_cache_lookup_path(&entry.entry_path);
    validate_entry_path(&entry.entry_path)
        .map_err(|e| format!("GLB manifest entry_path 无效: {} ({})", entry.entry_path, e))?;
    if !normalized_path.ends_with(".dev") {
        return Err(format!("GLB manifest 只允许 DEV 条目: {}", entry.entry_path));
    }
    if !seen.insert(normalized_path) {
        return Err(format!("GLB manifest 条目重复: {}", entry.entry_path));
    }
    match entry.status.as_str() {
        "source-invalid" if entry.size == 0 && entry.diagnostic.as_deref().map(|s| !s.trim().is_empty() && s.len() <= 16384).unwrap_or(false) => Ok(()),
        "empty" if entry.size == 0 => Ok(()),
        "unsupported" if entry.size == 0 => Ok(()),
        "glb" | "partial" if entry.size > 0 => Ok(()),
        "empty" => Err(format!("empty GLB manifest 条目大小必须为 0: {}", entry.entry_path)),
        "unsupported" => Err(format!("unsupported GLB manifest 条目大小必须为 0: {}", entry.entry_path)),
        "glb" | "partial" => Err(format!("{} GLB manifest 条目大小必须大于 0: {}", entry.status, entry.entry_path)),
        _ => Err(format!("GLB manifest 状态无效: {}", entry.entry_path)),
    }
}

/// 读取当前项目的 DEV geometry manifest。manifest 本身只描述 source/status/size；
/// GLB 文件及 header/长度由 fast path 和 validate_gim_cache 继续独立校验。
#[tauri::command]
pub async fn read_geometry_cache_manifest(
    app_handle: tauri::AppHandle,
    project_id: i64,
) -> Result<GeometryCacheManifest, String> {
    {
        let conn = app_handle.state::<DbState>();
        let guard = conn
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
    }
    let path = geometry_manifest_path(&app_handle, project_id)?;
    let bytes = stdfs::read(&path).map_err(|e| format!("读取 GLB manifest 失败: {}", e))?;
    serde_json::from_slice::<GeometryCacheManifest>(&bytes)
        .map_err(|e| format!("解析 GLB manifest 失败: {}", e))
}

pub(super) fn check_geometry_cache_manifest(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    source_sha256: &str,
) -> bool {
    let _timing = ValidationSpan::new("geometry_files");
    let Some(manifest) = load_geometry_cache_manifest(app_handle, project_id) else {
        return false;
    };
    if manifest.source_sha256 != source_sha256 || manifest.entries.len() > 200_000 {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    for entry in manifest.entries {
        if validate_geometry_manifest_entry_shape(&entry, &mut seen).is_err() {
            return false;
        }
        if entry.status == "empty" || entry.status == "unsupported" || entry.status == "source-invalid" {
            // empty/unsupported 都是确定性的合法结果，不存在对应 GLB
            // 文件也不构成 miss。
            continue;
        }
        let Ok(glb_path) = glb_cache_file_path(app_handle, project_id, &entry.entry_path) else {
            return false;
        };
        let Ok(meta) = stdfs::metadata(&glb_path) else {
            return false;
        };
        if meta.len() != entry.size {
            return false;
        }
        // Only inspect the fixed header here. The warm fast path's binary batch
        // read performs the one full-file read and repeats size/header checks
        // on the returned bytes before parsing.
        if !validate_glb_file_header(&glb_path, entry.size) {
            return false;
        }
    }
    true
}

/// 写入 GLB manifest（版本标记之前的最后一步）。
#[tauri::command]
pub fn write_geometry_cache_manifest(
    app_handle: tauri::AppHandle,
    project_id: i64,
    source_sha256: String,
    entries: Vec<GeometryCacheManifestEntry>,
) -> Result<String, String> {
    if source_sha256.trim().is_empty() || source_sha256.len() > 128 {
        return Err("source_sha256 无效".to_string());
    }
    if entries.len() > 200_000 {
        return Err("GLB manifest 条目数超限".to_string());
    }
    {
        let state = app_handle.state::<DbState>();
        let guard = state
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
        ensure_project_source_sha(&guard, project_id, Some(&source_sha256))?;
    }
    let mut seen = std::collections::HashSet::new();
    for entry in &entries {
        if let Err(error) = validate_geometry_manifest_entry_shape(entry, &mut seen) {
            return Err(error);
        }
        if entry.status == "empty" || entry.status == "unsupported" || entry.status == "source-invalid" {
            // empty/unsupported 为确定性 tombstone：不要求磁盘上存在零
            // 字节占位文件。
            continue;
        }
        let path = glb_cache_file_path(&app_handle, project_id, &entry.entry_path)?;
        let meta =
            stdfs::metadata(&path).map_err(|e| format!("读取 GLB manifest 条目失败: {}", e))?;
        if meta.len() != entry.size {
            return Err(format!("GLB 大小与 manifest 不一致: {}", entry.entry_path));
        }
        let glb = stdfs::read(&path).map_err(|e| format!("读取 GLB 失败: {}", e))?;
        if !validate_glb_bytes(&glb) {
            return Err(format!(
                "GLB magic/version/length 校验失败: {}",
                entry.entry_path
            ));
        }
    }
    let path = geometry_manifest_path(&app_handle, project_id).or_else(|_| {
        let base = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
        let root = base.join("glbcache").join(project_id.to_string());
        stdfs::create_dir_all(&root).map_err(|e| format!("创建 GLB 目录失败: {}", e))?;
        reject_link(&root, " GLB")?;
        Ok::<PathBuf, String>(root.join("_manifest.json"))
    })?;
    let bytes = serde_json::to_vec(&GeometryCacheManifest {
        source_sha256,
        entries,
    })
    .map_err(|e| format!("序列化 GLB manifest 失败: {}", e))?;
    atomic_write(&path, &bytes, " GLB manifest")?;
    Ok(path.to_string_lossy().to_string())
}

/// Tauri command：只失效一个 DEV 的 GLB 与 manifest 条目。
///
/// 该命令用于 warm fast path 解析失败后的定向恢复。manifest 先以原子
/// 替换方式移除条目，再删除对应文件；任何中间失败都不会把坏 GLB
/// 重新宣传为有效缓存。其它 DEV 条目、SQLite 语义索引和 IFC 缓存不受影响。
#[tauri::command]
pub fn invalidate_glb_cache_entry(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
    source_sha256: Option<String>,
) -> Result<(), String> {
    ensure_cache_project_id(project_id)?;
    let normalized = normalize_cache_lookup_path(&entry_path);
    if !normalized.ends_with(".dev") {
        return Err("GLB 单项失效只允许 DEV 条目".to_string());
    }
    validate_entry_path(&entry_path)?;
    {
        let state = app_handle.state::<DbState>();
        let guard = state
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
        ensure_project_source_sha(&guard, project_id, source_sha256.as_deref())?;
    }

    let manifest_path = geometry_manifest_path(&app_handle, project_id).ok();
    if let Some(path) = manifest_path.as_ref() {
        if path.exists() {
            let bytes = stdfs::read(path).map_err(|e| format!("读取 GLB manifest 失败: {}", e))?;
            let mut manifest = serde_json::from_slice::<GeometryCacheManifest>(&bytes)
                .map_err(|e| format!("解析 GLB manifest 失败: {}", e))?;
            if let Some(expected) = source_sha256.as_deref() {
                if manifest.source_sha256 != expected {
                    return Err("GLB manifest source SHA 与当前工程不一致".to_string());
                }
            }
            let mut seen = HashSet::new();
            for entry in &manifest.entries {
                validate_geometry_manifest_entry_shape(entry, &mut seen)?;
            }
            manifest.entries.retain(|entry| {
                normalize_cache_lookup_path(&entry.entry_path) != normalized
            });
            let updated = serde_json::to_vec(&manifest)
                .map_err(|e| format!("序列化 GLB manifest 失败: {}", e))?;
            atomic_write(path, &updated, " GLB manifest")?;
        }
    }

    let glb_path = glb_cache_file_path(&app_handle, project_id, &entry_path)?;
    match stdfs::remove_file(&glb_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("删除 DEV GLB 缓存失败: {}", error)),
    }
    Ok(())
}

/// Tauri command：写入 GLB 几何缓存版本标记文件。
///
/// 在 `cacheGlbFiles` 完成所有 MOD/STL → .glb 序列化后调用一次，
/// 把当前 GEOMETRY_CACHE_VERSION 写入 `{app_data_dir}/glbcache/{project_id}/_version.txt`。
/// 下次 `validate_gim_cache` 时读取此文件并比较，版本不匹配只使 geometry
/// domain 失效，由前端重建 DEV GLB。
#[tauri::command]
pub fn write_geometry_cache_version(
    app_handle: tauri::AppHandle,
    project_id: i64,
    source_sha256: Option<String>,
) -> Result<String, String> {
    ensure_cache_project_id(project_id)?;
    {
        let state = app_handle.state::<DbState>();
        let guard = state
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&guard, project_id)?;
        // The marker is the final geometry-cache commit. Re-check the source
        // identity here as well as during manifest/GLB writes so a delayed
        // task cannot publish a current-version marker for a different GIM.
        ensure_project_source_sha(&guard, project_id, source_sha256.as_deref())?;
    }
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    let dir = base.join("glbcache").join(project_id.to_string());
    if !dir.exists() {
        stdfs::create_dir_all(&dir).map_err(|e| format!("创建 glbcache 目录失败: {}", e))?;
    }
    reject_link(&dir, " GLB")?;
    let marker = dir.join("_version.txt");
    reject_link(&marker, "版本标记")?;
    atomic_write(&marker, GEOMETRY_CACHE_VERSION.as_bytes(), "版本标记")?;
    Ok(marker.to_string_lossy().to_string())
}
