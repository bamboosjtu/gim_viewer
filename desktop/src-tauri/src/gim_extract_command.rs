//! acc-plan P0-2/P1 评审 #4：Tauri 命令——原生解压 .gim 归档。
//!
//! 返回二进制 payload（tauri::ipc::Response，前端 invoke 收到 ArrayBuffer）：
//!
//! ```text
//! [u32 LE manifest 长度][manifest JSON][条目数据 blob]
//! ```
//!
//! manifest JSON：`{ magic, projectId?, projectName?, entries: [{path, offset, size, cachePath?}] }`
//!
//! P1 评审 #4 加固：spawn_blocking + 资源配额 + u64 checked 算术。
//! P2 修复：传入 project_id 时，解压产物直接写入 SQLite 缓存目录
//! （app_data_dir/extracted/{project_id}/），前端无需再通过 IPC 逐文件
//! 回传字节（原 writeCacheFile 用 Array.from(bytes) 走 JSON IPC，
//! 数百 MB IFC 会导致主线程长时间阻塞甚至假死）。

use serde::Serialize;

use crate::db::{atomic_write, cache_file_path, ensure_project_exists, DbState};
use crate::gim_extract::{extract_from_bytes_with_quota, ExtractionQuota};
use crate::{require_authorized_path, AuthorizedFilePaths};

#[derive(Serialize)]
struct ExtractedEntryMeta {
    path: String,
    offset: u64,
    size: u64,
    /// 已落盘的缓存绝对路径（传入 project_id 时填充）
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_path: Option<String>,
}

#[derive(Serialize)]
struct ExtractManifest {
    magic: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    entries: Vec<ExtractedEntryMeta>,
}

/// 解压 .gim 文件（Rust 原生 7z/ZIP），返回二进制 payload。
///
/// - `project_id` 非空时，所有条目同步写入 SQLite 缓存目录并回传 cache_path，
///   前端跳过逐文件 IPC 字节回传（原 writeCacheFile Array.from 路径）。
/// - 失败场景（非 GIM、不支持的压缩格式、超资源配额等）返回 Err 字符串，
///   前端捕获后回退 libarchive.js WASM 路径。
#[tauri::command]
pub async fn extract_gim_archive(
    app_handle: tauri::AppHandle,
    access: tauri::State<'_, AuthorizedFilePaths>,
    db_state: tauri::State<'_, DbState>,
    file_path: String,
    project_id: Option<i64>,
) -> Result<tauri::ipc::Response, String> {
    let authorized_path = require_authorized_path(&access, &file_path, Some("gim"))?;
    let metadata = std::fs::metadata(&authorized_path)
        .map_err(|e| format!("读取 GIM 文件元信息失败: {}", e))?;
    let quota = ExtractionQuota::default();
    if metadata.len() > quota.max_archive_bytes {
        return Err(format!(
            "解压终止（超出资源配额）: GIM 文件大小 {} 超限（>{})",
            metadata.len(),
            quota.max_archive_bytes
        ));
    }
    if let Some(pid) = project_id {
        let conn = db_state
            .0
            .lock()
            .map_err(|e| format!("获取数据库锁失败: {}", e))?;
        ensure_project_exists(&conn, pid)?;
    }
    let data = std::fs::read(&authorized_path).map_err(|e| format!("读取 GIM 文件失败: {}", e))?;

    // 解压是 CPU 密集型同步操作（7z LZMA 可达数秒），放入阻塞线程池
    let payload = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let extracted = extract_from_bytes_with_quota(&data, &quota)?;
        build_payload(app_handle, extracted, project_id)
    })
    .await
    .map_err(|e| format!("解压任务执行失败: {}", e))??;

    Ok(tauri::ipc::Response::new(payload))
}

/// 组装 [manifest 长度][manifest JSON][blob] 二进制输出。
///
/// 逐条目把字节追加进 blob 后立即释放；offset/size 全程 u64 + checked 算术。
/// project_id 非空时同步写缓存目录（磁盘顺序写，远快于 IPC 字节泵）。
fn build_payload(
    app_handle: tauri::AppHandle,
    mut extracted: crate::gim_extract::ExtractedArchive,
    project_id: Option<i64>,
) -> Result<Vec<u8>, String> {
    let mut blob: Vec<u8> = Vec::with_capacity(1 << 20); // 初始 1MB，随需增长
    let mut metas: Vec<ExtractedEntryMeta> = Vec::with_capacity(extracted.entries.len());

    for (path, bytes) in std::mem::take(&mut extracted.entries).into_iter() {
        let offset = u64::try_from(blob.len()).map_err(|e| format!("blob 偏移溢出: {}", e))?;
        let size = u64::try_from(bytes.len()).map_err(|e| format!("条目大小溢出: {}", e))?;

        // 直接写缓存目录（复用缓存路径与穿越校验逻辑）
        let cache_path = match project_id {
            Some(pid) => match cache_file_path(&app_handle, pid, &path) {
                Ok(dest) => {
                    atomic_write(&dest, &bytes, " 原生解压")?;
                    Some(dest.to_string_lossy().to_string())
                }
                Err(e) => return Err(format!("原生解压缓存路径解析失败: {} — {}", path, e)),
            },
            None => None,
        };

        metas.push(ExtractedEntryMeta {
            path,
            offset,
            size,
            cache_path,
        });
        blob.extend_from_slice(&bytes);
        // bytes 在此 drop，内存峰值 ≈ max(单文件) 而非全部条目之和的副本
    }

    let manifest = serde_json::to_vec(&ExtractManifest {
        magic: extracted.magic,
        project_id: extracted.project_id,
        project_name: extracted.project_name,
        entries: metas,
    })
    .map_err(|e| format!("序列化清单失败: {}", e))?;

    let manifest_len = u32::try_from(manifest.len()).map_err(|e| format!("清单长度溢出: {}", e))?;

    let mut out = Vec::with_capacity(4 + manifest.len() + blob.len());
    out.extend_from_slice(&manifest_len.to_le_bytes());
    out.extend_from_slice(&manifest);
    out.append(&mut blob); // move 而非拷贝，省一次大内存复制
    Ok(out)
}
