mod db;
mod benchmark;
mod tree_export;
mod gim_extract;
mod gim_extract_command;
mod seven_zip_cli;
mod substation_parse_copy;
mod substation_extraction_job;
mod substation_extraction_profile;

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
fn ensure_fixed_webview2_acl() {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let Ok(exe_path) = std::env::current_exe() else {
        return;
    };
    let Some(exe_dir) = exe_path.parent() else {
        return;
    };
    let runtime_dir = exe_dir.join("webview2-fixed-runtime");
    if !runtime_dir.join("msedgewebview2.exe").is_file() {
        return;
    }

    // 标记保存在本机用户目录，并绑定运行时绝对路径。不能放进 portable 目录，
    // 否则用户把已运行过的目录复制到另一台电脑时会错误跳过 ACL 初始化。
    let mut path_hasher = DefaultHasher::new();
    runtime_dir
        .to_string_lossy()
        .to_ascii_lowercase()
        .hash(&mut path_hasher);
    // A replacement at the same portable path must not inherit an old marker.
    if let Ok(metadata)=fs::metadata(runtime_dir.join("msedgewebview2.exe")) {
        metadata.len().hash(&mut path_hasher);
        metadata.modified().ok().hash(&mut path_hasher);
    }
    "appcontainer-rx-medium-integrity-v1".hash(&mut path_hasher);
    let marker_dir = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("com.bamboosjtu.gimviewer")
        .join("webview2-acl");
    let marker_path = marker_dir.join(format!("{:016x}.ready", path_hasher.finish()));
    if marker_path.is_file() {
        return;
    }

    // WebView2 Fixed Runtime 120+ 在 Windows 10 的非安装应用中需要给
    // ALL APPLICATION PACKAGES / ALL RESTRICTED APPLICATION PACKAGES 读取权限。
    // 权限设置失败时仍继续启动，让 WebView2 返回原始错误；安装版目录通常已具备权限。
    let mut all_succeeded = true;
    for sid in ["*S-1-15-2-2:(OI)(CI)(RX)", "*S-1-15-2-1:(OI)(CI)(RX)"] {
        let succeeded = Command::new("icacls.exe")
            .arg(&runtime_dir)
            .args(["/grant", sid, "/T", "/C", "/Q"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        all_succeeded &= succeeded;
    }

    // Sandboxed child creation blocks Low-labelled executable images. Files
    // extracted into a Low-labelled workspace inherit that label even when
    // the AppContainer RX ACL is correct. Keep Chromium mitigations enabled.
    all_succeeded &= Command::new("icacls.exe")
        .arg(&runtime_dir)
        .args(["/setintegritylevel", "(OI)(CI)M", "/T", "/C", "/Q"])
        .creation_flags(CREATE_NO_WINDOW)
        .status().map(|status|status.success()).unwrap_or(false);

    if all_succeeded {
        let _ = fs::create_dir_all(&marker_dir);
        let _ = fs::write(marker_path, b"WebView2 Fixed Runtime ACL initialized\n");
    }
}

#[cfg(not(windows))]
fn ensure_fixed_webview2_acl() {}

#[derive(Serialize)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
    modified_ms: u64,
    sha256: String,
}

/// 由后端文件选择器登记的文件路径。
///
/// WebView 传入的绝对路径不能直接视为可信输入。只有经过原生文件对话框选择、
/// canonicalize 并登记的文件才能进入读取/解压命令。
pub struct AuthorizedFilePaths(pub std::sync::Mutex<HashSet<String>>);

/// 原始源文件读取上限，避免恶意路径触发无界内存分配。
const MAX_SOURCE_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SOURCE_HEAD_BYTES: u64 = 1024 * 1024;

fn canonical_identity(path: &Path) -> Result<(PathBuf, String), String> {
    let canonical = fs::canonicalize(path).map_err(|e| format!("规范化文件路径失败: {}", e))?;
    let meta = fs::metadata(&canonical).map_err(|e| format!("读取文件元信息失败: {}", e))?;
    if !meta.is_file() {
        return Err("选择的路径不是普通文件".to_string());
    }
    if meta.len() > MAX_SOURCE_FILE_BYTES {
        return Err(format!(
            "源文件过大（{} 字节，超过 {} 字节上限）",
            meta.len(),
            MAX_SOURCE_FILE_BYTES
        ));
    }
    let mut identity = canonical.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        identity = identity.to_ascii_lowercase();
    }
    Ok((canonical, identity))
}

