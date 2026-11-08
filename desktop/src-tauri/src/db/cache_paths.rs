//! Cache path containment, reparse-point guards and staging directory ownership.

use std::collections::HashSet;
use std::fs as stdfs;
use std::path::{Component, Path, PathBuf};
use std::io::Write;
use std::time::Instant;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
use super::{now_ms};
use super::validation_profile::{ValidationSpan};

pub(super) fn readable_source_of_size(path: &std::path::Path, size: i64) -> bool {
    let _timing = ValidationSpan::new("metadata_open");
    let mut options = stdfs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Do not follow a final-file reparse point swapped in after the path check.
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    options.open(path).and_then(|f| f.metadata()).map(|m| {
        #[cfg(windows)]
        if m.file_attributes() & 0x0400 != 0 { return false; }
        m.is_file() && size >= 0 && m.len() == size as u64
    }).unwrap_or(false)
}

/// 校验 entry_path：只允许 Normal 组件，拒绝 ParentDir / RootDir / Prefix。
/// 同时处理 "/" 和 Windows "\" 语义下的路径穿越。
/// 返回由 Normal 组件拼接的相对 PathBuf。
pub(super) fn validate_entry_path(entry_path: &str) -> Result<PathBuf, String> {
    // 归一化分隔符后再按组件校验，保证线路 PascalCase 清单和 Windows
    // 反斜杠引用在不同平台/旧缓存中得到同一安全语义。
    let normalized = entry_path.replace('\\', "/");
    let path = Path::new(&normalized);
    let mut components = Vec::new();
    for comp in path.components() {
        match comp {
            Component::Normal(s) => components.push(s),
            Component::ParentDir => return Err("entry_path 包含 .. 路径穿越".to_string()),
            Component::RootDir => return Err("entry_path 包含根目录".to_string()),
            Component::Prefix(_) => return Err("entry_path 包含盘符前缀".to_string()),
            Component::CurDir => { /* 跳过 . 当前目录 */ }
        }
    }
    if components.is_empty() {
        return Err("entry_path 无效：无有效路径组件".to_string());
    }
    let mut result = PathBuf::new();
    for c in components {
        result.push(c);
    }
    Ok(result)
}

/// 拒绝缓存目录中的符号链接/junction（Windows reparse point）。
/// 仅检查 metadata，不跟随链接，避免缓存路径被重定向到任意目录。
pub(super) fn reject_link(path: &Path, label: &str) -> Result<(), String> {
    let _timing = ValidationSpan::new("symlink_metadata");
    let Ok(meta) = stdfs::symlink_metadata(path) else {
        return Ok(());
    };
    let is_link = meta.file_type().is_symlink();
    #[cfg(windows)]
    // FILE_ATTRIBUTE_REPARSE_POINT (0x0400) covers junctions and other
    // Windows reparse points; use symlink_metadata so this check never follows
    // the link itself.
    let is_reparse = meta.file_attributes() & 0x0400 != 0;
    #[cfg(not(windows))]
    let is_reparse = false;
    if is_link || is_reparse {
        return Err(format!(
            "缓存{}包含符号链接或 junction: {}",
            label,
            path.display()
        ));
    }
    Ok(())
}

pub(super) fn ensure_cache_project_id(project_id: i64) -> Result<(), String> {
    if project_id <= 0 {
        return Err("project_id 必须为正数".to_string());
    }
    Ok(())
}

/// 创建并检查 root 下的每一级父目录；已有组件一旦是链接立即拒绝。
pub(super) fn ensure_cache_parent(
    root: &Path,
    relative_parent: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    reject_link(root, label)?;
    let mut current = root.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(part) = component else {
            return Err(format!("缓存{}父目录组件无效", label));
        };
        current.push(part);
        if !current.exists() {
            match stdfs::create_dir(&current) {
                Ok(()) => {}
                // Concurrent DEV template/catalog writes may create the same
                // project/store directory between exists() and create_dir().
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("创建缓存{}目录失败: {}", label, error)),
            }
        }
        reject_link(&current, label)?;
        if !current.is_dir() {
            return Err(format!(
                "缓存{}路径组件不是目录: {}",
                label,
                current.display()
            ));
        }
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("规范化缓存{}根目录失败: {}", label, e))?;
    let canonical_parent = current
        .canonicalize()
        .map_err(|e| format!("规范化缓存{}父目录失败: {}", label, e))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(format!("缓存{}父目录越界", label));
    }
    Ok(canonical_parent)
}

