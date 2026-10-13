//! acc-plan P0-2：GIM 归档原生解压（替代 libarchive.js WASM 路径）。
//!
//! 流程：定位 GIMPKG* 魔数后的压缩数据偏移 → 按签名分发 7z
//! （sevenz-rust）/ ZIP（zip crate）解码 → 逐条交给调用方；兼容测试接口
//! 仍可从字节返回条目集合，生产 Tauri 路径使用磁盘 reader + sink。
//!
//! 与前端 libarchive.js 路径的行为对齐：
//! - 路径分隔符统一为 `/`，剥离 `./` 前缀
//! - 目录条目跳过
//! - 头部文本区按 \0 分割字段（字段 1=项目编号，字段 2=项目名称），
//!   连续 ≥4 个 \0 视为零填充开始

use std::fs::File;
use std::io::{self, Cursor, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Instant;
use serde::Serialize;

/// 解压结果：条目列表（相对路径 + 字节）与头部信息
#[derive(Debug)]
pub struct ExtractedArchive {
    pub entries: Vec<(String, Vec<u8>)>,
    pub magic: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
}

const GIM_PACKAGE_MAGIC: &[u8] = b"GIMPKG";
const SEVENZ_SIG: [u8; 6] = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];
const ZIP_SIG: [u8; 4] = [0x50, 0x4B, 0x03, 0x04];
const SIGNATURE_SEARCH_LIMIT: usize = 1024 * 1024;
const MAX_ENTRY_PATH_BYTES: usize = 4096;

/// 在头部之后搜索压缩数据偏移（先 7z 后 ZIP，1MB 窗口）
fn find_archive_offset(data: &[u8]) -> Option<usize> {
    if data.len() < GIM_PACKAGE_MAGIC.len() || &data[..GIM_PACKAGE_MAGIC.len()] != GIM_PACKAGE_MAGIC
    {
        return None;
    }
    let limit = SIGNATURE_SEARCH_LIMIT.min(data.len());
    let mut i = GIM_PACKAGE_MAGIC.len();
    while i + SEVENZ_SIG.len() <= limit {
        if data[i..i + 6] == SEVENZ_SIG {
            return Some(i);
        }
        i += 1;
    }
    let mut i = GIM_PACKAGE_MAGIC.len();
    while i + ZIP_SIG.len() <= limit {
        if data[i..i + 4] == ZIP_SIG {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// 确定魔数长度（GIMPKGS/GIMPKGT 为 7 字节，基础 GIMPKG 为 6 字节）
fn magic_len(data: &[u8]) -> usize {
    if data.len() >= 7 && (data[6] == b'S' || data[6] == b'T') {
        7
    } else {
        GIM_PACKAGE_MAGIC.len()
    }
}

/// 解析头部文本区字段（项目编号、项目名称）
fn parse_header_fields(data: &[u8], offset: usize) -> (Option<String>, Option<String>) {
    let mlen = magic_len(data);
    if offset <= mlen {
        return (None, None);
    }
    let header = &data[mlen..offset];
    let mut start = 0;
    while start < header.len() && header[start] == 0 {
        start += 1;
    }
    let mut fields: Vec<String> = Vec::new();
    let mut field_start = start;
    let mut i = start;
    while i < header.len() {
        if header[i] == 0 {
            if i > field_start {
                fields.push(
                    String::from_utf8_lossy(&header[field_start..i])
                        .trim()
                        .to_string(),
                );
            }
            field_start = i + 1;
            let mut zero_run = 0usize;
            while field_start < header.len() && header[field_start] == 0 {
                field_start += 1;
                zero_run += 1;
            }
            if zero_run >= 4 {
                break;
            }
        }
        i += 1;
    }
    let pid = fields.first().filter(|s| !s.is_empty()).cloned();
    let pname = fields.get(1).filter(|s| !s.is_empty()).cloned();
    (pid, pname)
}

/// 规范化归档内路径：`\` → `/`，剥离 `./` 前缀
fn normalize_path(name: &str) -> String {
    let mut p = name.replace('\\', "/");
    while p.starts_with("./") {
        p = p[2..].to_string();
    }
    p
}

/// 归档条目路径安全校验。压缩包内路径不应被当作绝对路径或带 `..` 的
/// 文件系统路径；同时限制长度，避免异常长键污染内存/数据库。
fn validate_archive_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > MAX_ENTRY_PATH_BYTES {
        return Err(format!(
            "归档条目路径无效或过长（>{} 字节）",
            MAX_ENTRY_PATH_BYTES
        ));
    }
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\0') {
        return Err(format!("归档条目路径不安全: {}", path));
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(format!("归档条目路径包含盘符: {}", path));
    }
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("归档条目路径包含非法组件: {}", path));
        }
    }
    Ok(())
}

/// 解压资源配额（P1 评审 #4：防压缩炸弹 / 异常大包 / OOM）
#[derive(Debug, Clone)]
pub struct ExtractionQuota {
    /// 输入归档本身的大小上限（解压前）。
    pub max_archive_bytes: u64,
    /// 最大条目数
    pub max_entries: usize,
    /// 单文件解压后大小上限
    pub max_file_bytes: u64,
    /// 全部条目解压总量上限
    pub max_total_uncompressed_bytes: u64,
    /// 压缩比上限（总解压量 / 归档字节数）
    pub max_compression_ratio: u64,
}

impl Default for ExtractionQuota {
    fn default() -> Self {
        Self {
            max_archive_bytes: 2 * 1024 * 1024 * 1024, // 2 GiB
            max_entries: 200_000,
            max_file_bytes: 1024 * 1024 * 1024, // 单文件 1 GiB
            max_total_uncompressed_bytes: 8 * 1024 * 1024 * 1024, // 总量 8 GiB
            max_compression_ratio: 1000,        // 真实 GIM 样本实测 ~12×
        }
    }
}

fn quota_err(msg: String) -> String {
    format!("解压终止（超出资源配额）: {}", msg)
}

/// GIM 头部与归档元数据。原生磁盘路径只返回这部分信息，条目内容由
/// `extract_archive_reader` 逐个交给 sink，不在此结构中累计。
#[derive(Debug, Clone)]
pub struct ExtractionMetadata {
    pub magic: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
}

