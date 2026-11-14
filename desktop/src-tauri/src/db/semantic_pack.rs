//! Bounded line/substation source packs and their binary indexes.

use std::collections::{HashMap, HashSet};
use std::fs as stdfs;
use std::path::{Path, PathBuf};
use std::io::Write;
use std::time::Instant;
use tauri::Manager;
use super::cache_paths::{
    CacheWriteTiming,
    cache_project_root_for_batch,
    reject_link,
    validate_entry_path,
};
use super::cache_protocol::{
    BatchCacheFileResult,

    encode_batch_cache_response,
};
use super::projects::{ensure_project_exists};
use super::{DbState};

/// 线路首屏语义文本的连续磁盘包。原生解压时，CBM/DEV/FAM/PHM 以及小型
/// MOD 不再各自落盘；它们被追加到一个连续文件，随后由一次 IPC 读取给
/// Line Parser Worker。大 MOD/STL 仍保留独立文件，供用户查看几何来源。
pub(crate) const LINE_SEMANTIC_PACK_FILE: &str = ".gim-line-semantic.pack";

pub(crate) const LINE_SEMANTIC_INDEX_FILE: &str = ".gim-line-semantic.index";

const LINE_SEMANTIC_INDEX_MAGIC: &[u8; 4] = b"GLSI";

pub(super) const LINE_SEMANTIC_INDEX_VERSION: u8 = 1;

const LINE_SEMANTIC_INDEX_HEADER: usize = 9; // magic + version + count

const LINE_SEMANTIC_INDEX_FLAG_PACKED: u8 = 0x01;

/// semantic pack 是线路首屏语义输入，不应成为一次 IPC 的无界内存源。
/// 当前六个真实线路样本的 pack 约 2--22 MB；512 MiB 足以覆盖正常工程，
/// 同时把损坏/恶意缓存的单次响应和 Rust 分配控制在明确边界内。
const MAX_LINE_SEMANTIC_PACK_BYTES: u64 = 512 * 1024 * 1024;

/// 变电原生解压的 CBM/DEV/FAM/PHM/MOD 等源条目同样不再逐条落盘。
///
/// 大型变电样本可达 3.6 万个源文件，NTFS 上仅 create/open 每个文件就要
/// 40 s 以上，暖校验又会逐条 open 读取。把它们连续写入一个 pack，并用
/// 索引记录 offset，单条读取仍然按路径解析；IFC 保持独立文件，因为缓存
/// 校验、尺寸比对和 web-ifc 读取都依赖它的独立路径。
pub(crate) const SUBSTATION_PACK_FILE: &str = ".gim-substation-source.pack";

pub(crate) const SUBSTATION_PACK_INDEX_FILE: &str = ".gim-substation-source.index";

/// 线路语义 pack 的索引项。offset/size 均相对于
/// `LINE_SEMANTIC_PACK_FILE` 的数据起点（文件本身不含头部）。
#[derive(Debug, Clone)]
pub(crate) struct LineSemanticPackEntry {
    pub path: String,
    pub offset: u64,
    pub size: u64,
    /// true 表示数据位于连续 pack；false 表示仅记录独立缓存文件元数据。
    pub packed: bool,
}

/// 将线路 parser 所需的小文本连续写入 staging 文件。
///
/// 这里故意把索引写成独立文件：解压回调是逐条的，无法在还不知道条目数
/// 时构造固定头部；独立索引也让 `read_line_semantic_pack` 可以先读取索引，
/// 再一次性读取数据，避免数万次小文件 open。
pub(crate) struct LineSemanticPackWriter {
    pub(super) data_file: stdfs::File,
    pub(super) index_path: PathBuf,
    pub(super) label: &'static str,
    pub(super) entries: Vec<LineSemanticPackEntry>,
    pub(super) seen_paths: HashSet<String>,
    pub(super) total_bytes: u64,
}

impl LineSemanticPackWriter {
    pub(crate) fn new(staging_root: &Path) -> Result<Self, String> {
        Self::new_named(
            staging_root,
            LINE_SEMANTIC_PACK_FILE,
            LINE_SEMANTIC_INDEX_FILE,
            "线路语义",
        )
    }

    /// 变电原生解压：CBM/DEV/FAM/PHM/MOD 等源条目写入同一个连续 pack。
    pub(crate) fn new_substation(staging_root: &Path) -> Result<Self, String> {
        Self::new_named(
            staging_root,
            SUBSTATION_PACK_FILE,
            SUBSTATION_PACK_INDEX_FILE,
            "变电源",
        )
    }

