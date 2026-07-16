mod db;

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use tauri::Manager;

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

// ===== 路径信任边界（review0709.md §3.3 问题 4） =====
//
// `get_file_info` 与 `read_file_bytes` 接受前端传入的任意绝对路径，是本后端最强的
// 特权边界：前端可借此读取本机任意可访问文件。这是查看器有意为之的设计——GIM/IFC
// 文件路径由用户通过 Tauri 文件对话框选择，后端不二次校验路径范围。
//
// 安全前提：
//   1. 这些命令只供查看器自身的 GIM/IFC 读取流程调用，前端不应将其暴露给任意输入。
//   2. 缓存写入路径（`write_cache_file` 等）走的是 db.rs 的 `validate_entry_path`，
//      与本节的"任意路径读取"是两套独立的信任模型——后者严格隔离路径遍历，前者信任前端。
//   3. 如未来需要收紧（例如只允许读取用户上次选择目录下的文件），应在此处加白名单校验，
//      而不是改动 db.rs 的缓存路径防护。

#[tauri::command]
fn get_file_info(path: String) -> Result<FileInfo, String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
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
    let file = fs::File::open(p).map_err(|e| e.to_string())?;
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
        path,
        name,
        size: meta.len(),
        modified_ms,
        sha256,
    })
}

/// 读取任意路径文件的原始字节。路径信任边界见上方 `get_file_info` 注释。
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| e.to_string())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            get_file_info,
            db::upsert_gim_project,
            db::save_gim_index,
            db::write_cache_file,
            db::read_cached_ifc,
            db::batch_read_cached_files,
            db::write_glb_file,
            db::read_glb_file,
            db::glb_file_exists,
            db::write_geometry_cache_version,
            db::get_gim_index,
            db::validate_gim_cache,
            db::get_db_path,
            db::get_latest_project_cache_diagnostic,
            db::write_fragment_cache_file,
            db::read_fragment_cache_file,
            db::upsert_fragment_cache_record,
            db::get_fragment_cache_record,
            db::validate_fragment_cache,
            db::save_line_gim_graph,
            db::get_line_gim_graph,
            db::save_line_project_cache,
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
