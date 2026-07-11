mod db;

use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use serde::Serialize;
use sha2::{Sha256, Digest};
use tauri::Manager;

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
    let name = p.file_name()
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
        if n == 0 { break; }
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = db::init_db(app.handle()).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::Other, e)
            })?;
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
            db::batch_read_glb_files,
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
            db::get_project_diagnostic,
            db::save_geometry_refs,
            db::get_reachable_geometry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
