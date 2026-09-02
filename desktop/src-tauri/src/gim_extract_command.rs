//! acc-plan P0-2/P1 评审 #4：Tauri 命令——原生解压 .gim 归档。
//!
//! 返回二进制 payload（tauri::ipc::Response，前端 invoke 收到 ArrayBuffer）：
//!
//! ```text
//! [u32 LE manifest 长度][manifest JSON][可选条目数据 blob]
//! ```
//!
//! manifest JSON：`{ magic, projectId?, projectName?, entries: [{path, offset, size, cachePath?}] }`
//!
//! P1 评审 #4 加固：spawn_blocking + 资源配额 + u64 checked 算术。
//! P0 修复：传入 project_id 时从磁盘读取 GIM，逐条解压并直接写入
//! SQLite 缓存目录（app_data_dir/extracted/{project_id}/），前端只接收
//! manifest；不会构造完整解压 Vec，也不会通过 IPC 回传条目字节。

use serde::Serialize;
use std::path::Path;

use crate::db::{
    atomic_write, cache_file_path, commit_cache_staging, create_cache_staging_dir,
    ensure_project_exists, remove_cache_dir_if_safe, CacheStagingWriter, DbState,
    LineSemanticPackEntry, LineSemanticPackWriter, LINE_SEMANTIC_PACK_FILE,
};
use crate::gim_extract::{
    extract_from_bytes_with_quota, extract_from_path_with_quota_profile, ExtractionMetadata,
    ExtractionProfile, ExtractionQuota,
};
use crate::{require_authorized_path, AuthorizedFilePaths};

#[derive(Serialize, Clone)]
struct ExtractedEntryMeta {
    path: String,
    offset: u64,
    size: u64,
    /// 已落盘的缓存绝对路径（传入 project_id 时填充）
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_path: Option<String>,
    /// 线路语义 pack 中的偏移；存在时不再创建同名小文件。
    #[serde(skip_serializing_if = "Option::is_none")]
    semantic_pack_offset: Option<u64>,
}

#[derive(Serialize)]
struct ExtractManifest {
    magic: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    entries: Vec<ExtractedEntryMeta>,
    /// 线路 semantic pack 的相对文件名。条目自身通过 semantic_pack_offset
    /// 指向数据区；非线路/旧 payload 不携带此字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    semantic_pack_path: Option<String>,
    /// 原生磁盘优先路径的 Rust 阶段计时；inline 兼容 payload 可省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<ExtractionProfile>,
}

/// 线路 parser 需要的文本文件上限。CBM/DEV/FAM/PHM 通常是小文本；MOD
/// 中只有小型文本族（例如包含 CROSS CODE 的文件）需要进入 parser，较大
/// MOD/STL 仍以独立文件保存，避免把几何复制进 semantic pack。
const LINE_SEMANTIC_MAX_ENTRY_BYTES: usize = 8 * 1024 * 1024;
const LINE_SEMANTIC_MAX_MOD_BYTES: usize = 256 * 1024;

fn is_line_semantic_entry(path: &str, size: usize) -> bool {
    if size > LINE_SEMANTIC_MAX_ENTRY_BYTES {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".mod") {
        size <= LINE_SEMANTIC_MAX_MOD_BYTES
    } else {
        lower.ends_with(".cbm")
            || lower.ends_with(".dev")
            || lower.ends_with(".fam")
            || lower.ends_with(".phm")
    }
}