/// 原生解压阶段计时。该结构随 manifest 返回给 WebView，便于把冷启动中
/// 的归档解码、逐文件写盘和 manifest 组装拆开观察；所有耗时均为 Rust
/// 单调时钟毫秒，不包含前端 IPC 等待。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionProfile {
    /// extract_gim_archive 命令从进入阻塞线程到返回 payload 的总耗时。
    pub total_ms: f64,
    /// 定位归档后逐条解压/写盘的耗时（不含 header 与 manifest 组装）。
    pub archive_ms: f64,
    /// metadata/open/read prefix/parse header 的耗时。
    pub header_ms: f64,
    /// sevenz/zip 解码并读取每个条目字节的累计耗时。
    pub decode_ms: f64,
    /// sink（生产路径为 staging 文件写入）的累计耗时。
    pub write_ms: f64,
    /// staging 文件 OpenOptions/create_new 的累计耗时。
    pub write_open_ms: f64,
    /// staging 文件 write_all 的累计耗时；不含打开文件和目录检查。
    pub write_data_ms: f64,
    /// manifest JSON + envelope 组装耗时。
    pub manifest_ms: f64,
    /// staging 目录改名/替换正式缓存目录耗时。
    pub commit_ms: f64,
    /// 当前写盘策略，生产原生路径为 staging-directory。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_mode: Option<String>,
    /// GIM 输入归档字节数。
    pub archive_bytes: u64,
    /// 成功解压并交给 sink 的文件条目数。
    pub entry_count: usize,
    /// 成功解压的总字节数。
    pub total_bytes: u64,
    /// 线路 semantic pack 中连续写入的条目/字节；非线路或未启用时为 0。
    pub semantic_pack_entries: usize,
    pub semantic_pack_bytes: u64,
    pub semantic_pack_write_ms: f64,
    /// 单条 sink 写入最大耗时及其路径，定位数万小文件中的异常项。
    pub max_entry_write_ms: f64,
    pub max_entry_write_path: Option<String>,
    /// 单条解码/读取最大耗时及其路径。
    pub max_entry_decode_ms: f64,
    pub max_entry_decode_path: Option<String>,
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// 将位于 .gim 文件中间的归档暴露为从 0 开始的 Read + Seek。
/// sevenz-rust/zip 会对归档起点执行相对 seek，不能直接把带 GIM 头部的
/// File 传入 reader。
struct OffsetReader<R> {
    inner: R,
    base: u64,
    len: u64,
    pos: u64,
}

impl<R: Read + Seek> OffsetReader<R> {
    fn new(mut inner: R, base: u64, len: u64) -> io::Result<Self> {
        inner.seek(SeekFrom::Start(base))?;
        Ok(Self {
            inner,
            base,
            len,
            pos: 0,
        })
    }
}

impl<R: Read + Seek> Read for OffsetReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let remaining = self.len.saturating_sub(self.pos);
        if remaining == 0 {
            return Ok(0);
        }
        let max = usize::try_from(remaining).unwrap_or(usize::MAX);
        let read_len = buf.len().min(max);
        let n = self.inner.read(&mut buf[..read_len])?;
        self.pos = self.pos.saturating_add(n as u64);
        Ok(n)
    }
}

impl<R: Read + Seek> Seek for OffsetReader<R> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let target = match from {
            SeekFrom::Start(value) => i128::from(value),
            SeekFrom::Current(value) => i128::from(self.pos) + i128::from(value),
            SeekFrom::End(value) => i128::from(self.len) + i128::from(value),
        };
        if target < 0 || target > i128::from(self.len) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "归档相对 seek 越界",
            ));
        }
        let target = target as u64;
        let absolute = self
            .base
            .checked_add(target)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "归档 seek 溢出"))?;
        self.inner.seek(SeekFrom::Start(absolute))?;
        self.pos = target;
        Ok(target)
    }
}

fn parse_archive_prefix(data: &[u8]) -> Result<(usize, ExtractionMetadata, bool), String> {
    let offset = find_archive_offset(data)
        .ok_or_else(|| "未找到有效的 GIMPKG* 头部或压缩数据签名".to_string())?;
    let (project_id, project_name) = parse_header_fields(data, offset);
    let magic = String::from_utf8_lossy(&data[..magic_len(data)]).to_string();
    let is_sevenz = data[offset..].starts_with(&SEVENZ_SIG);
    Ok((
        offset,
        ExtractionMetadata {
            magic,
            project_id,
            project_name,
        },
        is_sevenz,
    ))
}

fn check_declared_size(
    entry_count: &mut usize,
    total_uncompressed: u64,
    path: &str,
    declared: u64,
    archive_len: u64,
    quota: &ExtractionQuota,
) -> Result<(), String> {
    if *entry_count >= quota.max_entries {
        return Err(quota_err(format!("条目数超限（>{}）", quota.max_entries)));
    }
    if declared > quota.max_file_bytes {
        return Err(quota_err(format!(
            "单文件 {} 解压大小 {} 超限（>{})",
            path, declared, quota.max_file_bytes
        )));
    }
    let declared_total = total_uncompressed
        .checked_add(declared)
        .ok_or_else(|| quota_err("总解压量溢出".to_string()))?;
    if declared_total > quota.max_total_uncompressed_bytes {
        return Err(quota_err(format!(
            "总解压量 {} 超限（>{}）",
            declared_total, quota.max_total_uncompressed_bytes
        )));
    }
    if declared_total > archive_len.saturating_mul(quota.max_compression_ratio) {
        return Err(quota_err(format!(
            "压缩比超限（>{}×，疑似压缩炸弹）",
            quota.max_compression_ratio
        )));
    }
    *entry_count += 1;
    Ok(())
}

fn read_entry_bytes<R: Read + ?Sized>(
    stream: &mut R,
    path: &str,
    declared: u64,
    total_uncompressed: u64,
    archive_len: u64,
    quota: &ExtractionQuota,
) -> Result<(Vec<u8>, u64), String> {
    // 声明大小不可信：限制读取上限，并将预分配封顶，避免恶意条目造成
    // 巨量单次分配。调用方已完成声明大小配额检查。
    let capacity = declared.min(quota.max_file_bytes).min(64 * 1024 * 1024) as usize;
    let mut buf = Vec::with_capacity(capacity);
    stream
        .take(quota.max_file_bytes.saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取条目 {} 失败: {}", path, e))?;
    if buf.len() as u64 > quota.max_file_bytes {
        return Err(quota_err(format!(
            "单文件 {} 实际解压大小超过 {}",
            path, quota.max_file_bytes
        )));
    }
    let actual_total = total_uncompressed
        .checked_add(buf.len() as u64)
        .ok_or_else(|| quota_err("总解压量溢出".to_string()))?;
    if actual_total > quota.max_total_uncompressed_bytes {
        return Err(quota_err(format!(
            "实际总解压量 {} 超限（>{}）",
            actual_total, quota.max_total_uncompressed_bytes
        )));
    }
    if actual_total > archive_len.saturating_mul(quota.max_compression_ratio) {
        return Err(quota_err(format!(
            "实际压缩比超限（>{}×，疑似压缩炸弹）",
            quota.max_compression_ratio
        )));
    }
    Ok((buf, actual_total))
}

struct CancelAwareReader<'a> {
    inner: &'a mut dyn Read,
    cancelled: &'a std::sync::atomic::AtomicBool,
}
impl Read for CancelAwareReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if self.cancelled.load(std::sync::atomic::Ordering::Acquire) {
            // Interrupted is retried by read_to_end; use a terminal error instead.
            return Err(io::Error::new(io::ErrorKind::Other, "extraction cancelled"));
        }
        let limit = bytes.len().min(64 * 1024);
        self.inner.read(&mut bytes[..limit])
    }
}

/// Passive timings emitted after a complete sink write. The default/mobile API
/// supplies no observer and retains its extraction and quota contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionEntryTiming {
    pub path: String,
    pub archive_index: usize,
    pub folder_index: Option<usize>,
    pub physical_order: usize,
    pub size: u64,
    pub decode_ms: f64,
    pub sink_write_ms: f64,
    pub decoded_at_ms: f64,
    pub sink_complete_at_ms: f64,
    pub cumulative_bytes: u64,
}