pub(crate) fn authorize_selected_path(
    access: &AuthorizedFilePaths,
    path: &Path,
    expected_extension: Option<&str>,
) -> Result<String, String> {
    let (canonical, identity) = canonical_identity(path)?;
    if let Some(ext) = expected_extension {
        let actual = canonical
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default();
        if !actual.eq_ignore_ascii_case(ext) {
            return Err(format!("只允许选择 .{} 文件", ext));
        }
    }
    let mut paths = access
        .0
        .lock()
        .map_err(|e| format!("获取文件授权锁失败: {}", e))?;
    paths.insert(identity.clone());
    Ok(identity)
}

pub(crate) fn require_authorized_path(
    access: &AuthorizedFilePaths,
    path: &str,
    expected_extension: Option<&str>,
) -> Result<PathBuf, String> {
    let (canonical, identity) = canonical_identity(Path::new(path))?;
    if let Some(ext) = expected_extension {
        let actual = canonical
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default();
        if !actual.eq_ignore_ascii_case(ext) {
            return Err(format!("只允许读取 .{} 文件", ext));
        }
    }
    let paths = access
        .0
        .lock()
        .map_err(|e| format!("获取文件授权锁失败: {}", e))?;
    if !paths.contains(&identity) {
        return Err("文件路径未经原生文件对话框授权".to_string());
    }
    Ok(canonical)
}

mod file_dialog_commands {
    use super::*;

    /// 开发版性能采集用：登记一个本地 GIM 路径，绕过系统文件选择器的
    /// 模态窗口，但仍复用同一 canonicalize/扩展名/文件大小校验。发布版
    /// 保留命令签名但始终拒绝，避免页面注入路径扩大生产信任边界。
    #[tauri::command]
    pub fn authorize_gim_file_path_for_dev(
        access: tauri::State<'_, AuthorizedFilePaths>,
        path: String,
    ) -> Result<String, String> {
        #[cfg(debug_assertions)]
        {
            return authorize_selected_path(&access, Path::new(&path), Some("gim"));
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = (access, path);
            Err("开发性能采集命令仅在 debug 构建可用".to_string())
        }
    }

    /// 后端 GIM 文件选择器，同时登记 canonical path 授权。
    #[tauri::command]
    pub async fn pick_gim_file_path(
        app_handle: tauri::AppHandle,
        access: tauri::State<'_, AuthorizedFilePaths>,
    ) -> Result<Option<String>, String> {
        let selected = tauri::async_runtime::spawn_blocking(move || {
            app_handle
                .dialog()
                .file()
                .add_filter("GIM 文件", &["gim"])
                .blocking_pick_file()
        })
        .await
        .map_err(|e| format!("打开 GIM 文件对话框失败: {}", e))?;
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|e| format!("获取 GIM 文件路径失败: {}", e))?;
        Ok(Some(authorize_selected_path(&access, &path, Some("gim"))?))
    }

    /// 后端 IFC 多选文件选择器，同时登记 canonical path 授权。
    #[tauri::command]
    pub async fn pick_ifc_file_paths(
        app_handle: tauri::AppHandle,
        access: tauri::State<'_, AuthorizedFilePaths>,
    ) -> Result<Option<Vec<String>>, String> {
        let selected = tauri::async_runtime::spawn_blocking(move || {
            app_handle
                .dialog()
                .file()
                .add_filter("IFC 文件", &["ifc"])
                .blocking_pick_files()
        })
        .await
        .map_err(|e| format!("打开 IFC 文件对话框失败: {}", e))?;
        let Some(selected) = selected else {
            return Ok(None);
        };
        let mut paths = Vec::with_capacity(selected.len());
        for file_path in selected {
            let path = file_path
                .into_path()
                .map_err(|e| format!("获取 IFC 文件路径失败: {}", e))?;
            paths.push(authorize_selected_path(&access, &path, Some("ifc"))?);
        }
        Ok(Some(paths))
    }
}

#[tauri::command]
fn get_file_info(
    access: tauri::State<'_, AuthorizedFilePaths>,
    path: String,
) -> Result<FileInfo, String> {
    let p = require_authorized_path(&access, &path, None)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let modified = meta.modified().map_err(|e| e.to_string())?;
    let modified_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // 分块读取计算 sha256，避免一次性加载大文件到内存
    let file = fs::File::open(&p).map_err(|e| e.to_string())?;
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, file); // 8MB buffer
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8 * 1024 * 1024]; // 堆分配，避免栈溢出
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let hash = hasher.finalize();
    let sha256 = format!("{:x}", hash);

    Ok(FileInfo {
        path: p.to_string_lossy().to_string(),
        name,
        size: meta.len(),
        modified_ms,
        sha256,
    })
}

