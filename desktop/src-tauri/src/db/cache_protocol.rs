//! Shared binary cache request/response envelopes and transfer quotas.

use serde::{Deserialize, Serialize};
use std::time::Instant;

// ===== 缓存文件落盘 =====

/// 二进制缓存写入 IPC 的 envelope：前 9 字节为 `GIMB` + 版本 +
/// little-endian metadata 长度，随后是 JSON metadata 与原始文件字节。
/// 使用 `tauri::ipc::Request` 接收 Raw body，避免把大型文件编码成 JSON 数字数组。
const BINARY_CACHE_REQUEST_MAGIC: &[u8; 4] = b"GIMB";

const BINARY_CACHE_REQUEST_VERSION: u8 = 1;

const BINARY_CACHE_REQUEST_HEADER: usize = 9;

const MAX_BINARY_CACHE_METADATA_BYTES: usize = 16 * 1024;





#[derive(Debug, Deserialize)]
pub(super) struct BinaryCacheWriteMeta {
    pub(super) project_id: i64,
    pub(super) entry_path: String,
    #[serde(default)]
    pub(super) source_gim_sha256: Option<String>,
}

pub(super) fn decode_binary_cache_write_request(
    request: &tauri::ipc::Request<'_>,
) -> Result<(BinaryCacheWriteMeta, Vec<u8>), String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => return Err("缓存写入必须使用二进制 IPC".to_string()),
    };
    if body.len() < BINARY_CACHE_REQUEST_HEADER
        || &body[..4] != BINARY_CACHE_REQUEST_MAGIC
        || body[4] != BINARY_CACHE_REQUEST_VERSION
    {
        return Err("缓存写入二进制 envelope 无效".to_string());
    }
    let metadata_len = u32::from_le_bytes([body[5], body[6], body[7], body[8]]) as usize;
    if metadata_len > MAX_BINARY_CACHE_METADATA_BYTES {
        return Err("缓存写入 metadata 过大".to_string());
    }
    let metadata_start = BINARY_CACHE_REQUEST_HEADER;
    let metadata_end = metadata_start
        .checked_add(metadata_len)
        .ok_or_else(|| "缓存写入 metadata 长度溢出".to_string())?;
    if metadata_end > body.len() {
        return Err("缓存写入 metadata 越界".to_string());
    }
    let meta: BinaryCacheWriteMeta = serde_json::from_slice(&body[metadata_start..metadata_end])
        .map_err(|e| format!("解析缓存写入 metadata 失败: {}", e))?;
    if meta.entry_path.trim().is_empty() {
        return Err("缓存写入 entry_path 不能为空".to_string());
    }
    Ok((meta, body[metadata_end..].to_vec()))
}

/// 批量读取缓存文件的返回项
#[derive(Debug, Serialize)]
pub struct BatchCacheFileResult {
    pub entry_path: String,
    /// 成功时包含文件字节，失败时为 null
    pub bytes: Option<Vec<u8>>,
}

/// 将批量读取结果编码为 GIMR v2 envelope。线路 semantic pack 与普通批量
/// 文件读取共享此编码器，确保 WebView 端只需维护一套 transferable 解析器。
pub(super) fn encode_batch_cache_response(
    results: Vec<BatchCacheFileResult>,
    total_bytes: u64,
    hit_count: u32,
    read_ms: f64,
    resolve_ms: f64,
    total_started: Instant,
) -> Result<Vec<u8>, String> {
    const HEADER_SIZE_V2: usize = 57;
    let encode_started = Instant::now();
    let mut out = Vec::new();
    out.reserve(HEADER_SIZE_V2);
    out.extend_from_slice(b"GIMR");
    out.push(2);
    let count = u32::try_from(results.len()).map_err(|_| "批量读取结果条目数溢出".to_string())?;
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&read_ms.to_le_bytes());
    out.extend_from_slice(&resolve_ms.to_le_bytes());
    // encode_ms/total_ms 在所有 item 写入后回填。
    out.extend_from_slice(&0.0_f64.to_le_bytes());
    out.extend_from_slice(&0.0_f64.to_le_bytes());
    out.extend_from_slice(&total_bytes.to_le_bytes());
    out.extend_from_slice(&hit_count.to_le_bytes());
    out.extend_from_slice(&count.saturating_sub(hit_count).to_le_bytes());
    for item in results {
        let path = item.entry_path.as_bytes();
        let path_len = u32::try_from(path.len()).map_err(|_| "批量读取路径过长".to_string())?;
        out.extend_from_slice(&path_len.to_le_bytes());
        out.extend_from_slice(path);
        match item.bytes {
            Some(bytes) => {
                out.push(1);
                out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
                out.extend_from_slice(&bytes);
            }
            None => {
                out.push(0);
                out.extend_from_slice(&0u64.to_le_bytes());
            }
        }
    }
    let encode_ms = encode_started.elapsed().as_secs_f64() * 1000.0;
    out[25..33].copy_from_slice(&encode_ms.to_le_bytes());
    let total_ms = total_started.elapsed().as_secs_f64() * 1000.0;
    out[33..41].copy_from_slice(&total_ms.to_le_bytes());
    Ok(out)
}