/// 从已定位的归档 reader 逐条解压。sink 返回后当前条目的字节立即释放，
/// 因而原生落盘路径的内存上限约为最大单文件 + 解码器工作集。
fn extract_archive_reader<R, F>(
    mut reader: R,
    archive_len: u64,
    is_sevenz: bool,
    quota: &ExtractionQuota,
    profile: &mut ExtractionProfile,
    mut sink: F,
    mut observer: Option<&mut dyn FnMut(ExtractionEntryTiming)>,
    semantic_order: bool,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<(), String>
where
    R: Read + Seek,
    F: FnMut(String, Vec<u8>) -> Result<(), String>,
{
    let trace_started = Instant::now();
    let mut entry_count = 0usize;
    let mut total_uncompressed = 0u64;

    if is_sevenz {
        let mut archive_reader =
            sevenz_rust::SevenZReader::new(&mut reader, archive_len, sevenz_rust::Password::empty())
                .map_err(|e| format!("打开 7z 归档失败: {}", e))?;
        let entry_lookup = if observer.is_some() {
            archive_reader.archive().files.iter().enumerate().map(|(i, e)|
                (e.name.clone(), (i, archive_reader.archive().stream_map.file_folder_index[i])))
                .collect::<std::collections::HashMap<_, _>>()
        } else { std::collections::HashMap::new() };
        let archive = semantic_order.then(|| archive_reader.archive().clone());
        // The borrowed reader is released before ordered independent-folder decoding.
        let mut each = |entry: &sevenz_rust::SevenZArchiveEntry, stream: &mut dyn Read| {
                if entry.is_directory() {
                    return Ok(true);
                }
                let path = normalize_path(&entry.name);
                validate_archive_path(&path).map_err(sevenz_rust::Error::other)?;
                check_declared_size(
                    &mut entry_count,
                    total_uncompressed,
                    &path,
                    entry.size(),
                    archive_len,
                    quota,
                )
                .map_err(sevenz_rust::Error::other)?;
                let decode_started = Instant::now();
                let (bytes, actual_total) = if let Some(cancelled) = cancelled {
                    read_entry_bytes(&mut CancelAwareReader { inner: stream, cancelled },
                        &path, entry.size(), total_uncompressed, archive_len, quota)
                } else {
                    read_entry_bytes(stream, &path, entry.size(), total_uncompressed, archive_len, quota)
                }.map_err(sevenz_rust::Error::other)?;
                let decode_ms = elapsed_ms(decode_started);
                profile.decode_ms += decode_ms;
                if decode_ms > profile.max_entry_decode_ms {
                    profile.max_entry_decode_ms = decode_ms;
                    profile.max_entry_decode_path = Some(path.clone());
                }
                total_uncompressed = actual_total;
                profile.entry_count += 1;
                profile.total_bytes = actual_total;
                let path_for_profile = path.clone();
                let write_started = Instant::now();
                sink(path, bytes).map_err(sevenz_rust::Error::other)?;
                let write_ms = elapsed_ms(write_started);
                profile.write_ms += write_ms;
                if write_ms > profile.max_entry_write_ms {
                    profile.max_entry_write_ms = write_ms;
                    profile.max_entry_write_path = Some(path_for_profile.clone());
                }
                if let Some(callback) = observer.as_deref_mut() {
                    let (archive_index, folder_index) = entry_lookup[&entry.name];
                    callback(ExtractionEntryTiming {
                        path: path_for_profile, archive_index, folder_index,
                        physical_order: profile.entry_count, size: entry.size(),
                        decode_ms, sink_write_ms: write_ms,
                        decoded_at_ms: write_started.duration_since(trace_started).as_secs_f64() * 1000.0,
                        sink_complete_at_ms: elapsed_ms(trace_started), cumulative_bytes: actual_total,
                    });
                }
                Ok(true)
            };
        let decode_result = if let Some(archive) = archive {
            drop(archive_reader);
            // Empty entries have no compressed stream dependency. Decode every folder once;
            // only independent all-core folders move ahead, never entries inside a solid folder.
            let mut result = Ok(());
            for (i, file) in archive.files.iter().enumerate() {
                if archive.stream_map.file_folder_index[i].is_none() {
                    if let Err(error) = each(file, &mut &[][..]) { result = Err(error); break; }
                }
            }
            let mut folders: Vec<_> = (0..archive.folders.len()).collect();
            folders.sort_by_key(|folder| {
                let start = archive.stream_map.folder_first_file_index[*folder];
                let count = archive.folders[*folder].num_unpack_sub_streams;
                !archive.files[start..start + count].iter().all(|e| is_core_semantic_path(&e.name))
            });
            if result.is_ok() {
                for folder in folders {
                    if let Err(error) = sevenz_rust::BlockDecoder::new(folder, &archive, &[], &mut reader).for_each_entries(&mut each) {
                        result = Err(error); break;
                    }
                }
            }
            result
        } else {
            archive_reader.for_each_entries(&mut each)
        };
        decode_result.map_err(|e| {
                let msg = e.to_string();
                if msg.starts_with("解压终止") {
                    msg
                } else {
                    format!("7z 解压失败: {}", e)
                }
            })?;
    } else {
        let mut archive =
            zip::ZipArchive::new(reader).map_err(|e| format!("打开 ZIP 归档失败: {}", e))?;
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("ZIP 条目读取失败: {}", e))?;
            if file.is_dir() {
                continue;
            }
            let raw_name = file.name_raw().to_vec();
            let path = normalize_path(&String::from_utf8_lossy(&raw_name));
            validate_archive_path(&path)?;
            if path.ends_with('/') {
                continue;
            }
            let declared = file.size();
            check_declared_size(
                &mut entry_count,
                total_uncompressed,
                &path,
                declared,
                archive_len,
                quota,
            )?;
            let decode_started = Instant::now();
            let (bytes, actual_total) = read_entry_bytes(
                &mut file,
                &path,
                declared,
                total_uncompressed,
                archive_len,
                quota,
            )?;
            let decode_ms = elapsed_ms(decode_started);
            profile.decode_ms += decode_ms;
            if decode_ms > profile.max_entry_decode_ms {
                profile.max_entry_decode_ms = decode_ms;
                profile.max_entry_decode_path = Some(path.clone());
            }
            total_uncompressed = actual_total;
            profile.entry_count += 1;
            profile.total_bytes = actual_total;
            let path_for_profile = path.clone();
            let write_started = Instant::now();
            sink(path, bytes)?;
            let write_ms = elapsed_ms(write_started);
            profile.write_ms += write_ms;
            if write_ms > profile.max_entry_write_ms {
                profile.max_entry_write_ms = write_ms;
                profile.max_entry_write_path = Some(path_for_profile.clone());
            }
            if let Some(callback) = observer.as_deref_mut() {
                callback(ExtractionEntryTiming {
                    path: path_for_profile, archive_index: i, folder_index: None,
                    physical_order: profile.entry_count, size: declared, decode_ms, sink_write_ms: write_ms,
                    decoded_at_ms: write_started.duration_since(trace_started).as_secs_f64() * 1000.0,
                    sink_complete_at_ms: elapsed_ms(trace_started), cumulative_bytes: actual_total,
                });
            }
        }
    }
    Ok(())
}