    pub(super) fn new_named(
        staging_root: &Path,
        data_name: &str,
        index_name: &str,
        label: &'static str,
    ) -> Result<Self, String> {
        reject_link(staging_root, " staging")?;
        let data_path = staging_root.join(data_name);
        let data_file = stdfs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&data_path)
            .map_err(|e| format!("创建{} pack 失败: {}", label, e))?;
        Ok(Self {
            data_file,
            index_path: staging_root.join(index_name),
            label,
            entries: Vec::new(),
            seen_paths: HashSet::new(),
            total_bytes: 0,
        })
    }

    pub(crate) fn append_with_timing(
        &mut self,
        path: &str,
        bytes: &[u8],
    ) -> Result<CacheWriteTiming, String> {
        let normalized_path = normalize_cache_lookup_path(path);
        if !self.seen_paths.insert(normalized_path) {
            return Err(format!("{} pack 条目重复: {}", self.label, path));
        }
        let offset = self.total_bytes;
        let size = u64::try_from(bytes.len())
            .map_err(|e| format!("{} pack 条目大小溢出: {} — {}", self.label, path, e))?;
        let data_started = Instant::now();
        self.data_file
            .write_all(bytes)
            .map_err(|e| format!("写入{} pack 失败: {} — {}", self.label, path, e))?;
        let data_ms = data_started.elapsed().as_secs_f64() * 1000.0;
        self.total_bytes = self
            .total_bytes
            .checked_add(size)
            .ok_or_else(|| format!("{} pack 总大小溢出", self.label))?;
        self.entries.push(LineSemanticPackEntry {
            path: path.to_string(),
            offset,
            size,
            packed: true,
        });
        Ok(CacheWriteTiming {
            // pack data file 在 new() 时只打开一次；单条追加没有 open 成本。
            open_ms: 0.0,
            data_ms,
        })
    }

    /// 只记录不进入连续 pack 的大 MOD/STL（或其它）条目元数据。
    /// warm full-read 会据此重建完整 filesByType/currentFiles，而不把几何
    /// 字节复制到 semantic pack 或 Worker。
    pub(crate) fn record_metadata(&mut self, path: &str, size: u64) -> Result<(), String> {
        let normalized_path = normalize_cache_lookup_path(path);
        if !self.seen_paths.insert(normalized_path) {
            return Err(format!("{} pack 条目重复: {}", self.label, path));
        }
        self.entries.push(LineSemanticPackEntry {
            path: path.to_string(),
            offset: 0,
            size,
            packed: false,
        });
        Ok(())
    }

    pub(crate) fn last_entry(&self) -> Option<&LineSemanticPackEntry> {
        self.entries.last()
    }

    pub(crate) fn finish(mut self) -> Result<Vec<LineSemanticPackEntry>, String> {
        self.data_file
            .flush()
            .map_err(|e| format!("刷新{} pack 失败: {}", self.label, e))?;
        drop(self.data_file);

        let index_path = self.index_path.clone();
        let index_file = stdfs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&index_path)
            .map_err(|e| format!("创建{} pack 索引失败: {}", self.label, e))?;
        // One entry previously performed five tiny Win32 writes. Keep the
        // identical wire format and explicit error-checked flush, but coalesce
        // those writes into bounded blocks before committing the staging dir.
        let mut index_file=std::io::BufWriter::with_capacity(64*1024,index_file);
        index_file
            .write_all(LINE_SEMANTIC_INDEX_MAGIC)
            .map_err(|e| format!("写入{} pack 索引失败: {}", self.label, e))?;
        index_file
            .write_all(&[LINE_SEMANTIC_INDEX_VERSION])
            .map_err(|e| format!("写入{} pack 索引版本失败: {}", self.label, e))?;
        let count = u32::try_from(self.entries.len())
            .map_err(|_| format!("{} pack 条目数溢出", self.label))?;
        index_file
            .write_all(&count.to_le_bytes())
            .map_err(|e| format!("写入{} pack 条目数失败: {}", self.label, e))?;
        for entry in &self.entries {
            let path = entry.path.as_bytes();
            let path_len = u32::try_from(path.len())
                .map_err(|_| format!("{} pack 路径过长: {}", self.label, entry.path))?;
            index_file
                .write_all(&path_len.to_le_bytes())
                .and_then(|_| index_file.write_all(path))
                .and_then(|_| index_file.write_all(&entry.offset.to_le_bytes()))
                .and_then(|_| index_file.write_all(&entry.size.to_le_bytes()))
                .and_then(|_| index_file.write_all(&[
                    if entry.packed { LINE_SEMANTIC_INDEX_FLAG_PACKED } else { 0 },
                ]))
                .map_err(|e| format!("写入{} pack 索引项失败: {} — {}", self.label, entry.path, e))?;
        }
        index_file
            .flush()
            .map_err(|e| format!("刷新{} pack 索引失败: {}", self.label, e))?;
        Ok(self.entries)
    }
}