/// 原子替换缓存文件，避免进程中断留下半写文件被后续校验误认为可用。
pub(crate) fn atomic_write(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    atomic_write_with_durability(path, bytes, label, true)
}

/// Rebuildable derived artifacts retain atomic replacement but do not force
/// one disk flush per file. A power loss can discard an artifact; readers
/// validate its header/content and rebuild that domain on the next open.
pub(crate) fn atomic_write_derived(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    atomic_write_with_durability(path, bytes, label, false)
}

fn atomic_write_with_durability(path: &Path, bytes: &[u8], label: &str, durable: bool) -> Result<(), String> {
    reject_link(path, label)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("缓存{}缺少父目录", label))?;
    reject_link(parent, label)?;
    let stamp = now_ms();
    let temp = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("cache"),
        std::process::id(),
        stamp
    ));
    reject_link(&temp, label)?;
    {
        let mut file = stdfs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("创建缓存{}临时文件失败: {}", label, e))?;
        file.write_all(bytes)
            .map_err(|e| format!("写入缓存{}临时文件失败: {}", label, e))?;
        if durable {
            file.sync_all()
                .map_err(|e| format!("同步缓存{}临时文件失败: {}", label, e))?;
        }
    }
    reject_link(path, label)?;
    // std::fs::rename replaces regular files (MoveFileExW with
    // MOVEFILE_REPLACE_EXISTING on Windows). Keep the old file intact until
    // replacement succeeds; deleting first would break per-template atomicity.
    if let Err(e) = stdfs::rename(&temp, path) {
        let _ = stdfs::remove_file(&temp);
        return Err(format!("替换缓存{}文件失败: {}", label, e));
    }
    Ok(())
}

/// 为一次原生 GIM 解压创建独立 staging 目录。
///
/// 逐条写入 staging 时不需要对每个小文件执行 `sync_all + rename`；只有
/// 全部条目成功后才通过 `commit_cache_staging` 替换 project 目录。这样把
/// 数万次同步/元数据更新从冷启动关键路径移出，同时保留“未完成解压不
/// 能被缓存校验命中”的提交语义。
pub(crate) fn create_cache_staging_dir(
    app_handle: &tauri::AppHandle,
    project_id: i64,
) -> Result<(PathBuf, PathBuf), String> {
    ensure_cache_project_id(project_id)?;
    let base = crate::application_data_dir(&app_handle)
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("extracted");
    if !base.exists() {
        stdfs::create_dir_all(&base).map_err(|e| format!("创建 extracted 目录失败: {}", e))?;
    }
    reject_link(&base, " extracted")?;
    if !base.is_dir() {
        return Err(format!("extracted 路径不是目录: {}", base.display()));
    }
    let base = base.canonicalize().map_err(|e| format!("规范化 extracted 目录失败: {}", e))?;

    let final_root = base.join(project_id.to_string());
    // 纳入路径安全检查；旧目录即使存在也只允许是普通目录，提交时会
    // 先移动到 backup，再由新 staging 目录接替。
    reject_link(&final_root, "缓存")?;
    if final_root.exists() && !final_root.is_dir() {
        return Err(format!("缓存根路径不是目录: {}", final_root.display()));
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = base.join(format!(
        ".staging-{}-{}-{}",
        project_id,
        std::process::id(),
        stamp
    ));
    if staging.exists() {
        return Err(format!("缓存 staging 目录已存在: {}", staging.display()));
    }
    stdfs::create_dir(&staging).map_err(|e| format!("创建缓存 staging 目录失败: {}", e))?;
    reject_link(&staging, " staging")?;
    Ok((final_root, staging))
}

/// 一次解压过程复用的 staging 写入器。
///
/// 归档通常包含上万条同目录文件。逐条重新执行父目录的
/// `exists + symlink_metadata + is_dir` 会把元数据调用放大到数万次，
/// 在 Windows/Defender 环境下比实际写入更慢。写入器只缓存本次新建
/// staging 中已经检查过的目录。staging 根目录是本次调用刚创建的唯一
/// 目录，目标文件使用 `create_new` 原子创建：它既拒绝预先存在的普通文件，
/// 也拒绝预先存在的符号链接/junction，因此不必再对每个新文件做一次
/// `symlink_metadata`。这样在数万条目场景中可以把安全检查从“每文件”降为
/// “每个目录”，同时保留路径穿越和 reparse point 防护。
pub(crate) struct CacheStagingWriter {
    root: PathBuf,
    checked_dirs: HashSet<PathBuf>,
}

/// 一次 staging 文件写入中可拆分的耗时，用于区分 Windows 文件 open/创建
/// 与真正的字节写入。该信息只用于解压性能 profile，不改变写入语义。
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CacheWriteTiming {
    pub open_ms: f64,
    pub data_ms: f64,
}

impl CacheStagingWriter {
    pub(crate) fn new(staging_root: &Path) -> Result<Self, String> {
        reject_link(staging_root, " staging")?;
        if !staging_root.is_dir() {
            return Err(format!("缓存 staging 根路径不是目录: {}", staging_root.display()));
        }
        let mut checked_dirs = HashSet::new();
        checked_dirs.insert(staging_root.to_path_buf());
        Ok(Self {
            root: staging_root.to_path_buf(),
            checked_dirs,
        })
    }

    pub(crate) fn write_with_timing(
        &mut self,
        entry_path: &str,
        bytes: &[u8],
    ) -> Result<CacheWriteTiming, String> {
        let relative = validate_entry_path(entry_path)?;
        let mut current = self.root.clone();
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        for component in parent.components() {
            let Component::Normal(part) = component else {
                return Err("缓存 staging 父目录组件无效".to_string());
            };
            current.push(part);
            if !self.checked_dirs.contains(&current) {
                if !current.exists() {
                    stdfs::create_dir(&current)
                        .map_err(|e| format!("创建缓存 staging 子目录失败: {}", e))?;
                }
                reject_link(&current, " staging")?;
                if !current.is_dir() {
                    return Err(format!("缓存 staging 路径组件不是目录: {}", current.display()));
                }
                self.checked_dirs.insert(current.clone());
            }
        }
        let name = relative
            .file_name()
            .ok_or_else(|| "缓存 staging entry_path 缺少文件名".to_string())?;
        let full = current.join(name);
        if !full.starts_with(&self.root) {
            return Err("缓存 staging 路径越界".to_string());
        }
        // `create_new` 在文件系统层面原子拒绝已经存在的目标（包括链接），
        // 避免每个条目额外进行一次 symlink_metadata。staging 目录本身已在
        // 上方逐目录检查，且不会与旧正式缓存目录共享路径。
        let open_started = Instant::now();
        let mut file = stdfs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&full)
            .map_err(|e| format!("写入缓存 staging 文件失败: {} — {}", entry_path, e))?;
        let open_ms = open_started.elapsed().as_secs_f64() * 1000.0;
        let data_started = Instant::now();
        file.write_all(bytes)
            .map_err(|e| format!("写入缓存 staging 文件失败: {} — {}", entry_path, e))?;
        let data_ms = data_started.elapsed().as_secs_f64() * 1000.0;
        Ok(CacheWriteTiming { open_ms, data_ms })
    }
}