/// 从磁盘上的 .gim 逐条解压。只读取最多 1 MiB 头部来定位归档，归档 reader
/// 直接 seek 到压缩数据；不会将整个输入文件读入内存，也不会累计所有条目。
#[allow(dead_code)]
pub fn extract_from_path_with_quota<F>(
    path: &Path,
    quota: &ExtractionQuota,
    sink: F,
) -> Result<ExtractionMetadata, String>
where
    F: FnMut(String, Vec<u8>) -> Result<(), String>,
{
    let (metadata, _) = extract_from_path_with_quota_profile(path, quota, sink)?;
    Ok(metadata)
}

/// 与 `extract_from_path_with_quota` 相同，但返回 Rust 内部阶段计时。
/// 生产 Tauri 路径使用该变体；旧调用方继续使用上面的兼容函数。
pub fn extract_from_path_with_quota_profile<F>(
    path: &Path,
    quota: &ExtractionQuota,
    sink: F,
) -> Result<(ExtractionMetadata, ExtractionProfile), String>
where
    F: FnMut(String, Vec<u8>) -> Result<(), String>,
{
    extract_from_path_with_quota_profile_impl(path, quota, sink, None, false, None)
}

/// Desktop research observer; does not reorder, skip, or retain entry bytes.
pub fn extract_from_path_with_quota_profile_observed<F>(
    path: &Path, quota: &ExtractionQuota, sink: F,
    observer: &mut dyn FnMut(ExtractionEntryTiming),
) -> Result<(ExtractionMetadata, ExtractionProfile), String>
where F: FnMut(String, Vec<u8>) -> Result<(), String> {
    extract_from_path_with_quota_profile_impl(path, quota, sink, Some(observer), false, None)
}

/// Experimental desktop traversal: independent core-only folders and empty entries first.
/// Every compressed folder still decodes once, with unchanged internal stream order.
pub fn extract_substation_semantic_order<F>(
    path: &Path, quota: &ExtractionQuota, sink: F, observer: &mut dyn FnMut(ExtractionEntryTiming),
) -> Result<(ExtractionMetadata, ExtractionProfile), String>
where F: FnMut(String, Vec<u8>) -> Result<(), String> {
    extract_from_path_with_quota_profile_impl(path, quota, sink, Some(observer), true, None)
}

pub fn extract_substation_semantic_order_cancellable<F>(
    path: &Path, quota: &ExtractionQuota, sink: F, observer: &mut dyn FnMut(ExtractionEntryTiming),
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<(ExtractionMetadata, ExtractionProfile), String>
where F: FnMut(String, Vec<u8>) -> Result<(), String> {
    extract_from_path_with_quota_profile_impl(path, quota, sink, Some(observer), true, Some(cancelled))
}

pub fn is_core_semantic_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".cbm") || lower.ends_with(".fam") || lower.ends_with(".dev")
}

/// Capability absence is an explicit value. Safety, quota and decoder errors remain Err.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubstationEarlyEligibility {
    pub eligible: bool,
    pub reason: String,
    pub archive_format: String,
    pub folder_count: usize,
    pub core_entry_count: usize,
    pub core_bytes: u64,
    pub stream_core_entries: usize,
    pub empty_core_entries: usize,
    pub core_only_folders: Vec<usize>,
    pub semantic_physical_order: usize,
    pub checkpoint_decoded_bytes: u64,
    pub total_decoded_bytes: u64,
}
pub fn inspect_substation_eligibility(path: &Path, quota: &ExtractionQuota) -> Result<SubstationEarlyEligibility, String> {
    Ok(inspect_substation_preflight(path, quota)?.0)
}
pub fn inspect_substation_entries(path: &Path, quota: &ExtractionQuota) -> Result<Vec<(String, u64)>, String> {
    let (capability, entries) = inspect_substation_preflight(path, quota)?;
    if !capability.eligible { return Err(format!("early capability not supported: {}", capability.reason)); }
    Ok(entries)
}
fn inspect_substation_preflight(path: &Path, quota: &ExtractionQuota) -> Result<(SubstationEarlyEligibility, Vec<(String,u64)>), String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > quota.max_archive_bytes { return Err(quota_err("GIM 大小超限".into())); }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut prefix = vec![0; metadata.len().min(SIGNATURE_SEARCH_LIMIT as u64) as usize];
    file.read_exact(&mut prefix).map_err(|e| e.to_string())?;
    let (offset, info, sevenz) = parse_archive_prefix(&prefix)?;
    let mut capability = SubstationEarlyEligibility { reason: "not-gs-7z".into(), ..Default::default() };
    capability.archive_format = if sevenz { "7z" } else { "zip" }.into();
    if info.magic != "GIMPKGS" || !sevenz { return Ok((capability, Vec::new())); }
    let len = metadata.len() - offset as u64;
    let reader = OffsetReader::new(file, offset as u64, len).map_err(|e| e.to_string())?;
    let archive = sevenz_rust::SevenZReader::new(reader, len, sevenz_rust::Password::empty()).map_err(|e| e.to_string())?;
    let mut paths = std::collections::HashSet::new();
    let mut entries = Vec::new(); let mut count = 0; let mut total = 0;
    for file in &archive.archive().files {
        let raw_path = normalize_path(&file.name);
        let path = if file.is_directory() { raw_path.strip_suffix('/').unwrap_or(&raw_path).to_string() } else { raw_path };
        validate_archive_path(&path)?;
        if !paths.insert(path.to_ascii_lowercase()) { return Err("duplicate archive path".into()); }
        if file.is_directory() { continue; }
        check_declared_size(&mut count, total, &path, file.size, len, quota)?;
        total += file.size;
        entries.push((path, file.size));
    }
    let archive = archive.archive();
    capability.folder_count = archive.folders.len();
    let mut folder_core = vec![true; archive.folders.len()];
    let mut order = Vec::new();
    for (i, f) in archive.files.iter().enumerate().filter(|(_, f)| !f.is_directory()) {
        let core = is_core_semantic_path(&f.name);
        if core {
            capability.core_entry_count += 1;
            capability.core_bytes += f.size;
            if f.has_stream { capability.stream_core_entries += 1; }
            else { capability.empty_core_entries += 1; }
        }
        if let Some(folder) = archive.stream_map.file_folder_index[i] {
            folder_core[folder] &= core;
        } else { order.push(i); }
    }
    capability.core_only_folders = folder_core.iter().enumerate().filter_map(|(i,c)| c.then_some(i)).collect();
    let mut folders: Vec<_> = (0..archive.folders.len()).collect();
    folders.sort_by_key(|f| !folder_core[*f]);
    for folder in folders {
        order.extend(archive.files.iter().enumerate().filter_map(|(i,f)|
            (!f.is_directory() && archive.stream_map.file_folder_index[i] == Some(folder)).then_some(i)));
    }
    if order.len() != entries.len() { return Err("archive stream layout inconsistent".into()); }
    let last_core = order.iter().rposition(|i| is_core_semantic_path(&archive.files[*i].name));
    if let Some(last) = last_core {
        capability.semantic_physical_order = last + 1;
        capability.checkpoint_decoded_bytes = order[..=last].iter().map(|i| archive.files[*i].size).sum();
        capability.total_decoded_bytes = total;
        // A checkpoint at EOF has no early traversal benefit. Sizes are not time estimates.
        let remaining = total - capability.checkpoint_decoded_bytes;
        // Conservatively reject near-EOF checkpoints (<1% of decoded bytes remain).
        // This is an eligibility bound, not a conversion-cost prediction.
        capability.eligible = remaining > total / 100;
        capability.reason = if capability.eligible { "core-prefix-with-remaining-streams" } else { "no-early-checkpoint-benefit" }.into();
    } else { capability.reason = "no-core-inputs".into(); }
    Ok((capability, entries))
}