pub(super) fn normalize_cache_lookup_path(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// 读取并校验 pack 索引。索引是 staging/commit 产生的受信任文件，
/// 仍执行长度、路径和 offset 边界检查，避免损坏缓存导致 panic 或越界切片。
pub(super) fn read_pack_index(
    root: &Path,
    index_file: &str,
    label: &str,
) -> Result<HashMap<String, LineSemanticPackEntry>, String> {
    let index_path = root.join(index_file);
    reject_link(&index_path, label)?;
    let bytes = stdfs::read(&index_path)
        .map_err(|e| format!("读取{label}索引失败: {e}"))?;
    if bytes.len() < LINE_SEMANTIC_INDEX_HEADER
        || &bytes[..4] != LINE_SEMANTIC_INDEX_MAGIC
        || bytes[4] != LINE_SEMANTIC_INDEX_VERSION
    {
        return Err(format!("{label}索引头无效"));
    }
    let count = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
    if count > gim_native_core::extraction_limits().max_entries {
        return Err(format!("{label}索引条目数超过安全上限"));
    }
    let mut offset = LINE_SEMANTIC_INDEX_HEADER;
    let mut result = HashMap::with_capacity(count);
    for _ in 0..count {
        let path_len_end = offset
            .checked_add(4)
            .ok_or_else(|| "pack 索引偏移溢出".to_string())?;
        if path_len_end > bytes.len() {
            return Err("pack 索引路径长度越界".to_string());
        }
        let path_len = u32::from_le_bytes(bytes[offset..path_len_end].try_into().unwrap()) as usize;
        offset = path_len_end;
        let entry_end = offset
            .checked_add(path_len)
            .and_then(|v| v.checked_add(16))
            .and_then(|v| v.checked_add(1))
            .ok_or_else(|| "pack 索引条目偏移溢出".to_string())?;
        if path_len == 0 || path_len > 4096 || entry_end > bytes.len() {
            return Err("pack 索引路径或长度无效".to_string());
        }
        let path_end = offset + path_len;
        let path = String::from_utf8(bytes[offset..path_end].to_vec())
            .map_err(|_| "pack 索引路径不是 UTF-8".to_string())?;
        offset = path_end;
        validate_entry_path(&path)?;
        let entry_offset_end = offset + 8;
        let entry_offset = u64::from_le_bytes(bytes[offset..entry_offset_end].try_into().unwrap());
        offset = entry_offset_end;
        let entry_size_end = offset + 8;
        let entry_size = u64::from_le_bytes(bytes[offset..entry_size_end].try_into().unwrap());
        offset = entry_size_end;
        let flags = bytes[offset];
        offset += 1;
        if flags & !LINE_SEMANTIC_INDEX_FLAG_PACKED != 0 { return Err("pack index flags invalid".to_string()); }
        let packed = flags & LINE_SEMANTIC_INDEX_FLAG_PACKED != 0;
        let entry = LineSemanticPackEntry {
            path: path.clone(),
            offset: entry_offset,
            size: entry_size,
            packed,
        };
        let key = normalize_cache_lookup_path(&path);
        if result.insert(key, entry).is_some() {
            return Err("pack 索引包含重复路径".to_string());
        }
    }
    if offset != bytes.len() {
        return Err("pack 索引存在尾随数据".to_string());
    }
    Ok(result)
}

pub(super) fn semantic_error(kind: &str, message: impl AsRef<str>) -> String {
    format!("{}: {}", kind, message.as_ref())
}

/// 校验 index 中 packed 区间的算术、边界与重叠关系。
///
/// 该检查在单条读取、full-read 和缓存校验中共享，任何整体损坏都会
/// 返回 PACK_TRUNCATED/INDEX_INVALID，而不是把其它条目当作可用的部分缓存。
fn validate_line_semantic_pack_ranges(
    index: &HashMap<String, LineSemanticPackEntry>,
    pack_len: u64,
) -> Result<(), String> {
    if pack_len > MAX_LINE_SEMANTIC_PACK_BYTES {
        return Err(semantic_error(
            "PACK_INVALID",
            format!(
                "线路语义 pack 大小超过安全上限（>{} bytes）",
                MAX_LINE_SEMANTIC_PACK_BYTES
            ),
        ));
    }
    let mut ranges: Vec<(u64, u64, &str)> = Vec::new();
    for entry in index.values() {
        if !entry.packed {
            continue;
        }
        let end = entry.offset.checked_add(entry.size).ok_or_else(|| {
            semantic_error(
                "PACK_TRUNCATED",
                format!("线路语义 pack 条目偏移溢出: {}", entry.path),
            )
        })?;
        if end > pack_len {
            return Err(semantic_error(
                "PACK_TRUNCATED",
                format!("线路语义 pack 条目越界: {}", entry.path),
            ));
        }
        if entry.size > 0 {
            ranges.push((entry.offset, end, entry.path.as_str()));
        }
    }
    ranges.sort_by_key(|(start, _, _)| *start);
    if ranges.is_empty() {
        if pack_len != 0 {
            return Err(semantic_error(
                "PACK_INVALID",
                "线路语义 pack 无 packed 条目但数据文件非空",
            ));
        }
    } else {
        if ranges[0].0 != 0 {
            return Err(semantic_error(
                "INDEX_INVALID",
                "线路语义 pack packed 区间未从 0 开始",
            ));
        }
        if ranges.last().map(|(_, end, _)| *end) != Some(pack_len) {
            return Err(semantic_error(
                "PACK_INVALID",
                "线路语义 pack 存在未被 index 覆盖的尾部数据",
            ));
        }
    }
    for pair in ranges.windows(2) {
        if pair[1].0 < pair[0].1 {
            return Err(semantic_error(
                "INDEX_INVALID",
                format!(
                    "线路语义 pack 条目区间重叠: {} / {}",
                    pair[0].2, pair[1].2
                ),
            ));
        }
        if pair[1].0 > pair[0].1 {
            return Err(semantic_error(
                "INDEX_INVALID",
                format!(
                    "线路语义 pack packed 区间存在空洞: {} / {}",
                    pair[0].2, pair[1].2
                ),
            ));
        }
    }
    Ok(())
}

/// v1 index 还保存 metadata-only entry；full-read/validate 时校验这些
/// 独立文件仍存在且大小未变，避免构造不完整的线路 Runtime。
fn validate_line_semantic_metadata_files(
    root: &Path,
    index: &HashMap<String, LineSemanticPackEntry>,
) -> Result<(), String> {
    for entry in index.values() {
        if entry.packed {
            continue;
        }
        let path = cache_file_path_from_root(root, &entry.path)?;
        let metadata = stdfs::metadata(&path).map_err(|e| {
            semantic_error(
                "PACK_INVALID",
                format!("线路语义 pack metadata 文件缺失: {} — {}", entry.path, e),
            )
        })?;
        if metadata.len() != entry.size {
            return Err(semantic_error(
                "PACK_INVALID",
                format!(
                    "线路语义 pack metadata 文件大小不匹配: {}（期望 {}, 实际 {}）",
                    entry.path,
                    entry.size,
                    metadata.len()
                ),
            ));
        }
    }
    Ok(())
}

/// 在已经 canonicalize 的缓存根目录下安全拼出相对 entry 路径；不创建目录。
fn cache_file_path_from_root(root: &Path, entry_path: &str) -> Result<PathBuf, String> {
    let relative = validate_entry_path(entry_path)
        .map_err(|e| semantic_error("PACK_INVALID", e))?;
    let full = root.join(relative);
    if !full.starts_with(root) {
        return Err(semantic_error("PACK_INVALID", "线路语义 pack metadata 路径越界"));
    }
    reject_link(&full, "线路语义 pack metadata 文件")
        .map_err(|e| semantic_error("PACK_INVALID", e))?;
    Ok(full)
}

/// 读取并校验 semantic pack 的公共入口。缺失/格式错误、pack 越界和
/// metadata 缺失分别保留可判定的错误前缀，供 WebView 选择整体重建或单条降级。
pub(super) fn read_line_semantic_pack_files(
    root: &Path,
    validate_metadata: bool,
) -> Result<(HashMap<String, LineSemanticPackEntry>, u64), String> {
    let index = read_pack_index(root, LINE_SEMANTIC_INDEX_FILE, "线路语义 pack ")
        .map_err(|e| semantic_error("INDEX_INVALID", e))?;
    // A syntactically valid but empty index can be produced by truncating both
    // sidecars to their headers.  It is not a usable line semantic source:
    // accepting it would let the warm path build an empty/partial Runtime and
    // silently fall back to neither the pack nor the complete source.  Every
    // valid line pack must contain at least the project CBM (case-insensitive;
    // The index may additionally contain metadata-only geometry entries).
    let has_packed_cbm = index.values().any(|entry| {
        entry.packed
            && entry.size > 0
            && normalize_cache_lookup_path(&entry.path).ends_with(".cbm")
    });
    if !has_packed_cbm {
        return Err(semantic_error(
            "INDEX_INVALID",
            "线路语义 pack index 不包含 packed CBM 入口",
        ));
    }
    let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
    reject_link(&pack_path, "线路语义 pack")
        .map_err(|e| semantic_error("PACK_INVALID", e))?;
    let pack_len = stdfs::metadata(&pack_path)
        .map_err(|e| {
            semantic_error(
                "PACK_INVALID",
                format!("读取线路语义 pack 元信息失败: {}", e),
            )
        })?
        .len();
    validate_line_semantic_pack_ranges(&index, pack_len)?;
    if validate_metadata {
        validate_line_semantic_metadata_files(root, &index)?;
    }
    Ok((index, pack_len))
}

#[cfg(test)]
pub(super) fn validate_line_semantic_pack_files(root: &Path, validate_metadata: bool) -> Result<(), String> {
    let _ = read_line_semantic_pack_files(root, validate_metadata)?;
    Ok(())
}

/// 从线路语义 pack 读取单个条目；供 DiskBackedFile 的普通 source/geometry
/// 读取路径使用。按需只读取指定区间，不把整个 pack 复制到 JS。
pub(super) fn read_line_semantic_pack_entry(root: &Path, entry_path: &str) -> Result<Option<Vec<u8>>, String> {
    let (index, _pack_len) = read_line_semantic_pack_files(root, false)?;
    let key = normalize_cache_lookup_path(entry_path);
    let Some(entry) = index.get(&key) else { return Ok(None); };
    if !entry.packed {
        // 该路径是 metadata-only（通常为大 MOD/STL），不是 semantic
        // entry；调用方可以按普通独立文件路径继续读取。
        return Ok(None);
    }
    let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
    reject_link(&pack_path, "线路语义 pack")
        .map_err(|e| semantic_error("PACK_INVALID", e))?;
    let pack_len = stdfs::metadata(&pack_path)
        .map_err(|e| {
            semantic_error(
                "PACK_INVALID",
                format!("读取线路语义 pack 元信息失败: {}", e),
            )
        })?
        .len();
    let end = entry
        .offset
        .checked_add(entry.size)
        .ok_or_else(|| semantic_error("PACK_TRUNCATED", "线路语义 pack 条目偏移溢出"))?;
    if end > pack_len {
        return Err(semantic_error(
            "PACK_TRUNCATED",
            format!("线路语义 pack 条目越界: {}", entry.path),
        ));
    }
    let mut file = stdfs::File::open(&pack_path)
        .map_err(|e| semantic_error("PACK_INVALID", format!("打开线路语义 pack 失败: {}", e)))?;
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(entry.offset))
        .map_err(|e| semantic_error("PACK_INVALID", format!("定位线路语义 pack 失败: {}", e)))?;
    let size = usize::try_from(entry.size)
        .map_err(|_| semantic_error("PACK_TRUNCATED", "线路语义 pack 条目大小超过平台限制"))?;
    let mut data = vec![0u8; size];
    file.read_exact(&mut data)
        .map_err(|e| {
            semantic_error(
                "PACK_TRUNCATED",
                format!("读取线路语义 pack 条目失败: {}", e),
            )
        })?;
    Ok(Some(data))
}