/// 当前 Tauri 后端进程的驻留集大小（RSS）。
///
/// WebView2 子进程与 Rust 后端是不同进程，因此该值只代表后端进程；前端
/// 性能埋点会把 source 一并记录，不能将它当作 JS heap 或整个进程树 RSS。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMemorySnapshot {
    pid: u32,
    rss_bytes: Option<u64>,
    source: String,
    rss_source: String,
    process_tree_rss_bytes: Option<u64>,
    process_tree_private_bytes: Option<u64>,
    root_private_bytes: Option<u64>,
    process_instances: Vec<(u32, String)>,
    process_count: Option<u32>,
    process_tree_available: bool,
    process_tree_source: String,
    process_tree_reason: Option<String>,
}

#[cfg(windows)]
fn current_process_id() -> u32 {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcessId() -> u32;
    }
    // SAFETY: GetCurrentProcessId has no preconditions.
    unsafe { GetCurrentProcessId() }
}

#[cfg(windows)]
mod windows_process_tree;

struct ProcessTreeSnapshot {
    rss_bytes: Option<u64>,
    private_bytes: Option<u64>,
    root_private_bytes: Option<u64>,
    process_instances: Vec<(u32, String)>,
    process_count: Option<u32>,
    available: bool,
    source: String,
    reason: Option<String>,
}

#[cfg(windows)]
fn process_tree_snapshot(pid: u32) -> ProcessTreeSnapshot {
    let snapshot = windows_process_tree::snapshot(pid);
    ProcessTreeSnapshot {
        rss_bytes: snapshot.rss_bytes,
        private_bytes: snapshot.private_bytes,
        root_private_bytes: snapshot.root_private_bytes,
        process_instances: snapshot.process_instances,
        process_count: snapshot.process_count,
        available: snapshot.available,
        source: snapshot.source,
        reason: snapshot.reason,
    }
}

#[cfg(not(windows))]
fn process_tree_snapshot(_pid: u32) -> ProcessTreeSnapshot {
    ProcessTreeSnapshot {
        rss_bytes: None,
        private_bytes: None,
        root_private_bytes: None,
        process_instances: Vec::new(),
        process_count: None,
        available: false,
        source: "unavailable-non-windows".to_string(),
        reason: Some("process-tree-enumeration-not-implemented".to_string()),
    }
}

#[cfg(all(test, windows))]
mod memory_private_tests {
    #[test]
    fn reads_private_commit_for_current_process_tree() {
        // Touch pages so this checks committed memory, not just a reserved VA.
        let committed = vec![17u8; 16 * 1024 * 1024];
        std::hint::black_box(&committed);
        let snapshot = super::process_tree_snapshot(super::current_process_id());
        assert!(snapshot.available, "{:?}", snapshot.reason);
        assert!(snapshot.rss_bytes.unwrap() > 0);
        assert!(snapshot.private_bytes.unwrap() >= committed.len() as u64);
        assert!(snapshot.root_private_bytes.unwrap() >= committed.len() as u64);
        assert!(snapshot.process_instances.iter().any(|(pid,_)|*pid==super::current_process_id()));
        assert_eq!(snapshot.source, "windows-process-tree-working-set");
    }
}

