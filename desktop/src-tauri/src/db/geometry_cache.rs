//! Source-bound device LOD artifacts and bounded native transport.

use super::cache_paths::{
    ensure_cache_parent, ensure_cache_project_id, reject_link, BatchCachePathResolver,
};
use super::cache_protocol::{
    decode_binary_cache_write_request, encode_batch_cache_response, BatchCacheFileResult,
    BinaryCacheWriteMeta,
};
use super::projects::ensure_project_source_sha;
use super::{DbState, GEOMETRY_CACHE_VERSION};
pub use gim_native_core::DeviceLodWriteTiming;
use gim_native_core::{NativeError, NativeErrorCode};
use sha2::Digest;
use std::collections::HashMap;
use std::fs as stdfs;
use std::path::PathBuf;
use std::time::Instant;
use tauri::Manager;

/// Per-template derived domain; publication is independent of whole-project geometry.
fn validate_device_lod_entry<'a>(
    entry: &'a str,
    source_sha: &str,
) -> Result<(&'a str, String), NativeError> {
    let (store, key) = entry.split_once('/').ok_or("设备缓存键缺少域")?;
    let parts: Vec<&str> = key.split('|').collect();
    let bound_sha = match store {
        "templates" if parts.len() == 4 && parts[0] == GEOMETRY_CACHE_VERSION => parts[1],
        "catalog"
            if parts.len() == 4
                && parts[0] == "dev-spatial-catalog-v1"
                && parts[1] == GEOMETRY_CACHE_VERSION =>
        {
            parts[2]
        }
        _ => return Err("设备缓存域或版本无效".into()),
    };
    if source_sha.len() != 64
        || !source_sha.bytes().all(|c| c.is_ascii_hexdigit())
        || bound_sha != source_sha
    {
        return Err("设备缓存源身份不匹配".into());
    }
    Ok((store, format!("{:x}", sha2::Sha256::digest(key.as_bytes()))))
}

const DEVICE_ARTIFACT_MAX_BYTES: u64 = 128 * 1024 * 1024;