/// 解压 .gim 文件（Rust 原生 7z/ZIP），返回二进制 payload。
///
/// - `project_id` 非空时，从磁盘流式读取并将所有条目同步写入 SQLite 缓存目录，
///   回传 manifest/cache_path；前端跳过逐文件 IPC 字节回传。
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
    // 解压是 CPU 密集型同步操作（7z LZMA 可达数秒），放入阻塞线程池。
    // 带 project_id 的生产路径使用磁盘优先实现：只读头部窗口，逐条解压并
    // 原子写入 extracted/{project_id}，IPC 只返回 manifest。无 project_id
    // 的兼容调用保留旧的 inline payload 行为。
    // GIMPKGT 头部已经足以确定线路语义 pack；只额外读取 7 个字节，避免
    // 等待完整归档后才决定是否可以跳过数万次小文本文件 open。
    let line_pack_enabled = if project_id.is_some() {
        let mut magic = [0u8; 7];
        match std::fs::File::open(&authorized_path).and_then(|mut file| {
            use std::io::Read as _;
            file.read_exact(&mut magic)
        }) {
            Ok(()) => magic == *b"GIMPKGT",
            Err(_) => false,
        }
    } else {
        false
    };
    let payload = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        if let Some(pid) = project_id {
            let mut metas: Vec<ExtractedEntryMeta> = Vec::new();
            // 从 staging 创建开始计时，profile.total_ms 与外层 native
            // 解压 span 的冷启动范围一致（不含 command 入参校验/线程池排队）。
            let command_started = std::time::Instant::now();
            let (final_root, staging_root) = create_cache_staging_dir(&app_handle, pid)?;
            let mut staging_writer = match CacheStagingWriter::new(&staging_root) {
                Ok(writer) => writer,
                Err(error) => {
                    let _ = remove_cache_dir_if_safe(&staging_root, " staging");
                    return Err(error);
                }
            };
            let mut semantic_writer: Option<LineSemanticPackWriter> = None;
            let mut write_open_ms = 0.0_f64;
            let mut write_data_ms = 0.0_f64;
            let mut semantic_pack_write_ms = 0.0_f64;
            let extraction = extract_from_path_with_quota_profile(&authorized_path, &quota, |path, bytes| {
                let size = u64::try_from(bytes.len())
                    .map_err(|e| format!("条目大小溢出: {} — {}", path, e))?;
                let semantic_pack_offset = if line_pack_enabled && is_line_semantic_entry(&path, bytes.len()) {
                    if semantic_writer.is_none() {
                        semantic_writer = Some(LineSemanticPackWriter::new(&staging_root)?);
                    }
                    let writer = semantic_writer.as_mut().expect("semantic writer just created");
                    let timing = writer.append_with_timing(&path, &bytes)?;
                    semantic_pack_write_ms += timing.data_ms;
                    writer.last_entry().map(|entry| entry.offset)
                } else {
                    None
                };
                if semantic_pack_offset.is_none() {
                    let write_timing = staging_writer.write_with_timing(&path, &bytes)?;
                    write_open_ms += write_timing.open_ms;
                    write_data_ms += write_timing.data_ms;
                }
                // path 已由 extract_archive_reader + CacheStagingWriter 做过
                // 同一套 Normal 组件校验；此处只拼接最终目录，不再次触发磁盘
                // canonicalize/rename，避免数万条目重复路径解析。
                // 只有变电 IFC 索引需要绝对 local_cache_path。线路 semantic
                // pack 条目通过 project_id + entry_path 读取，省去数万条
                // 绝对路径字符串和不必要的 manifest 序列化成本。
                let cache_path = if path.to_ascii_lowercase().ends_with(".ifc") {
                    Some(final_root.join(Path::new(&path)).to_string_lossy().to_string())
                } else {
                    None
                };
                metas.push(ExtractedEntryMeta {
                    path,
                    offset: 0,
                    size,
                    cache_path,
                    semantic_pack_offset,
                });
                Ok(())
            });
            let (info, mut profile) = match extraction {
                Ok(result) => result,
                Err(error) => {
                    drop(semantic_writer);
                    let _ = remove_cache_dir_if_safe(&staging_root, " staging");
                    return Err(error);
                }
            };
            profile.write_open_ms = write_open_ms;
            profile.write_data_ms = write_data_ms;
            let semantic_pack_entries = if let Some(writer) = semantic_writer {
                let entries = match writer.finish() {
                    Ok(entries) => entries,
                    Err(error) => {
                        let _ = remove_cache_dir_if_safe(&staging_root, " staging");
                        return Err(error);
                    }
                };
                profile.semantic_pack_entries = entries.len();
                profile.semantic_pack_bytes = entries.iter().map(|entry| entry.size).sum();
                profile.semantic_pack_write_ms = semantic_pack_write_ms;
                entries
            } else {
                Vec::<LineSemanticPackEntry>::new()
            };
            let commit_started = std::time::Instant::now();
            if let Err(error) = commit_cache_staging(&app_handle, pid, &staging_root) {
                let _ = remove_cache_dir_if_safe(&staging_root, " staging");
                return Err(error);
            }
            profile.commit_ms = commit_started.elapsed().as_secs_f64() * 1000.0;
            profile.write_mode = Some("staging-directory".to_string());
            build_manifest_payload(
                info,
                metas,
                if semantic_pack_entries.is_empty() {
                    None
                } else {
                    Some(LINE_SEMANTIC_PACK_FILE.to_string())
                },
                Some(profile),
                command_started,
            )
        } else {
            let data =
                std::fs::read(&authorized_path).map_err(|e| format!("读取 GIM 文件失败: {}", e))?;
            let extracted = extract_from_bytes_with_quota(&data, &quota)?;
            build_payload(app_handle, extracted, None)
        }
    })
    .await
    .map_err(|e| format!("解压任务执行失败: {}", e))??;

    Ok(tauri::ipc::Response::new(payload))
}

