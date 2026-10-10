mod storage;
mod settings;
use settings::Settings;
use std::{path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use tauri::{Emitter, Manager};
#[derive(Clone)]
struct Store { root: PathBuf, cancelled: Arc<AtomicBool>, busy: Arc<AtomicBool> }
#[tauri::command]
fn list_projects(store: tauri::State<Store>) -> Vec<storage::ProjectMeta> { storage::list(&store.root).into_iter().filter(|m| !m.parser_version.is_empty()).collect() }
#[tauri::command]
async fn prepare_project(app: tauri::AppHandle, store: tauri::State<'_, Store>, input: storage::ImportFile) -> Result<storage::Prepared, String> {
    let s = store.inner().clone();
    if s.busy.swap(true, Ordering::AcqRel) { storage::discard(&s.root, &input.path)?; return Err("已有导入正在进行，请稍后重试".into()); }
    s.cancelled.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || { let result = storage::prepare(&s.root, input, &s.cancelled, |stage, done, total| { let _ = app.emit("import-progress", serde_json::json!({"stage":stage,"done":done,"total":total})); }); s.busy.store(false, Ordering::Release); result }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn discard_import(store: tauri::State<Store>, path: String) -> Result<(), String> { storage::discard(&store.root, &path) }
#[tauri::command]
fn cancel_import(store: tauri::State<Store>) { store.cancelled.store(true, Ordering::Relaxed); }
#[tauri::command]
async fn get_project_cache(store: tauri::State<'_, Store>, id: String) -> Result<tauri::ipc::Response, String> { let s = store.inner().clone(); tauri::async_runtime::spawn_blocking(move || { storage::touch(&s.root, &id)?; Ok(tauri::ipc::Response::new(storage::cached_json(&s.root, &id).unwrap_or(None).unwrap_or_else(|| "null".into()))) }).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn read_text_entries(store: tauri::State<'_, Store>, id: String) -> Result<Vec<storage::TextEntry>, String> { let root = store.root.clone(); tauri::async_runtime::spawn_blocking(move || storage::text_entries(&root, &id)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn commit_project(store: tauri::State<'_, Store>, id: String, payload_json: String) -> Result<(), String> { let root = store.root.clone(); tauri::async_runtime::spawn_blocking(move || storage::commit_json(&root, &id, payload_json)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn read_source(store: tauri::State<'_, Store>, id: String, path: String) -> Result<String, String> { let root = store.root.clone(); tauri::async_runtime::spawn_blocking(move || storage::source(&root, &id, &path)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn read_project_header(store: tauri::State<'_, Store>, id: String) -> Result<Vec<u8>, String> { let root = store.root.clone(); tauri::async_runtime::spawn_blocking(move || storage::header(&root, &id)).await.map_err(|e| e.to_string())? }
#[tauri::command]
fn delete_project(store: tauri::State<Store>, id: String) -> Result<(), String> { storage::delete(&store.root, &id) }
#[tauri::command]
async fn preview_cache(store: tauri::State<'_, Store>, id: String, key: String, data: Option<serde_json::Value>) -> Result<Option<serde_json::Value>, String> { let root = store.root.clone(); tauri::async_runtime::spawn_blocking(move || storage::preview(&root, &id, &key, data)).await.map_err(|e| e.to_string())? }
#[tauri::command]
fn get_settings(store: tauri::State<Store>) -> Settings {
    settings::load(&store.root)
}
#[tauri::command]
fn save_settings(store: tauri::State<Store>, settings: Settings) -> Result<(), String> {
    settings::save(&store.root, settings)
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default().plugin(tauri_plugin_gim_import::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            #[cfg(target_os = "android")]
            let root = root.join("files"); // Tauri getDataDir is dataDir; SAF uses Android filesDir.
            std::fs::create_dir_all(&root)?;
            storage::clean_imports(&root).map_err(std::io::Error::other)?;
            app.manage(Store { root, cancelled: Arc::new(AtomicBool::new(false)), busy: Arc::new(AtomicBool::new(false)) }); Ok(())
        }).invoke_handler(tauri::generate_handler![list_projects,prepare_project,cancel_import,discard_import,get_project_cache,read_text_entries,commit_project,read_source,read_project_header,delete_project,preview_cache,get_settings,save_settings])
        .run(tauri::generate_context!()).expect("无法启动线路 GIM 应用");
}