/// 变电源 pack 索引的内存缓存。
///
/// 一次冷打开会连续发起数十批读取；若每批都重新解析三万条索引，暖路径的
/// 校验就会退化回秒级。缓存以索引文件的 mtime 与长度作失效条件。
struct CachedSubstationPackIndex {
    modified: Option<std::time::SystemTime>,
    len: u64,
    index: std::sync::Arc<HashMap<String, LineSemanticPackEntry>>,
}

static SUBSTATION_PACK_INDEX_CACHE: std::sync::OnceLock<
    std::sync::Mutex<HashMap<PathBuf, CachedSubstationPackIndex>>,
> = std::sync::OnceLock::new();

pub(super) fn substation_pack_index(
    root: &Path,
) -> Result<std::sync::Arc<HashMap<String, LineSemanticPackEntry>>, String> {
    let index_path = root.join(SUBSTATION_PACK_INDEX_FILE);
    let meta = stdfs::metadata(&index_path)
        .map_err(|e| format!("读取变电源 pack 索引失败: {e}"))?;
    let len = meta.len();
    let modified = meta.modified().ok();
    let cache = SUBSTATION_PACK_INDEX_CACHE
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(entry) = guard.get(&index_path) {
            if entry.len == len && entry.modified == modified {
                return Ok(entry.index.clone());
            }
        }
    }
    let index = std::sync::Arc::new(read_pack_index(
        root,
        SUBSTATION_PACK_INDEX_FILE,
        "变电源 pack ",
    )?);
    if let Ok(mut guard) = cache.lock() {
        guard.insert(
            index_path,
            CachedSubstationPackIndex { modified, len, index: index.clone() },
        );
    }
    Ok(index)
}

