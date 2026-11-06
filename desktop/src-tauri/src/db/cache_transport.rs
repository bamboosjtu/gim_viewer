//! Raw binary IPC envelopes and authorized cached-source reads.

use std::fs as stdfs;
use std::time::Instant;
use tauri::Manager;
use super::cache_paths::{
    BatchCachePathResolver,
    atomic_write,
    cache_file_path,
    cache_project_root_for_batch,
};
use super::cache_protocol::{
    BatchCacheFileResult,

    decode_binary_cache_write_request,
    encode_batch_cache_response,
};
use super::projects::{ensure_project_exists, ensure_project_source_sha};
use super::{DbState};
use super::semantic_pack::{
    read_line_semantic_pack_entry,
    read_substation_pack_bytes,
    read_substation_pack_entry,
    substation_pack_index,
    substation_pack_len,
};

/// Tauri command：以 Raw IPC 写入缓存文件，避免 Vec<u8> JSON 数字数组膨胀。
#[tauri::command]
pub fn write_cache_file_binary(
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
    // Derived semantic snapshots also run in background.  Bind the raw file
    // write to the captured source identity while the project row is locked,
    // matching the GLB/Fragments cache write contract.  A stale A→B task must
    // not overwrite the cache directory for the newer source.
    ensure_project_source_sha(
        &guard,
        meta.project_id,
        meta.source_gim_sha256.as_deref(),
    )?;
    drop(guard);
    let path = cache_file_path(&app_handle, meta.project_id, &meta.entry_path)?;
    atomic_write(&path, &bytes, "")?;
    Ok(path.to_string_lossy().to_string())
}

/// Tauri command：读取缓存的 IFC 文件（路径由 project_id + entry_path 计算，不接受任意路径）
#[tauri::command]
pub async fn read_cached_ifc(
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
    let path = cache_file_path(&app_handle, project_id, &entry_path)?;
    let bytes = stdfs::read(&path).map_err(|e| format!("读取缓存文件失败: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Tauri command：读取 extracted/{project_id} 下的任意 GIM 条目。
///
/// 与 read_cached_ifc 相同，目标路径只由 project_id + entry_path 计算，
/// 不接受前端传入的绝对路径，供原生解压后的磁盘懒读 File 适配器使用。
#[tauri::command]
pub async fn read_cached_entry(
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
    let path = cache_file_path(&app_handle, project_id, &entry_path)?;
    let bytes = match stdfs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // 线路原生解压会把 parser 文本放入连续 semantic pack，避免数万
            // 个小文件 open。source/几何查看仍沿用原来的单条 API；只有
            // pack-backed 条目才在这里按 offset 懒读，普通缓存行为不变。
            let root = cache_project_root_for_batch(&app_handle, project_id)?;
            if let Some(bytes) = read_line_semantic_pack_entry(&root, &entry_path).ok().flatten() {
                bytes
            } else if let Some(bytes) = read_substation_pack_entry(&root, &entry_path) {
                // 变电原生解压把 CBM/DEV/FAM/PHM/MOD/STL 放进同一个 pack，
                // 只有 IFC 保留独立文件；这里按 offset 懒读同样的条目。
                bytes
            } else {
                return Err(format!("读取缓存条目失败: {}", error));
            }
        }
        Err(error) => return Err(format!("读取缓存条目失败: {}", error)),
    };
    Ok(tauri::ipc::Response::new(bytes))
}

/// Tauri command：批量读取缓存文件（一次 IPC 替代 N 次 read_cached_ifc）。
///
/// 用于缓存命中时批量加载 DEV/PHM/MOD/STL 文件，避免数千次 IPC 往返。
/// 单个文件读取失败不影响其他文件（对应 item.bytes = null）。
#[tauri::command]
pub async fn batch_read_cached_files(
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
    if entry_paths.len() > gim_native_core::extraction_limits().max_entries {
        return Err("批量读取缓存文件数量超过安全上限".to_string());
    }
    // 同一批次共享 project 根目录；逐条只做相对路径和 reparse-point
    // 检查，避免重复 app_data_dir/canonicalize 带来的秒级开销。
    let batch_root = cache_project_root_for_batch(&app_handle, project_id)?;
    let mut path_resolver = BatchCachePathResolver::new(&batch_root)?;
    // 变电原生解压把非 IFC 条目写入连续 pack；命中该 pack 时整批只 open 一次，
    // 避免对两万多个语义文本条目逐个 open（冷启动的主要写/读成本）。
    let substation_index = substation_pack_index(&batch_root).ok();
    let substation_pack_len = substation_pack_len(&batch_root);
    let mut substation_pack_file: Option<stdfs::File> = None;
    let read_substation = |entry_path: &str,
                           pack_file: &mut Option<stdfs::File>|
     -> Option<Vec<u8>> {
        match (substation_index.as_deref(), substation_pack_len) {
            (Some(index), Some(pack_len)) => read_substation_pack_bytes(
                &batch_root,
                index,
                pack_len,
                pack_file,
                entry_path,
            ),
            _ => None,
        }
    };
    let mut results = Vec::with_capacity(entry_paths.len());
    let mut total_bytes: u64 = 0;
    let mut resolve_ms = 0.0_f64;
    let mut read_ms = 0.0_f64;
    let mut hit_count: u32 = 0;
    for entry_path in &entry_paths {
        // pack 成员直接按索引区间读取，跳过逐条路径拼接与 reparse 检查；
        // 非 pack 条目（IFC 或旧缓存）仍走原有的受限路径解析。
        if let Some(bytes) = read_substation(entry_path, &mut substation_pack_file) {
            hit_count = hit_count.saturating_add(1);
            total_bytes = total_bytes
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| "批量读取缓存文件总量溢出".to_string())?;
            if total_bytes > gim_native_core::extraction_limits().max_total_uncompressed_bytes {
                return Err("批量读取缓存文件总量超过安全上限".to_string());
            }
            results.push(BatchCacheFileResult {
                entry_path: entry_path.clone(),
                bytes: Some(bytes),
            });
            continue;
        }
        let resolve_started = Instant::now();
        let path = match path_resolver.resolve(entry_path) {
            Ok(p) => p,
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
        let bytes = stdfs::read(&path)
            .ok()
            .or_else(|| read_substation(entry_path, &mut substation_pack_file));
        read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
        if let Some(ref data) = bytes {
            hit_count = hit_count.saturating_add(1);
            total_bytes = total_bytes
                .checked_add(data.len() as u64)
                .ok_or_else(|| "批量读取缓存文件总量溢出".to_string())?;
            if total_bytes > gim_native_core::extraction_limits().max_total_uncompressed_bytes {
                return Err("批量读取缓存文件总量超过安全上限".to_string());
            }
        }
        results.push(BatchCacheFileResult {
            entry_path: entry_path.clone(),
            bytes,
        });
    }
    // GIMR v2：在原有 item 列表前附加 Rust 内部阶段计时。旧 WebView
    // 仍可解析 v1；新 WebView 只把这些字段写入 perfTimings，不改变业务 Map API。
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
