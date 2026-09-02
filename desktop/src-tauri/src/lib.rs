mod db;
mod gim_extract;
mod gim_extract_command;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_fixed_webview2_acl();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = db::init_db(app.handle())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(db::DbState(std::sync::Mutex::new(conn)));
            app.manage(AuthorizedFilePaths(std::sync::Mutex::new(HashSet::new())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            get_file_info,
            file_dialog_commands::authorize_gim_file_path_for_dev,
            file_dialog_commands::pick_gim_file_path,
            file_dialog_commands::pick_ifc_file_paths,
            gim_extract_command::extract_gim_archive,
            db::upsert_gim_project,
            db::save_gim_index,
            db::write_cache_file_binary,
            db::read_cached_ifc,
            db::read_cached_entry,
            db::batch_read_cached_files,
            db::read_line_semantic_pack,
            db::read_line_semantic_pack_all,
            db::write_glb_file_binary,
            db::read_glb_file,
            db::write_geometry_cache_version,
            db::write_geometry_cache_manifest,
            db::get_gim_index,
            db::validate_gim_cache,
            db::get_db_path,
            db::get_latest_project_cache_diagnostic,
            db::write_fragment_cache_file_binary,
            db::read_fragment_cache_file,
            db::upsert_fragment_cache_record,
            db::get_fragment_cache_record,
            db::validate_fragment_cache,
            db::delete_fragment_cache_record,
            db::save_line_gim_graph,
            db::get_line_gim_graph,
            db::save_line_graph_begin,
            db::save_line_attrs_chunk,
            db::save_line_project_finish,
            db::get_line_attributes,
            db::list_cached_projects,
            db::delete_project_cache,
            db::delete_glb_cache,
            db::get_project_diagnostic,
            db::save_geometry_refs,
            db::get_reachable_geometry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