/// 提交一次完整的 staging 解压结果。
///
/// Windows 不支持 rename 覆盖目录，因此先把旧 project 目录移到同级 backup，
/// 再把 staging 目录改名为正式目录；新目录改名失败时尝试恢复 backup。
pub(crate) fn commit_cache_staging(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    staging_root: &Path,
) -> Result<(), String> {
    ensure_cache_project_id(project_id)?;
    reject_link(staging_root, " staging")?;
    let base = crate::application_data_dir(&app_handle)
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("extracted");
    reject_link(&base, " extracted")?;
    let base = base.canonicalize().map_err(|e| format!("规范化 extracted 目录失败: {}", e))?;
    let staging_root = staging_root.canonicalize().map_err(|e| format!("规范化 staging 目录失败: {}", e))?;
    if staging_root.parent() != Some(base.as_path()) {
        return Err("staging 目录不属于当前 extracted 根目录".into());
    }
    let final_root = base.join(project_id.to_string());
    reject_link(&final_root, "缓存")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let backup = base.join(format!(
        ".previous-{}-{}-{}",
        project_id,
        std::process::id(),
        stamp
    ));
    let had_previous = final_root.exists();
    if had_previous {
        stdfs::rename(&final_root, &backup)
            .map_err(|e| format!("移动旧缓存目录失败: {}", e))?;
    }
    if let Err(error) = stdfs::rename(&staging_root, &final_root) {
        if had_previous {
            let _ = stdfs::rename(&backup, &final_root);
        }
        return Err(format!("提交缓存 staging 目录失败: {}", error));
    }
    // 旧目录不再参与缓存命中；清理失败不影响新目录的有效性，避免把一
    // 次成功解压误报成失败。下次可安全清理残留的 .previous-* 目录。
    if had_previous {
        let _ = remove_cache_dir_if_safe(&backup, "旧缓存");
    }
    Ok(())
}