#[cfg(windows)]
fn current_process_rss_bytes() -> Option<u64> {
    use std::ffi::c_void;
    use std::mem::size_of;

    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
    }
    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut c_void,
            size: u32,
        ) -> i32;
    }

    // SAFETY: Win32 returns a pseudo-handle valid for the current process;
    // counters is a properly sized writable C struct for this API.
    unsafe {
        let mut counters = ProcessMemoryCounters {
            cb: size_of::<ProcessMemoryCounters>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged_pool_usage: 0,
            quota_paged_pool_usage: 0,
            quota_peak_non_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
        };
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters as *mut _ as *mut c_void, counters.cb) != 0 {
            Some(counters.working_set_size as u64)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn current_process_rss_bytes() -> Option<u64> {
    // Keep the command portable without adding a runtime dependency. Linux
    // builds can read /proc; other targets report unavailable explicitly.
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/self/statm").ok()?;
        let resident_pages = text.split_whitespace().nth(1)?.parse::<u64>().ok()?;
        let page_size = 4096u64;
        return resident_pages.checked_mul(page_size);
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[tauri::command]
fn get_process_memory() -> ProcessMemorySnapshot {
    #[cfg(windows)]
    let pid = current_process_id();
    #[cfg(not(windows))]
    let pid = std::process::id();
    let source = if cfg!(windows) {
        "tauri-process-working-set".to_string()
    } else if cfg!(target_os = "linux") {
        "tauri-process-proc-statm".to_string()
    } else {
        "tauri-process-unavailable".to_string()
    };
    let tree = process_tree_snapshot(pid);
    ProcessMemorySnapshot {
        pid,
        rss_bytes: current_process_rss_bytes(),
        rss_source: source.clone(),
        source,
        process_tree_rss_bytes: tree.rss_bytes,
        process_tree_private_bytes: tree.private_bytes,
        root_private_bytes: tree.root_private_bytes,
        process_instances: tree.process_instances,
        process_count: tree.process_count,
        process_tree_available: tree.available,
        process_tree_source: tree.source,
        process_tree_reason: tree.reason,
    }
}

/// 读取任意路径文件的原始字节。路径信任边界见上方 `get_file_info` 注释。
#[tauri::command]
fn read_file_bytes(
    access: tauri::State<'_, AuthorizedFilePaths>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let p = require_authorized_path(&access, &path, None)?;
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Read a bounded prefix for source inspection without loading the archive.
#[tauri::command]
fn read_file_head(
    access: tauri::State<'_, AuthorizedFilePaths>,
    path: String,
    max_bytes: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let p = require_authorized_path(&access, &path, Some("gim"))?;
    let requested = max_bytes.unwrap_or(MAX_SOURCE_HEAD_BYTES);
    let limit = requested.min(MAX_SOURCE_HEAD_BYTES) as usize;
    let file = fs::File::open(p).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(limit);
    file.take(limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_fixed_webview2_acl();
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if substation_extraction_job::has_running_job() {
                    api.prevent_close();
                    substation_extraction_job::cancel_all();
                    let window = window.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        while substation_extraction_job::has_running_job() {
                            std::thread::sleep(std::time::Duration::from_millis(25));
                        }
                        let _ = window.close();
                    });
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = db::init_db(app.handle())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(db::DbState(std::sync::Mutex::new(conn)));
            app.manage(AuthorizedFilePaths(std::sync::Mutex::new(HashSet::new())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tree_export::save_engineering_tree_json,
            read_file_bytes,
            read_file_head,
            get_file_info,
            get_process_memory,
            file_dialog_commands::authorize_gim_file_path_for_dev,
            benchmark::benchmark_authorize_sample,
            file_dialog_commands::pick_gim_file_path,
            file_dialog_commands::pick_ifc_file_paths,
            gim_extract_command::extract_gim_archive,
            gim_extract_command::read_extraction_manifest,
            substation_parse_copy::read_substation_parse_copy,
            substation_extraction_job::inspect_substation_early_eligibility,
            substation_extraction_job::start_substation_extraction,
            substation_extraction_job::substation_extraction_status,
            substation_extraction_job::read_substation_extraction_source,
            substation_extraction_job::cancel_substation_extraction,
            db::upsert_gim_project,
            db::save_gim_index,
            db::save_substation_semantic_rest,
            db::write_cache_file_binary,
            db::read_cached_ifc,
            db::read_cached_entry,
            db::batch_read_cached_files,
            db::read_line_semantic_pack,
            db::read_line_semantic_pack_all,
            db::write_glb_file_binary,
            db::read_glb_file,
            db::read_device_lod_artifacts,
            db::write_device_lod_artifact,
            db::delete_device_lod_artifact,
            db::batch_read_glb_files,
            db::read_geometry_cache_manifest,
            db::write_geometry_cache_version,
            db::write_geometry_cache_manifest,
            db::invalidate_glb_cache_entry,
            db::get_gim_index,
            db::validate_gim_cache,
            db::get_db_path,
            db::get_latest_project_cache_diagnostic,
            db::get_line_gim_graph,
            db::save_line_graph_begin,
            db::save_line_attrs_chunk,
            db::save_line_project_finish,
            db::get_line_attributes,
            db::list_cached_projects,
            db::get_app_settings,
            db::set_app_setting,
            db::authorize_cached_gim_project,
            db::touch_gim_project_opened,
            db::delete_project_cache,
            db::get_project_diagnostic,
            db::save_geometry_refs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
fn workspace_test_temp() -> std::path::PathBuf {
    let root=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tmp/tests/native");
    std::fs::create_dir_all(&root).expect("workspace test directory must be writable");root
}

/// Acceptance executables embed a workspace-only data root; production keeps Tauri's normal location.
pub(crate) fn application_data_dir(app:&tauri::AppHandle)->Result<PathBuf,String> {
    #[cfg(feature = "benchmark")]
    { let _=app; benchmark::data_root() }
    #[cfg(not(feature = "benchmark"))]
    {
        if let Some(root)=option_env!("GIM_ACCEPTANCE_DATA_ROOT") {return Ok(PathBuf::from(root));}
        app.path().app_data_dir().map_err(|error|error.to_string())
    }
}