fn extract_from_path_with_quota_profile_impl<F>(
    path: &Path, quota: &ExtractionQuota, sink: F,
    observer: Option<&mut dyn FnMut(ExtractionEntryTiming)>,
    semantic_order: bool,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<(ExtractionMetadata, ExtractionProfile), String>
where F: FnMut(String, Vec<u8>) -> Result<(), String> {
    let started = Instant::now();
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("读取 GIM 文件元信息失败: {}", e))?;
    if metadata.len() > quota.max_archive_bytes {
        return Err(quota_err(format!(
            "GIM 文件大小 {} 超限（>{})",
            metadata.len(),
            quota.max_archive_bytes
        )));
    }
    let mut file = File::open(path).map_err(|e| format!("打开 GIM 文件失败: {}", e))?;
    let prefix_len = usize::try_from(metadata.len().min(SIGNATURE_SEARCH_LIMIT as u64))
        .map_err(|_| "GIM 头部窗口长度溢出".to_string())?;
    let mut prefix = vec![0u8; prefix_len];
    file.read_exact(&mut prefix)
        .map_err(|e| format!("读取 GIM 头部失败: {}", e))?;
    let (offset, info, is_sevenz) = parse_archive_prefix(&prefix)?;
    let header_ms = elapsed_ms(started);
    let archive_len = metadata
        .len()
        .checked_sub(offset as u64)
        .ok_or_else(|| "GIM 归档偏移越界".to_string())?;
    let reader = OffsetReader::new(file, offset as u64, archive_len)
        .map_err(|e| format!("定位 GIM 归档失败: {}", e))?;
    let archive_started = Instant::now();
    let mut profile = ExtractionProfile {
        header_ms,
        archive_bytes: metadata.len(),
        ..ExtractionProfile::default()
    };
    extract_archive_reader(reader, archive_len, is_sevenz, quota, &mut profile, sink, observer, semantic_order, cancelled)?;
    profile.archive_ms = elapsed_ms(archive_started);
    profile.total_ms = elapsed_ms(started);
    Ok((info, profile))
}

