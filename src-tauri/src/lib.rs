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
            db::get_gim_index,
            db::validate_gim_cache,
            db::get_db_path,
            db::get_latest_project_cache_diagnostic,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