fn read_device_artifact_bytes(file: stdfs::File) -> Result<Vec<u8>, NativeError> {
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(DEVICE_ARTIFACT_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > DEVICE_ARTIFACT_MAX_BYTES {
        return Err("设备缓存单条超过配额".into());
    }
    Ok(bytes)
}

fn device_lod_artifact_path(
    app: &tauri::AppHandle,
    project_id: i64,
    entry: &str,
    source_sha: &str,
) -> Result<PathBuf, NativeError> {
    let (store, digest) = validate_device_lod_entry(entry, source_sha)?;
    let conn = app.state::<DbState>();
    let guard = conn.0.lock().map_err(|e| e.to_string())?;
    ensure_project_source_sha(&guard, project_id, Some(source_sha))?;
    drop(guard);
    let base = crate::application_data_dir(&app)
        .map_err(|e| e.to_string())?
        .join("device-lod");
    if !base.exists() {
        stdfs::create_dir_all(&base).map_err(|e| e.to_string())?;
    }
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
pub async fn read_device_lod_artifacts(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_paths: Vec<String>,
    source_gim_sha256: String,
    max_bytes: Option<u64>,
) -> Result<tauri::ipc::Response, NativeError> {
    tauri::async_runtime::spawn_blocking(move || {
        if entry_paths.is_empty() || entry_paths.len() > 64 {
            return Err("设备缓存批量条目数无效".into());
        }
        let byte_limit = max_bytes.unwrap_or(512 * 1024 * 1024);
        if byte_limit == 0 || byte_limit > 512 * 1024 * 1024 {
            return Err("设备缓存批量字节配额无效".into());
        }
        ensure_cache_project_id(project_id)?;
        let started = Instant::now();
        let validated = entry_paths
            .iter()
            .map(|entry| validate_device_lod_entry(entry, &source_gim_sha256))
            .collect::<Result<Vec<_>, _>>()?;
        {
            let state = app_handle.state::<DbState>();
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            ensure_project_source_sha(&conn, project_id, Some(&source_gim_sha256))?;
        }
        let base = crate::application_data_dir(&app_handle)
            .map_err(|e| e.to_string())?
            .join("device-lod");
        if !base.exists() {
            stdfs::create_dir_all(&base).map_err(|e| e.to_string())?;
        }
        reject_link(&base, "设备派生缓存")?;
        let root = base.canonicalize().map_err(|e| e.to_string())?;
        let mut resolve_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut read_ms = 0.0_f64;
        let mut parents = HashMap::new();
        let mut results = Vec::new();
        let mut total = 0_u64;
        let mut hits = 0_u32;
        for (entry, (store, digest)) in entry_paths.iter().zip(validated) {
            let resolve_started = Instant::now();
            // Reuse canonicalization, not reparse-point trust: recheck mutable directory components per file.
            reject_link(&base, "设备派生缓存")?;
            reject_link(&root.join(project_id.to_string()), "设备派生缓存")?;
            reject_link(
                &root.join(project_id.to_string()).join(store),
                "设备派生缓存",
            )?;
            if !parents.contains_key(store) {
                let parent = ensure_cache_parent(
                    &root,
                    &PathBuf::from(project_id.to_string()).join(store),
                    "设备派生缓存",
                )?;
                parents.insert(store, BatchCachePathResolver::new(&parent)?);
            }
            let path = parents
                .get_mut(store)
                .unwrap()
                .resolve(&format!("{}.bin", digest))?;
            resolve_ms += resolve_started.elapsed().as_secs_f64() * 1000.0;
            let read_started = Instant::now();
            let bytes = match stdfs::File::open(path) {
                Ok(file) => {
                    let size = file.metadata().map_err(|e| e.to_string())?.len();
                    if size > DEVICE_ARTIFACT_MAX_BYTES || size > byte_limit {
                        return Err("设备缓存单条超过配额".into());
                    }
                    if total + size > byte_limit {
                        continue;
                    } // Omitted rows are deferred, never reported as misses.
                    let bytes = read_device_artifact_bytes(file)?;
                    total += bytes.len() as u64;
                    if total > byte_limit {
                        return Err("设备缓存批量超过配额".into());
                    }
                    hits += 1;
                    Some(bytes)
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.to_string().into()),
            };
            read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
            results.push(BatchCacheFileResult {
                entry_path: entry.clone(),
                bytes,
            });
        }
        Ok(tauri::ipc::Response::new(encode_batch_cache_response(
            results, total, hits, read_ms, resolve_ms, started,
        )?))
    })
    .await
    .map_err(|e| {
        NativeError::new(
            NativeErrorCode::Internal,
            format!("设备缓存批量读取失败: {}", e),
        )
    })?
}

#[tauri::command]
pub async fn write_device_lod_artifact(
    app_handle: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<DeviceLodWriteTiming, NativeError> {
    let (meta, bytes) = {
        let ipc_request = request;
        decode_binary_cache_write_request(&ipc_request)?
    };
    tauri::async_runtime::spawn_blocking(move || {
        write_device_lod_artifact_blocking(app_handle, meta, bytes)
    })
    .await
    .map_err(|e| {
        NativeError::new(
            NativeErrorCode::Internal,
            format!("设备缓存后台写入失败: {}", e),
        )
    })?
}

fn write_device_lod_artifact_blocking(
    app_handle: tauri::AppHandle,
    meta: BinaryCacheWriteMeta,
    bytes: Vec<u8>,
) -> Result<DeviceLodWriteTiming, NativeError> {
    if bytes.len() as u64 > DEVICE_ARTIFACT_MAX_BYTES {
        return Err("设备派生缓存超过单条配额".into());
    }
    let source = meta
        .source_gim_sha256
        .as_deref()
        .ok_or("设备缓存缺少源 SHA")?;
    let resolve_started = Instant::now();
    let path = device_lod_artifact_path(&app_handle, meta.project_id, &meta.entry_path, source)?;
    let resolve_ms = resolve_started.elapsed().as_secs_f64() * 1000.0;
    let write_started = Instant::now();
    super::cache_paths::atomic_write_derived(&path, &bytes, "设备派生缓存")?;
    Ok(DeviceLodWriteTiming {
        resolve_ms,
        write_ms: write_started.elapsed().as_secs_f64() * 1000.0,
    })
}

#[tauri::command]
pub async fn delete_device_lod_artifact(
    app_handle: tauri::AppHandle,
    project_id: i64,
    entry_path: String,
    source_gim_sha256: String,
) -> Result<(), NativeError> {
    crate::native_command::blocking("delete_device_lod_artifact", move || {
        let path =
            device_lod_artifact_path(&app_handle, project_id, &entry_path, &source_gim_sha256)?;
        match stdfs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string().into()),
        }
    })
    .await
}

#[cfg(test)]
mod device_lod_key_tests {
    use super::*;
    #[test]
    fn source_bound_keys_accept_only_their_domain_version_and_sha() {
        let sha = "a".repeat(64);
        let template = format!(
            "templates/{}|{}|DEV/x.dev|lod0",
            GEOMETRY_CACHE_VERSION, sha
        );
        let catalog = format!(
            "catalog/dev-spatial-catalog-v1|{}|{}|DEV/x.dev",
            GEOMETRY_CACHE_VERSION, sha
        );
        assert!(validate_device_lod_entry(&template, &sha).is_ok());
        assert!(validate_device_lod_entry(&catalog, &sha).is_ok());
        assert!(validate_device_lod_entry(&template, &"b".repeat(64)).is_err());
        assert!(validate_device_lod_entry(&template.replace("templates/", "../"), &sha).is_err());
        assert!(
            validate_device_lod_entry(&catalog.replace("dev-spatial-catalog-v1", "old"), &sha)
                .is_err()
        );
    }

    #[test]
    fn published_device_bytes_round_trip_through_the_bounded_reader() {
        let sha = "a".repeat(64);
        let key = format!(
            "templates/{}|{}|DEV/unit.dev|lod0",
            GEOMETRY_CACHE_VERSION, sha
        );
        let (_, digest) = validate_device_lod_entry(&key, &sha).unwrap();
        let root =
            crate::workspace_test_temp().join(format!("gim-device-lod-{}", std::process::id()));
        stdfs::create_dir_all(&root).unwrap();
        let path = root.join(format!("{digest}.bin"));
        let payload = b"device LOD artifact";
        super::super::cache_paths::atomic_write_derived(&path, payload, "设备派生缓存").unwrap();
        assert_eq!(
            read_device_artifact_bytes(stdfs::File::open(&path).unwrap()).unwrap(),
            payload
        );
        assert!(validate_device_lod_entry(&key, &"b".repeat(64)).is_err());
        stdfs::remove_file(path).unwrap();
        stdfs::remove_dir(root).unwrap();
    }
}