pub(super) fn substation_pack_len(root: &Path) -> Option<u64> {
    let path = root.join(SUBSTATION_PACK_FILE);
    stdfs::metadata(&path).ok().map(|meta| meta.len())
}

/// 从已经打开的变电源 pack 读取一个条目；批量读取整批只 open 一次。
pub(super) fn read_substation_pack_bytes(
    root: &Path,
    index: &HashMap<String, LineSemanticPackEntry>,
    pack_len: u64,
    pack_file: &mut Option<stdfs::File>,
    entry_path: &str,
) -> Option<Vec<u8>> {
    let entry = index.get(&normalize_cache_lookup_path(entry_path))?;
    if !entry.packed {
        return None;
    }
    let end = entry.offset.checked_add(entry.size)?;
    if end > pack_len {
        return None;
    }
    let file = match pack_file {
        Some(file) => file,
        None => {
            let path = root.join(SUBSTATION_PACK_FILE);
            let opened = stdfs::File::open(&path).ok()?;
            pack_file.insert(opened)
        }
    };
    use std::io::{Read, Seek, SeekFrom};
    let size = usize::try_from(entry.size).ok()?;
    let mut data = vec![0u8; size];
    file.seek(SeekFrom::Start(entry.offset)).ok()?;
    file.read_exact(&mut data).ok()?;
    Some(data)
}