pub(crate) fn remove_cache_dir_if_safe(path: &Path, label: &str) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    reject_link(path, label)?;
    for entry in stdfs::read_dir(path).map_err(|e| format!("读取缓存{}目录失败: {}", label, e))?
    {
        let child = entry
            .map_err(|e| format!("读取缓存{}目录项失败: {}", label, e))?
            .path();
        reject_link(&child, label)?;
        if child.is_dir() {
            remove_cache_dir_if_safe(&child, label)?;
        } else {
            stdfs::remove_file(&child).map_err(|e| format!("删除缓存{}文件失败: {}", label, e))?;
        }
    }
    stdfs::remove_dir(path).map_err(|e| format!("删除缓存{}目录失败: {}", label, e))?;
    Ok(true)
}

/// 计算缓存文件路径：app_data_dir/extracted/{project_id}/{entry_path}
/// entry_path 通过组件级校验（只允许 Normal 组件），防止 ../ 和 \..\ 穿越。
/// 最终路径必须位于 app_data_dir/extracted/{project_id}/ 下。
pub(crate) fn cache_file_path(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    entry_path: &str,
) -> Result<PathBuf, String> {
    ensure_cache_project_id(project_id)?;
    let base = crate::application_data_dir(&app_handle)
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;

    let safe_rel = validate_entry_path(entry_path)?;

    // 构建预期根目录：app_data_dir/extracted/{project_id}
    let root = base.join("extracted").join(project_id.to_string());
    if !root.exists() {
        stdfs::create_dir_all(&root).map_err(|e| format!("创建缓存目录失败: {}", e))?;
    }
    reject_link(&root, "")?;

    // 规范化根目录用于 containment 校验（此时 root 已存在，canonicalize 必成功）
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("规范化缓存根目录失败: {}", e))?;

    // 逐级创建并检查父目录，避免已有 symlink/junction 绕过 starts_with 校验。
    let parent_rel = safe_rel.parent().unwrap_or_else(|| Path::new(""));
    let canonical_parent = ensure_cache_parent(&canonical_root, parent_rel, "")?;
    let file_name = safe_rel.file_name().ok_or("entry_path 缺少文件名")?;
    let full = canonical_parent.join(file_name);

    // defense-in-depth：校验最终路径仍在 canonical_root 之下
    if !full.starts_with(&canonical_root) {
        return Err("路径越界".to_string());
    }

    reject_link(&full, "文件")?;

    Ok(full)
}

/// 校验数据库中保存的 local_cache_path 是否正好对应由 project_id + entry_path
/// 计算出的缓存位置。数据库文件可能被用户或旧版本篡改，不能直接对其中的
/// 任意路径调用 metadata/read。
pub(super) fn is_expected_cache_path(
    app_handle: &tauri::AppHandle,
    project_id: i64,
    entry_path: &str,
    candidate: &Path,
) -> Result<bool, String> {
    let _timing = ValidationSpan::new("cache_root_resolution");
    ensure_cache_project_id(project_id)?;
    let base = crate::application_data_dir(&app_handle)
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    let root = base.join("extracted").join(project_id.to_string());
    is_expected_cache_path_in_root(&root, entry_path, candidate)
}

/// Call-scoped trusted root. No database candidate is ever canonicalized.
/// Directory safety is deliberately not memoized: every entry rechecks all
/// components, including both accepted root spellings.
pub(super) struct CacheValidationContext {
    pub(super) project_id: i64,
    pub(super) lexical_root: PathBuf,
    pub(super) canonical_root: PathBuf,
    // On Windows, directory handles deny DELETE sharing for the whole call,
    // preventing root rename/replacement while its canonical spelling is reused.
    pub(super) _root_handles: Vec<stdfs::File>,
    #[cfg(unix)]
    pub(super) root_identity: (u64, u64),
}

fn normalized_cache_path(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    { s = s.to_ascii_lowercase(); }
    if let Some(rest) = s.strip_prefix("//?/unc/") { s = format!("//{}", rest); }
    else if let Some(rest) = s.strip_prefix("//?/") { s = rest.to_string(); }
    while s.ends_with('/') { s.pop(); }
    s
}

impl CacheValidationContext {
    pub(super) fn for_project(app: &tauri::AppHandle, project_id: i64) -> Result<Self, String> {
        let _timing = ValidationSpan::new("cache_root_resolution");
        ensure_cache_project_id(project_id)?;
        let base = crate::application_data_dir(&app).map_err(|e| e.to_string())?;
        Self::new(project_id, &base.join("extracted").join(project_id.to_string()))
    }