/// 从 .gim 字节中提取全部文件条目（自定义资源配额）
///
/// 配额校验：声明大小先行（防 with_capacity 过度分配）；
/// 条目数/单文件/累计总量上限（u64 + checked 算术防溢出）；
/// 压缩比上限识别压缩炸弹；实际读取量复核。
pub fn extract_from_bytes_with_quota(
    data: &[u8],
    quota: &ExtractionQuota,
) -> Result<ExtractedArchive, String> {
    if data.len() as u64 > quota.max_archive_bytes {
        return Err(quota_err(format!(
            "GIM 文件大小 {} 超限（>{}）",
            data.len(),
            quota.max_archive_bytes
        )));
    }
    let offset = find_archive_offset(data)
        .ok_or_else(|| "未找到有效的 GIMPKG* 头部或压缩数据签名".to_string())?;
    let (project_id, project_name) = parse_header_fields(data, offset);
    let magic_bytes = &data[..magic_len(data)];
    let magic = String::from_utf8_lossy(magic_bytes).to_string();

    let archive_data = &data[offset..];
    let is_sevenz = archive_data.starts_with(&SEVENZ_SIG);

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    // 累计解压量（u64 + checked 算术，防溢出与压缩炸弹）
    let mut total_uncompressed: u64 = 0;

    if is_sevenz {
        let mut reader = sevenz_rust::SevenZReader::new(
            Cursor::new(archive_data),
            archive_data.len() as u64,
            sevenz_rust::Password::empty(),
        )
        .map_err(|e| format!("打开 7z 归档失败: {}", e))?;
        reader
            .for_each_entries(|entry, stream| {
                if entry.is_directory() {
                    return Ok(true);
                }

                // ── 配额校验（声明大小先行，防止 with_capacity 过度分配）──
                if entries.len() + 1 > quota.max_entries {
                    return Err(sevenz_rust::Error::other(quota_err(format!(
                        "条目数超限（>{}）",
                        quota.max_entries
                    ))));
                }
                let declared = entry.size();
                if declared > quota.max_file_bytes {
                    return Err(sevenz_rust::Error::other(quota_err(format!(
                        "单文件 {} 解压大小 {} 超限（>{})",
                        normalize_path(&entry.name),
                        declared,
                        quota.max_file_bytes
                    ))));
                }
                let declared_total = total_uncompressed.checked_add(declared).ok_or_else(|| {
                    sevenz_rust::Error::other(quota_err("总解压量溢出".to_string()))
                })?;
                if declared_total > quota.max_total_uncompressed_bytes {
                    return Err(sevenz_rust::Error::other(quota_err(format!(
                        "总解压量 {} 超限（>{})",
                        declared_total, quota.max_total_uncompressed_bytes
                    ))));
                }
                if declared_total
                    > (archive_data.len() as u64).saturating_mul(quota.max_compression_ratio)
                {
                    return Err(sevenz_rust::Error::other(quota_err(format!(
                        "压缩比超限（>{}×，疑似压缩炸弹）",
                        quota.max_compression_ratio
                    ))));
                }

                let path = normalize_path(&entry.name);
                validate_archive_path(&path).map_err(sevenz_rust::Error::other)?;
                // 声明大小不可信：用 take 再读一字节，防止恶意条目实际膨胀到无界。
                let capacity = declared.min(quota.max_file_bytes).min(64 * 1024 * 1024) as usize;
                let mut buf = Vec::with_capacity(capacity);
                let mut limited = stream.take(quota.max_file_bytes.saturating_add(1));
                limited
                    .read_to_end(&mut buf)
                    .map_err(sevenz_rust::Error::io)?;
                if buf.len() as u64 > quota.max_file_bytes {
                    return Err(sevenz_rust::Error::other(quota_err(format!(
                        "单文件 {} 实际解压大小超过 {}",
                        path, quota.max_file_bytes
                    ))));
                }

                // 实际解压量复核（声明值可能伪造）
                let actual_total = total_uncompressed
                    .checked_add(buf.len() as u64)
                    .ok_or_else(|| {
                        sevenz_rust::Error::other(quota_err("总解压量溢出".to_string()))
                    })?;
                if actual_total > quota.max_total_uncompressed_bytes {
                    return Err(sevenz_rust::Error::other(quota_err(format!(
                        "实际总解压量 {} 超限（>{}）",
                        actual_total, quota.max_total_uncompressed_bytes
                    ))));
                }
                if actual_total
                    > (archive_data.len() as u64).saturating_mul(quota.max_compression_ratio)
                {
                    return Err(sevenz_rust::Error::other(quota_err(format!(
                        "实际压缩比超限（>{}×，疑似压缩炸弹）",
                        quota.max_compression_ratio
                    ))));
                }
                total_uncompressed = actual_total;

                if !path.is_empty() {
                    entries.push((path, buf));
                }
                Ok(true)
            })
            .map_err(|e| {
                let msg = e.to_string();
                if msg.starts_with("解压终止") {
                    msg // 配额错误原样透传
                } else {
                    format!("7z 解压失败: {}", e)
                }
            })?;
    } else {
        let mut archive = zip::ZipArchive::new(Cursor::new(archive_data))
            .map_err(|e| format!("打开 ZIP 归档失败: {}", e))?;
        for i in 0..archive.len() {
            let file = archive
                .by_index(i)
                .map_err(|e| format!("ZIP 条目读取失败: {}", e))?;
            if file.is_dir() {
                continue;
            }

            // ── 配额校验 ──
            if entries.len() + 1 > quota.max_entries {
                return Err(quota_err(format!("条目数超限（>{}）", quota.max_entries)));
            }
            let declared = file.size();
            if declared > quota.max_file_bytes {
                return Err(quota_err(format!(
                    "单文件解压大小 {} 超限（>{})",
                    declared, quota.max_file_bytes
                )));
            }
            let declared_total = total_uncompressed
                .checked_add(declared)
                .ok_or_else(|| quota_err("总解压量溢出".to_string()))?;
            if declared_total > quota.max_total_uncompressed_bytes {
                return Err(quota_err(format!(
                    "总解压量 {} 超限（>{})",
                    declared_total, quota.max_total_uncompressed_bytes
                )));
            }
            if declared_total
                > (archive_data.len() as u64).saturating_mul(quota.max_compression_ratio)
            {
                return Err(quota_err(format!(
                    "压缩比超限（>{}×，疑似压缩炸弹）",
                    quota.max_compression_ratio
                )));
            }

            let raw_name = file.name_raw().to_vec();
            let path = normalize_path(&String::from_utf8_lossy(&raw_name));
            validate_archive_path(&path)?;
            if path.ends_with('/') {
                continue;
            }
            let capacity = declared.min(quota.max_file_bytes).min(64 * 1024 * 1024) as usize;
            let mut buf = Vec::with_capacity(capacity);
            let mut limited = file.take(quota.max_file_bytes.saturating_add(1));
            limited
                .read_to_end(&mut buf)
                .map_err(|e| format!("ZIP 条目解压失败: {}", e))?;
            if buf.len() as u64 > quota.max_file_bytes {
                return Err(quota_err(format!(
                    "单文件实际解压大小超过 {}",
                    quota.max_file_bytes
                )));
            }
            let actual_total = total_uncompressed
                .checked_add(buf.len() as u64)
                .ok_or_else(|| quota_err("总解压量溢出".to_string()))?;
            if actual_total > quota.max_total_uncompressed_bytes {
                return Err(quota_err(format!(
                    "实际总解压量 {} 超限（>{}）",
                    actual_total, quota.max_total_uncompressed_bytes
                )));
            }
            if actual_total
                > (archive_data.len() as u64).saturating_mul(quota.max_compression_ratio)
            {
                return Err(quota_err(format!(
                    "实际压缩比超限（>{}×，疑似压缩炸弹）",
                    quota.max_compression_ratio
                )));
            }
            total_uncompressed = actual_total;
            if !path.is_empty() {
                entries.push((path, buf));
            }
        }
    }

    Ok(ExtractedArchive {
        entries,
        magic,
        project_id,
        project_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_gim_bytes(archive: &[u8], magic_suffix: u8, project_name: &str) -> Vec<u8> {
        let mut v = vec![b'G', b'I', b'M', b'P', b'K', b'G', magic_suffix];
        v.extend_from_slice(b"PRJ-001");
        v.push(0);
        v.extend_from_slice(project_name.as_bytes());
        v.push(0);
        v.extend_from_slice(&[0, 0, 0, 0]); // 零填充触发终止条件
        v.extend(std::iter::repeat(0).take(128)); // 补齐到签名窗口内
        v.extend_from_slice(archive);
        v
    }

    #[test]
    fn sevenz_empty_files_count_and_survive_both_inputs() {
        let root = std::env::temp_dir().join(format!("gim-empty-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(root.join("source")).unwrap();
        std::fs::write(root.join("source/empty.mod"), b"").unwrap();
        std::fs::write(root.join("source/project.cbm"), b"TYPE=TRANS_LINE").unwrap();
        sevenz_rust::compress_to_path(root.join("source"), root.join("archive.7z")).unwrap();
        let gim = build_gim_bytes(&std::fs::read(root.join("archive.7z")).unwrap(), b'T', "test");
        let decoded = extract_from_bytes_with_quota(&gim, &ExtractionQuota::default()).unwrap();
        assert_eq!(decoded.entries.len(), 2);
        assert!(decoded.entries.iter().any(|(p, bytes)| p.ends_with("empty.mod") && bytes.is_empty()));
        std::fs::write(root.join("source.gim"), &gim).unwrap();
        let mut entries = vec![];
        extract_from_path_with_quota(&root.join("source.gim"), &ExtractionQuota::default(), |p, bytes| { entries.push((p.to_string(), bytes.len())); Ok(()) }).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|(p, len)| p.ends_with("empty.mod") && *len == 0));
        let quota = ExtractionQuota { max_entries: 1, ..ExtractionQuota::default() };
        assert!(extract_from_bytes_with_quota(&gim, &quota).is_err());
        assert!(extract_from_path_with_quota(&root.join("source.gim"), &quota, |_, _| Ok(())).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_sevenz_signature_offset() {
        let mut data = vec![b'G', b'I', b'M', b'P', b'K', b'G', b'T'];
        data.extend(std::iter::repeat(0).take(100));
        data.extend_from_slice(&SEVENZ_SIG);
        assert_eq!(find_archive_offset(&data), Some(107));
    }

    #[test]
    fn rejects_non_gim() {
        assert!(find_archive_offset(b"not a gim file at all........").is_none());
    }

    #[test]
    fn rejects_dot_path_components() {
        assert!(validate_archive_path("CBM/./project.cbm").is_err());
        assert!(validate_archive_path("CBM/../project.cbm").is_err());
    }

    #[test]
    fn extracts_zip_archive_with_header_fields() {
        // 用 zip crate 写一个真实 ZIP（覆盖 deflate 特性），再包上 GIM 头部
        let mut zip_buf = Cursor::new(Vec::new());
        {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            let mut w = zip::ZipWriter::new(&mut zip_buf);
            w.start_file("CBM/project.cbm", options).unwrap();
            std::io::Write::write_all(&mut w, b"TYPE=TS\nSUBSYSTEM=a.cbm\n").unwrap();
            w.start_file("Dev/x.ifc", options).unwrap();
            std::io::Write::write_all(&mut w, b"ISO-10303-21;\n").unwrap();
            w.finish().unwrap();
        }
        let zip_bytes = zip_buf.into_inner();
        let gim = build_gim_bytes(&zip_bytes, b'T', "测试线路");

        let result =
            extract_from_bytes_with_quota(&gim, &ExtractionQuota::default()).expect("解压应成功");
        assert_eq!(result.magic, "GIMPKGT");
        assert_eq!(result.project_id.as_deref(), Some("PRJ-001"));
        assert_eq!(result.project_name.as_deref(), Some("测试线路"));

        let paths: Vec<&str> = result.entries.iter().map(|(p, _)| p.as_str()).collect();
        assert!(paths.contains(&"CBM/project.cbm"), "实际路径: {:?}", paths);
        assert!(paths.contains(&"Dev/x.ifc"));

        let cbm = result
            .entries
            .iter()
            .find(|(p, _)| p == "CBM/project.cbm")
            .map(|(_, b)| b.clone())
            .unwrap();
        assert_eq!(cbm, b"TYPE=TS\nSUBSYSTEM=a.cbm\n");
    }

    #[test]
    fn early_capability_absence_and_preflight_safety_are_distinct() {
        let zip_path=std::env::temp_dir().join(format!("early-zip-{}.gim",std::process::id()));
        let mut zip=zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("CBM/project.cbm",zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut zip,b"TYPE=SS").unwrap();
        let data=zip.finish().unwrap().into_inner();
        std::fs::write(&zip_path,build_gim_bytes(&data,b'S',"test")).unwrap();
        let cap=inspect_substation_eligibility(&zip_path,&ExtractionQuota::default()).unwrap();
        assert!(!cap.eligible);assert_eq!(cap.archive_format,"zip");assert_eq!(cap.reason,"not-gs-7z");
        std::fs::remove_file(zip_path).unwrap();

        use sevenz_rust::{SevenZWriter,SevenZArchiveEntry};
        for (label,names,expected_error) in [
            ("all-core",vec!["CBM/project.cbm","DEV/a.dev"],false),
            ("near-eof",vec!["CBM/project.cbm","CBM/tail.ifc"],false),
            ("traversal",vec!["../project.cbm"],true),
            ("directory-traversal",vec!["../"],true),
            ("duplicate",vec!["CBM/a.cbm","cbm/A.cbm"],true),
        ] {
            let mut archive=Cursor::new(Vec::new());
            { let mut writer=SevenZWriter::new(&mut archive).unwrap();
              for name in names { let mut entry=SevenZArchiveEntry::new();entry.name=name.into();entry.has_stream=true;entry.is_directory=name.ends_with('/');
                writer.push_archive_entry(entry,Some(Cursor::new(if label == "near-eof" && name.ends_with(".cbm") { vec![65u8;4096] } else { b"A=1".to_vec() }))).unwrap(); }
              writer.finish().unwrap(); }
            let path=std::env::temp_dir().join(format!("early-cap-{}-{}.gim",label,std::process::id()));
            std::fs::write(&path,build_gim_bytes(&archive.into_inner(),b'S',"test")).unwrap();
            let result=inspect_substation_eligibility(&path,&ExtractionQuota::default());
            if expected_error { assert!(result.is_err(),"{}",label); }
            else { let c=result.unwrap();assert!(!c.eligible);assert_eq!(c.reason,"no-early-checkpoint-benefit"); }
            std::fs::remove_file(path).unwrap();
        }
        let path=std::env::temp_dir().join(format!("early-corrupt-{}.gim",std::process::id()));
        std::fs::write(&path,build_gim_bytes(&SEVENZ_SIG,b'S',"test")).unwrap();
        assert!(inspect_substation_eligibility(&path,&ExtractionQuota::default()).is_err());
        std::fs::remove_file(path).unwrap();
    }

    /// P1 评审 #4：条目数超配额 → 拒绝解压
    #[test]
    fn quota_rejects_entry_count_overflow() {
        let mut zip_buf = Cursor::new(Vec::new());
        {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            let mut w = zip::ZipWriter::new(&mut zip_buf);
            for name in ["a.txt", "b.txt", "c.txt"] {
                w.start_file(name, options).unwrap();
                std::io::Write::write_all(&mut w, b"x").unwrap();
            }
            w.finish().unwrap();
        }
        let gim = build_gim_bytes(&zip_buf.into_inner(), b'T', "t");
        let quota = ExtractionQuota {
            max_entries: 2,
            ..ExtractionQuota::default()
        };

        let err = extract_from_bytes_with_quota(&gim, &quota).unwrap_err();
        assert!(err.contains("条目数超限"), "实际错误: {}", err);
    }

    #[test]
    fn cancellable_reader_bounds_decode_units_and_does_not_retry_cancel() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct Source<'a> { cancelled: &'a AtomicBool, calls: usize, max: usize }
        impl Read for Source<'_> {
            fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
                self.calls += 1; self.max = self.max.max(b.len());
                b.fill(1); self.cancelled.store(true, Ordering::Release); Ok(b.len())
            }
        }
        let cancelled = AtomicBool::new(false);
        let mut source = Source { cancelled: &cancelled, calls: 0, max: 0 };
        let mut reader = CancelAwareReader { inner: &mut source, cancelled: &cancelled };
        let error = read_entry_bytes(&mut reader, "CBM/a.ifc", 1024 * 1024, 0, 1024 * 1024, &ExtractionQuota::default()).unwrap_err();
        assert!(error.contains("cancelled")); assert_eq!(source.calls, 1); assert!(source.max <= 64 * 1024);
    }

    #[test]
    fn semantic_order_preserves_solid_bytes_and_emits_core_before_geometry() {
        use sevenz_rust::{SevenZWriter, SevenZArchiveEntry, SourceReader, SeqReader};
        let mut archive = Cursor::new(Vec::new());
        {
            let mut writer = SevenZWriter::new(&mut archive).unwrap();
            let names = ["DEV/a.dev", "CBM/a.ifc", "PHM/a.phm"];
            let data = [b"PHYSICALMODEL=a.phm".to_vec(), b"IFC-byte-content".to_vec(), b"SOLIDMODEL1=a.mod".to_vec()];
            let entries = names.iter().map(|p| { let mut e = SevenZArchiveEntry::new(); e.name = p.to_string(); e.has_stream = true; e }).collect();
            let sources = data.into_iter().map(|d| SourceReader::from(Cursor::new(d))).collect::<Vec<_>>();
            writer.push_archive_entries(entries, SeqReader::from(sources)).unwrap();
            writer.push_archive_entry({ let mut e = SevenZArchiveEntry::new(); e.name = "CBM/project.cbm".into(); e.has_stream = true; e }, Some(Cursor::new(b"TYPE=SS"))).unwrap();
            writer.push_archive_entry::<Cursor<Vec<u8>>>({ let mut e = SevenZArchiveEntry::new(); e.name = "DEV/empty.fam".into(); e }, None).unwrap();
            writer.finish().unwrap();
        }
        let path = std::env::temp_dir().join(format!("gim-semantic-order-{}.gim", std::process::id()));
        std::fs::write(&path, build_gim_bytes(&archive.into_inner(), b'S', "test")).unwrap();
        let mut ordinary = Vec::new(); let mut ordered = Vec::new(); let mut trace = Vec::new();
        extract_from_path_with_quota(&path, &ExtractionQuota::default(), |p,b| { ordinary.push((p,b)); Ok(()) }).unwrap();
        let preflight = inspect_substation_entries(&path, &ExtractionQuota::default()).unwrap();
        assert_eq!(preflight.len(), 5);
        let capability = inspect_substation_eligibility(&path, &ExtractionQuota::default()).unwrap();
        assert!(capability.eligible);
        assert_eq!(capability.core_entry_count, 3);
        assert_eq!(capability.empty_core_entries, 1);
        assert_eq!(capability.core_only_folders, vec![1]);
        assert_eq!(capability.semantic_physical_order, 3);
        extract_substation_semantic_order(&path, &ExtractionQuota::default(), |p,b| { ordered.push((p,b)); Ok(()) }, &mut |e| trace.push(e)).unwrap();
        assert_eq!(ordered[0].0, "DEV/empty.fam");
        assert_eq!(ordered[1].0, "CBM/project.cbm");
        assert_eq!(ordered[2].0, "DEV/a.dev");
        assert_eq!(ordered[3].0, "CBM/a.ifc");
        let mut left = ordinary.clone(); left.sort_by(|a,b| a.0.cmp(&b.0));
        let mut right = ordered.clone(); right.sort_by(|a,b| a.0.cmp(&b.0)); assert_eq!(left, right);
        assert_eq!(trace.len(), 5); assert_eq!(trace.last().unwrap().cumulative_bytes, left.iter().map(|e| e.1.len() as u64).sum::<u64>());
        let quota = ExtractionQuota { max_entries: 2, ..ExtractionQuota::default() };
        assert!(inspect_substation_entries(&path, &quota).unwrap_err().contains("配额"));
        let mut seen = 0;
        assert!(extract_substation_semantic_order(&path, &ExtractionQuota::default(), |_,_| { seen += 1; if seen > 3 { Err("cancelled".into()) } else { Ok(()) } }, &mut |_| {}).is_err());
        assert_eq!(seen, 4);
        std::fs::remove_file(path).unwrap();
    }

    /// P1 评审 #4：单文件超配额 → 拒绝解压（且不发生 with_capacity 巨量分配）
    #[test]
    fn quota_rejects_oversized_single_file() {
        let mut zip_buf = Cursor::new(Vec::new());
        {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            let mut w = zip::ZipWriter::new(&mut zip_buf);
            // Stored 模式声明 size 即真实大小；写入 8KB 但配额限 1KB
            w.start_file("big.bin", options).unwrap();
            std::io::Write::write_all(&mut w, &[0u8; 8192]).unwrap();
            w.finish().unwrap();
        }
        let gim = build_gim_bytes(&zip_buf.into_inner(), b'T', "t");
        let quota = ExtractionQuota {
            max_file_bytes: 1024,
            ..ExtractionQuota::default()
        };

        let err = extract_from_bytes_with_quota(&gim, &quota).unwrap_err();
        assert!(err.contains("单文件"), "实际错误: {}", err);
    }

    /// P1 评审 #4：总解压量超配额 → 拒绝解压
    #[test]
    fn quota_rejects_total_size_overflow() {
        let mut zip_buf = Cursor::new(Vec::new());
        {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            let mut w = zip::ZipWriter::new(&mut zip_buf);
            for name in ["a.bin", "b.bin"] {
                w.start_file(name, options).unwrap();
                std::io::Write::write_all(&mut w, &[0u8; 4096]).unwrap();
            }
            w.finish().unwrap();
        }
        let gim = build_gim_bytes(&zip_buf.into_inner(), b'T', "t");
        let quota = ExtractionQuota {
            max_total_uncompressed_bytes: 5000,
            ..ExtractionQuota::default()
        };

        let err = extract_from_bytes_with_quota(&gim, &quota).unwrap_err();
        assert!(err.contains("总解压量"), "实际错误: {}", err);
    }

    /// P1 评审 #4：默认配额下正常样本不受影响
    #[test]
    fn default_quota_passes_normal_sample() {
        let mut zip_buf = Cursor::new(Vec::new());
        {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            let mut w = zip::ZipWriter::new(&mut zip_buf);
            w.start_file("CBM/project.cbm", options).unwrap();
            std::io::Write::write_all(&mut w, b"TYPE=TS\n").unwrap();
            w.finish().unwrap();
        }
        let gim = build_gim_bytes(&zip_buf.into_inner(), b'S', "t");
        let result = extract_from_bytes_with_quota(&gim, &ExtractionQuota::default())
            .expect("默认配额不应拒绝正常样本");
        assert_eq!(result.entries.len(), 1);
    }

    /// 磁盘优先路径只逐条交付条目，验证头部窗口定位和 ZIP reader 的相对 seek。
    #[test]
    fn extracts_path_with_stream_sink() {
        let mut zip_buf = Cursor::new(Vec::new());
        {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            let mut w = zip::ZipWriter::new(&mut zip_buf);
            w.start_file("CBM/project.cbm", options).unwrap();
            std::io::Write::write_all(&mut w, b"TYPE=TS\n").unwrap();
            w.start_file("MOD/example.mod", options).unwrap();
            std::io::Write::write_all(&mut w, b"MOD=1\n").unwrap();
            w.finish().unwrap();
        }
        let gim = build_gim_bytes(&zip_buf.into_inner(), b'S', "stream-test");
        let path = std::env::temp_dir().join(format!(
            "gim-viewer-stream-{}-{}.gim",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, gim).unwrap();

        let mut seen = Vec::new();
        let info =
            extract_from_path_with_quota(&path, &ExtractionQuota::default(), |name, bytes| {
                seen.push((name, bytes));
                Ok(())
            })
            .expect("磁盘逐条解压应成功");
        let _ = std::fs::remove_file(&path);

        assert_eq!(info.magic, "GIMPKGS");
        assert_eq!(info.project_name.as_deref(), Some("stream-test"));
        assert_eq!(seen.len(), 2);
        assert!(seen
            .iter()
            .any(|(name, bytes)| name == "CBM/project.cbm" && bytes == b"TYPE=TS\n"));
        assert!(seen
            .iter()
            .any(|(name, bytes)| name == "MOD/example.mod" && bytes == b"MOD=1\n"));
    }

    /// 真实样本验证：对 demo/line02.gim 执行完整解压，校验条目规模与关键文件。
    /// 样本缺失时静默跳过（CI 无 demo 数据）。
    #[test]
    fn extracts_real_line02_sample() {
        let candidates = [
            "../../demo/line02.gim",
            "../demo/line02.gim",
            "demo/line02.gim",
        ];
        let path = candidates.iter().find(|p| std::path::Path::new(p).exists());
        let Some(path) = path else {
            eprintln!("[skip] demo/line02.gim 不存在，跳过真实样本验证");
            return;
        };
        let file_size = std::fs::metadata(path).expect("读取样本元信息失败").len();
        let t1 = std::time::Instant::now();
        let mut entry_count = 0usize;
        let mut has_project_cbm = false;
        let result = extract_from_path_with_quota(
            std::path::Path::new(path),
            &ExtractionQuota::default(),
            |entry_path, _bytes| {
                entry_count += 1;
                if entry_path.eq_ignore_ascii_case("cbm/project.cbm") {
                    has_project_cbm = true;
                }
                Ok(())
            },
        )
        .expect("真实样本磁盘优先解压失败");
        let extract_ms = t1.elapsed().as_millis();

        println!(
            "[perf] line02.gim: {} bytes, 磁盘优先原生解压 {}ms, 条目数 {}",
            file_size, extract_ms, entry_count
        );
        assert_eq!(result.magic, "GIMPKGT");
        assert!(entry_count > 1000, "条目数异常: {}", entry_count);
        assert!(has_project_cbm);
    }
}