/// 单条读取：CBM/DEV/FAM/MOD/STL 等在变电 pack 内按 offset 懒读。
pub(super) fn read_substation_pack_entry(root: &Path, entry_path: &str) -> Option<Vec<u8>> {
    let index = substation_pack_index(root).ok()?;
    let pack_len = substation_pack_len(root)?;
    let mut file = None;
    read_substation_pack_bytes(root, index.as_ref(), pack_len, &mut file, entry_path)
}

/// 缓存校验用：条目是否存在于 pack 且声明的原始大小一致（不解码数据）。
pub(super) fn substation_pack_contains(root: &Path, entry_path: &str, size: u64) -> bool {
    let Ok(index) = substation_pack_index(root) else { return false };
    match index.get(&normalize_cache_lookup_path(entry_path)) {
        Some(entry) => entry.packed && entry.size == size,
        None => false,
    }
}

/// Tauri command：一次读取线路语义 pack 中的多个文本条目。
///
/// 原生冷启动只为线路 parser 保留一个连续 pack，避免 batch_read_cached_files
/// 对两万多个 CBM/FAM/DEV 文件逐个 open。索引先在 Rust 侧解析，数据文件只
/// 打开/读取一次；返回格式仍是 GIMR v1，因此 WebView 的 bytes/阶段埋点可复用。
#[tauri::command]
pub fn read_line_semantic_pack(
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
        return Err("线路语义 pack 读取条目数超过安全上限".to_string());
    }
    let root = cache_project_root_for_batch(&app_handle, project_id)?;
    let (index, pack_len) = read_line_semantic_pack_files(&root, false)?;
    let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
    // 只打开一次 pack，并按索引区间读取请求项；不要把整个 pack 复制到
    // Rust 堆再切片。正常请求按 manifest 顺序到达，读取仍接近顺序 IO；
    // 即使请求顺序被调用方改变，也只产生 seek，不会增加 IPC 次数或峰值内存。
    let mut pack_file = stdfs::File::open(&pack_path)
        .map_err(|e| format!("打开线路语义 pack 失败: {}", e))?;

    let mut results = Vec::with_capacity(entry_paths.len());
    let mut total_bytes: u64 = 0;
    let mut hit_count: u32 = 0;
    let mut resolve_ms = 0.0_f64;
    let mut read_ms = 0.0_f64;
    for requested_path in &entry_paths {
        let resolve_started = Instant::now();
        let resolved = validate_entry_path(requested_path)
            .ok()
            .and_then(|_| index.get(&normalize_cache_lookup_path(requested_path)));
        resolve_ms += resolve_started.elapsed().as_secs_f64() * 1000.0;
        let bytes = if let Some(entry) = resolved.filter(|entry| entry.packed) {
            let end = entry
                .offset
                .checked_add(entry.size)
                .ok_or_else(|| {
                    semantic_error(
                        "PACK_TRUNCATED",
                        format!("线路语义 pack 条目偏移溢出: {}", requested_path),
                    )
                })?;
            if end > pack_len {
                return Err(semantic_error(
                    "PACK_TRUNCATED",
                    format!("线路语义 pack 条目越界: {}", requested_path),
                ));
            }
            let start = usize::try_from(entry.offset)
                .map_err(|_| semantic_error("PACK_TRUNCATED", "线路语义 pack 条目偏移超过平台限制"))?;
            let end = usize::try_from(end)
                .map_err(|_| semantic_error("PACK_TRUNCATED", "线路语义 pack 条目末端超过平台限制"))?;
            let mut data = vec![0u8; end - start];
            use std::io::{Read, Seek, SeekFrom};
            let read_started = Instant::now();
            pack_file
                .seek(SeekFrom::Start(entry.offset))
                .map_err(|e| semantic_error("PACK_INVALID", format!("定位线路语义 pack 失败: {} — {}", requested_path, e)))?;
            pack_file
                .read_exact(&mut data)
                .map_err(|e| semantic_error("PACK_TRUNCATED", format!("读取线路语义 pack 条目失败: {} — {}", requested_path, e)))?;
            read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
            hit_count = hit_count.saturating_add(1);
            total_bytes = total_bytes
                .checked_add(data.len() as u64)
                .ok_or_else(|| "线路语义 pack 读取总量溢出".to_string())?;
            if total_bytes > gim_native_core::extraction_limits().max_total_uncompressed_bytes {
                return Err("线路语义 pack 读取总量超过安全上限".to_string());
            }
            Some(data)
        } else {
            None
        };
        results.push(BatchCacheFileResult {
            entry_path: requested_path.clone(),
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

/// semantic pack full-read 的二进制 envelope。
///
/// `GIMF` v1 头部：magic(4) + version(1) + count(u32) +
/// index/resolve/read/encode/total(f64×5) + packed_bytes(u64) +
/// packed_count(u32)。每项为 path_len(u32)+path+flags(u8)+size(u64)+
/// data_len(u64)+data。metadata-only 项 flags=0、data_len=0，但保留
/// 原始 size，使 WebView 可以创建 lazy DiskBackedFile。
const LINE_SEMANTIC_FULL_MAGIC: &[u8; 4] = b"GIMF";

const LINE_SEMANTIC_FULL_VERSION: u8 = 1;

const LINE_SEMANTIC_FULL_HEADER: usize = 61;

const LINE_SEMANTIC_FULL_FLAG_PACKED: u8 = 0x01;

const MAX_LINE_SEMANTIC_FULL_RESPONSE_BYTES: u64 =
    MAX_LINE_SEMANTIC_PACK_BYTES + 64 * 1024 * 1024;

fn encode_line_semantic_pack_full_header(
    count: u32,
    index_ms: f64,
    resolve_ms: f64,
    read_ms: f64,
    packed_bytes: u64,
    packed_count: u32,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(LINE_SEMANTIC_FULL_HEADER);
    out.extend_from_slice(LINE_SEMANTIC_FULL_MAGIC);
    out.push(LINE_SEMANTIC_FULL_VERSION);
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&index_ms.to_le_bytes());
    out.extend_from_slice(&resolve_ms.to_le_bytes());
    out.extend_from_slice(&read_ms.to_le_bytes());
    // encodeMs / totalMs 在全部 item 完成后回填。
    out.extend_from_slice(&0.0_f64.to_le_bytes());
    out.extend_from_slice(&0.0_f64.to_le_bytes());
    out.extend_from_slice(&packed_bytes.to_le_bytes());
    out.extend_from_slice(&packed_count.to_le_bytes());
    out
}

/// Tauri command：一次读取完整线路 semantic pack，并返回 metadata-only 条目。
///
/// 与旧 `read_line_semantic_pack(project_id, entry_paths)` 不同，WebView 不
/// 再传递两万条路径；Rust 直接按 index 返回全部条目。整体 index/pack
/// 损坏会返回带前缀的错误，调用方必须让 semantic source cache 失效并重建，
/// 不得退化成逐条读取后提交 partial Runtime。
#[tauri::command]
pub fn read_line_semantic_pack_all(
    app_handle: tauri::AppHandle,
    project_id: i64,
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
    let root = cache_project_root_for_batch(&app_handle, project_id)?;
    let index_started = Instant::now();
    let (index, pack_len) = read_line_semantic_pack_files(&root, true)?;
    let index_ms = index_started.elapsed().as_secs_f64() * 1000.0;
    // `resolveMs` covers all work after the index bytes have been validated and
    // before any semantic payload is read: collecting entries from the lookup
    // map, deterministic ordering, count/size arithmetic and response-size
    // validation. Keep it separate from `readMs` so the latter represents only
    // file seek/read operations.
    let resolve_started = Instant::now();
    let mut entries: Vec<LineSemanticPackEntry> = index.into_values().collect();
    // HashMap 只用于大小写不敏感查找；full-read 使用稳定排序，避免不同
    // Rust 进程的随机 hash seed 改变 Worker 输入/导航顺序。
    entries.sort_by(|a, b| normalize_cache_lookup_path(&a.path).cmp(&normalize_cache_lookup_path(&b.path)));
    let count = u32::try_from(entries.len())
        .map_err(|_| semantic_error("INDEX_INVALID", "线路语义 pack 条目数溢出"))?;
    let packed_count = entries.iter().filter(|entry| entry.packed).count();
    let packed_count = u32::try_from(packed_count)
        .map_err(|_| semantic_error("INDEX_INVALID", "线路语义 pack packed 条目数溢出"))?;
    let packed_bytes = entries
        .iter()
        .filter(|entry| entry.packed)
        .try_fold(0u64, |sum, entry| sum.checked_add(entry.size))
        .ok_or_else(|| semantic_error("PACK_TRUNCATED", "线路语义 pack 总大小溢出"))?;
    let response_overhead = entries.iter().try_fold(0u64, |sum, entry| {
        let path_len = u64::try_from(entry.path.as_bytes().len()).ok()?;
        sum.checked_add(4 + path_len + 1 + 8 + 8)
    }).ok_or_else(|| semantic_error("INDEX_INVALID", "线路语义 pack 响应大小溢出"))?;
    let expected_response = u64::try_from(LINE_SEMANTIC_FULL_HEADER)
        .ok()
        .and_then(|v| v.checked_add(response_overhead))
        .and_then(|v| v.checked_add(packed_bytes))
        .ok_or_else(|| semantic_error("PACK_INVALID", "线路语义 pack 响应大小溢出"))?;
    if expected_response > MAX_LINE_SEMANTIC_FULL_RESPONSE_BYTES {
        return Err(semantic_error(
            "PACK_INVALID",
            format!("线路语义 pack full response 超过安全上限（>{} bytes）", MAX_LINE_SEMANTIC_FULL_RESPONSE_BYTES),
        ));
    }
    let resolve_ms = resolve_started.elapsed().as_secs_f64() * 1000.0;
    let pack_path = root.join(LINE_SEMANTIC_PACK_FILE);
    let mut pack_file = stdfs::File::open(&pack_path)
        .map_err(|e| semantic_error("PACK_INVALID", format!("打开线路语义 pack 失败: {}", e)))?;
    use std::io::{Read, Seek, SeekFrom};
    let mut out = encode_line_semantic_pack_full_header(
        count,
        index_ms,
        resolve_ms,
        0.0,
        packed_bytes,
        packed_count,
    );
    let mut read_ms = 0.0_f64;
    let mut encode_ms = 0.0_f64;
    for entry in entries {
        let path = entry.path.as_bytes();
        let path_len = u32::try_from(path.len())
            .map_err(|_| semantic_error("INDEX_INVALID", format!("线路语义 pack 路径过长: {}", entry.path)))?;
        let data = if entry.packed {
            let size = usize::try_from(entry.size)
                .map_err(|_| semantic_error("PACK_TRUNCATED", format!("线路语义 pack 条目大小超过平台限制: {}", entry.path)))?;
            let mut data = vec![0u8; size];
            let read_started = Instant::now();
            pack_file
                .seek(SeekFrom::Start(entry.offset))
                .map_err(|e| semantic_error("PACK_INVALID", format!("定位线路语义 pack 失败: {} — {}", entry.path, e)))?;
            pack_file
                .read_exact(&mut data)
                .map_err(|e| semantic_error("PACK_TRUNCATED", format!("读取线路语义 pack 条目失败: {} — {}", entry.path, e)))?;
            read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
            Some(data)
        } else {
            None
        };
        // 只把 envelope 拼装计入 encodeMs；entry 的 seek/read 已在 readMs
        // 单独计时，避免阶段互相重叠导致性能报告误判瓶颈。
        let encode_item_started = Instant::now();
        out.extend_from_slice(&path_len.to_le_bytes());
        out.extend_from_slice(path);
        out.push(if entry.packed { LINE_SEMANTIC_FULL_FLAG_PACKED } else { 0 });
        out.extend_from_slice(&entry.size.to_le_bytes());
        if let Some(data) = data {
            out.extend_from_slice(&(data.len() as u64).to_le_bytes());
            out.extend_from_slice(&data);
        } else {
            out.extend_from_slice(&0u64.to_le_bytes());
        }
        encode_ms += encode_item_started.elapsed().as_secs_f64() * 1000.0;
        let response_bytes = u64::try_from(out.len()).unwrap_or(u64::MAX);
        if response_bytes > MAX_LINE_SEMANTIC_FULL_RESPONSE_BYTES {
            return Err(semantic_error("PACK_INVALID", "线路语义 pack full response 超过安全上限"));
        }
    }
    let total_ms = total_started.elapsed().as_secs_f64() * 1000.0;
    out[25..33].copy_from_slice(&read_ms.to_le_bytes());
    out[33..41].copy_from_slice(&encode_ms.to_le_bytes());
    out[41..49].copy_from_slice(&total_ms.to_le_bytes());
    let _ = pack_len;
    Ok(tauri::ipc::Response::new(out))
}