    pub(super) fn new(project_id: i64, root: &Path) -> Result<Self, String> {
        ensure_cache_project_id(project_id)?;
        Self::check_component(root, "root_reparse_checks")?;
        let mut handles = Vec::new();
        #[cfg(windows)]
        let pin = |path: &Path| -> Result<stdfs::File, String> {
            use std::os::windows::fs::OpenOptionsExt;
            stdfs::OpenOptions::new().read(true).share_mode(3)
                .custom_flags(0x02000000 | 0x00200000) // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
                .open(path).map_err(|e| format!("固定可信缓存根失败: {}: {}", path.display(), e))
        };
        #[cfg(windows)]
        handles.push(pin(root)?);
        let canonical_root = {
            let _timing = ValidationSpan::new("root_canonicalize");
            root.canonicalize().map_err(|e| e.to_string())?
        };
        Self::check_component(&canonical_root, "root_reparse_checks")?;
        if !canonical_root.is_dir() { return Err("缓存根不是目录".into()); }
        #[cfg(windows)]
        handles.push(pin(&canonical_root)?);
        #[cfg(unix)]
        let root_identity = {
            use std::os::unix::fs::MetadataExt;
            let m = stdfs::metadata(root).map_err(|e| e.to_string())?;
            (m.dev(), m.ino())
        };
        Ok(Self { project_id, lexical_root: root.to_path_buf(), canonical_root,
            _root_handles: handles, #[cfg(unix)] root_identity })
    }

    pub(super) fn check_component(path: &Path, phase: &'static str) -> Result<(), String> {
        let _phase = ValidationSpan::new(phase);
        let _timing = ValidationSpan::new("symlink_metadata");
        let meta = stdfs::symlink_metadata(path).map_err(|e| format!("缓存路径不可检查: {}: {}", path.display(), e))?;
        #[cfg(windows)]
        let reparse = meta.file_attributes() & 0x0400 != 0;
        #[cfg(not(windows))]
        let reparse = false;
        if meta.file_type().is_symlink() || reparse { return Err(format!("缓存包含符号链接或 reparse point: {}", path.display())); }
        Ok(())
    }

    pub(super) fn contains(&self, project_id: i64, entry: &str, candidate: &Path) -> Result<bool, String> {
        let _timing = ValidationSpan::new("path_containment");
        if project_id != self.project_id { return Ok(false); }
        let relative = validate_entry_path(entry)?;
        let candidate_name = normalized_cache_path(candidate);
        if candidate_name != normalized_cache_path(&self.lexical_root.join(&relative))
            && candidate_name != normalized_cache_path(&self.canonical_root.join(&relative)) { return Ok(false); }
        Self::check_component(&self.lexical_root, "root_reparse_checks")?;
        Self::check_component(&self.canonical_root, "root_reparse_checks")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let m = stdfs::metadata(&self.lexical_root).map_err(|e| e.to_string())?;
            if (m.dev(), m.ino()) != self.root_identity { return Err("缓存根在验证中发生变化".into()); }
        }
        let mut current = self.canonical_root.clone();
        let parts: Vec<_> = relative.components().collect();
        for (index, part) in parts.iter().enumerate() {
            let Component::Normal(name) = part else { return Ok(false); };
            current.push(name);
            Self::check_component(&current, if index + 1 == parts.len() { "file_reparse_checks" } else { "directory_reparse_checks" })?;
        }
        Ok(true)
    }
}

pub(super) fn is_expected_cache_path_in_root(
    root: &Path,
    entry_path: &str,
    candidate: &Path,
) -> Result<bool, String> {
    let _timing = ValidationSpan::new("path_containment");
    let relative = validate_entry_path(entry_path)?;
    if reject_link(&root, " IFC").is_err() {
        return Ok(false);
    }
    let norm = |path: &Path| {
        let mut s = path.to_string_lossy().replace('\\', "/");
        #[cfg(windows)]
        {
            s = s.to_ascii_lowercase();
        }
        // `std::fs::canonicalize` may return an extended-length Windows path
        // (`\\\\?\\C:` / `//?/C:`), while older entries persisted the same
        // cache path without that prefix.  They identify the same file; keep
        // the containment check strict but compare a canonical prefix form.
        if let Some(rest) = s.strip_prefix("//?/unc/") {
            s = format!("//{}", rest);
        } else if let Some(rest) = s.strip_prefix("//?/") {
            s = rest.to_string();
        }
        while s.ends_with('/') {
            s.pop();
        }
        s
    };
    let canonical_root = {
        let _resolve=ValidationSpan::new("root_canonicalize");
        root.canonicalize().unwrap_or_else(|_|root.to_path_buf())
    };
    let expected = canonical_root.join(&relative);
    let lexical_expected = root.join(relative);
    // Windows packaged processes can redirect a trusted app-data directory
    // into their package LocalCache during canonicalize. Entries written via
    // app_data_dir retain the lexical name. Accept either trusted spelling;
    // never canonicalize an arbitrary candidate to establish containment.
    if norm(candidate) != norm(&expected) && norm(candidate) != norm(&lexical_expected) {
        return Ok(false);
    }
    let mut current = canonical_root;
    reject_link(&current, " IFC")?;
    for component in validate_entry_path(entry_path)?.components() {
        let Component::Normal(part) = component else {
            return Ok(false);
        };
        current.push(part);
        if current.exists() {
            reject_link(&current, " IFC")?;
        }
    }
    Ok(true)
}

/// 批量读取专用的缓存根目录解析。
///
/// `cache_file_path` 为单文件读写提供了最严格的逐次 canonicalize 防护；
/// 线路语义读取在同一 command 内反复使用同一个 project 根目录，若每条
/// entry 都重复 canonicalize，会让路径解析本身成为主要耗时。这里先把
/// 根目录规范化一次，再对每个相对组件做轻量 reparse-point 检查。
pub(crate) fn cache_project_root_for_batch(
    app_handle: &tauri::AppHandle,
    project_id: i64,
) -> Result<PathBuf, String> {
    ensure_cache_project_id(project_id)?;
    let base = crate::application_data_dir(&app_handle)
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?
        .join("extracted");
    if !base.exists() {
        stdfs::create_dir_all(&base).map_err(|e| format!("创建 extracted 目录失败: {}", e))?;
    }
    reject_link(&base, " extracted")?;
    if !base.is_dir() {
        return Err(format!("extracted 路径不是目录: {}", base.display()));
    }
    let root = base.join(project_id.to_string());
    if !root.exists() {
        stdfs::create_dir_all(&root).map_err(|e| format!("创建缓存根目录失败: {}", e))?;
    }
    reject_link(&root, "缓存")?;
    if !root.is_dir() {
        return Err(format!("缓存根路径不是目录: {}", root.display()));
    }
    root.canonicalize()
        .map_err(|e| format!("规范化缓存根目录失败: {}", e))
}

/// 在已经 canonicalize 的缓存根目录下解析一条 entry。
pub(crate) struct BatchCachePathResolver {
    pub(super) root: PathBuf,
    /// 同一批 entry 通常共享 Cbm/Dev/Mod/Phm 等父目录。缓存已经检查过
    /// 的目录，避免为每个文件重复触发 Windows reparse-point 元数据查询。
    pub(super) checked_dirs: HashSet<PathBuf>,
}

impl BatchCachePathResolver {
    pub(crate) fn new(root: &Path) -> Result<Self, String> {
        reject_link(root, "缓存")?;
        if !root.is_dir() {
            return Err(format!("缓存根路径不是目录: {}", root.display()));
        }
        let mut checked_dirs = HashSet::new();
        checked_dirs.insert(root.to_path_buf());
        Ok(Self {
            root: root.to_path_buf(),
            checked_dirs,
        })
    }

    pub(crate) fn resolve(&mut self, entry_path: &str) -> Result<PathBuf, String> {
        let relative = validate_entry_path(entry_path)?;
        let mut current = self.root.clone();
        for component in relative.parent().unwrap_or_else(|| Path::new("")).components() {
            let Component::Normal(part) = component else {
                return Err("缓存 entry_path 父目录组件无效".to_string());
            };
            current.push(part);
            if !current.exists() {
                continue;
            }
            if self.checked_dirs.insert(current.clone()) {
                reject_link(&current, "")?;
                if !current.is_dir() {
                    return Err(format!("缓存路径组件不是目录: {}", current.display()));
                }
            }
        }
        let full = self.root.join(relative);
        if !full.starts_with(&self.root) {
            return Err("缓存路径越界".to_string());
        }
        // 文件自身仍逐条检查，避免把 symlink/junction 当作缓存命中。
        reject_link(&full, "文件")?;
        Ok(full)
    }
}