/// 组装磁盘优先路径的 manifest。没有条目 blob，前端只创建延迟读取的
/// File 兼容对象；真正内容由 read_cached_entry 按需获取。
fn build_manifest_payload(
    info: ExtractionMetadata,
    entries: Vec<ExtractedEntryMeta>,
    semantic_pack_path: Option<String>,
    mut profile: Option<ExtractionProfile>,
    command_started: std::time::Instant,
) -> Result<Vec<u8>, String> {
    // 先以零值 profile 序列化一次，测出 manifest 的实际组装耗时；再把
    // 计时写回 manifest。使用借用视图，避免为第二次序列化复制数万条
    // entry 元数据（这部分虽不是解压字节，但会放大冷启动峰值）。
    let manifest_started = std::time::Instant::now();
    #[derive(Serialize)]
    struct ManifestView<'a> {
        magic: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_id: Option<&'a String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_name: Option<&'a String>,
        entries: &'a [ExtractedEntryMeta],
        #[serde(skip_serializing_if = "Option::is_none")]
        semantic_pack_path: Option<&'a String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        profile: Option<&'a ExtractionProfile>,
    }
    let manifest_without_profile = serde_json::to_vec(&ManifestView {
        magic: &info.magic,
        project_id: info.project_id.as_ref(),
        project_name: info.project_name.as_ref(),
        entries: &entries,
        semantic_pack_path: semantic_pack_path.as_ref(),
        profile: None,
    })
    .map_err(|e| format!("序列化清单失败: {}", e))?;
    if let Some(ref mut p) = profile {
        p.manifest_ms = manifest_started.elapsed().as_secs_f64() * 1000.0;
        p.total_ms = command_started.elapsed().as_secs_f64() * 1000.0;
    }
    let manifest = if let Some(ref profile_ref) = profile {
        serde_json::to_vec(&ManifestView {
            magic: &info.magic,
            project_id: info.project_id.as_ref(),
            project_name: info.project_name.as_ref(),
            entries: &entries,
            semantic_pack_path: semantic_pack_path.as_ref(),
            profile: Some(profile_ref),
        })
        .map_err(|e| format!("序列化清单失败: {}", e))?
    } else { manifest_without_profile };
    let manifest_len = u32::try_from(manifest.len()).map_err(|e| format!("清单长度溢出: {}", e))?;
    let mut out = Vec::with_capacity(4 + manifest.len());
    out.extend_from_slice(&manifest_len.to_le_bytes());
    out.extend_from_slice(&manifest);
    Ok(out)
}

/// 组装 [manifest 长度][manifest JSON][可选 blob] 二进制输出。
///
/// project_id 非空时同步写缓存目录，只回传 manifest，不再把解压字节拼回 IPC
/// blob；前端通过 read_cached_entry 按需读取。无 project_id 的独立调用保留
/// inline blob 兼容性（主要用于浏览器/诊断测试）。offset/size 全程 u64。
fn build_payload(
    app_handle: tauri::AppHandle,
    mut extracted: crate::gim_extract::ExtractedArchive,
    project_id: Option<i64>,
) -> Result<Vec<u8>, String> {
    let disk_first = project_id.is_some();
    let mut blob: Vec<u8> = if disk_first {
        Vec::new()
    } else {
        Vec::with_capacity(1 << 20)
    };
    let mut metas: Vec<ExtractedEntryMeta> = Vec::with_capacity(extracted.entries.len());

    for (path, bytes) in std::mem::take(&mut extracted.entries).into_iter() {
        let offset = if disk_first {
            0
        } else {
            u64::try_from(blob.len()).map_err(|e| format!("blob 偏移溢出: {}", e))?
        };
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
            semantic_pack_offset: None,
        });
        if !disk_first {
            blob.extend_from_slice(&bytes);
        }
        // bytes 在此 drop；磁盘优先模式不会再创建第二份全量 IPC blob。
    }

    let manifest = serde_json::to_vec(&ExtractManifest {
        magic: extracted.magic,
        project_id: extracted.project_id,
        project_name: extracted.project_name,
        entries: metas,
        semantic_pack_path: None,
        profile: None,
    })
    .map_err(|e| format!("序列化清单失败: {}", e))?;

    let manifest_len = u32::try_from(manifest.len()).map_err(|e| format!("清单长度溢出: {}", e))?;

    let mut out = Vec::with_capacity(4 + manifest.len() + blob.len());
    out.extend_from_slice(&manifest_len.to_le_bytes());
    out.extend_from_slice(&manifest);
    out.append(&mut blob); // move 而非拷贝，省一次大内存复制
    Ok(out)
}
