use gim_native_core::{NativeError, NativeErrorCode};
mod storage;
mod settings;
use settings::Settings;
use std::{path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use tauri::{Emitter, Manager};
#[derive(Clone)]
struct Store { root: PathBuf, cancelled: Arc<AtomicBool>, busy: Arc<AtomicBool> }
struct ImportLease(Arc<AtomicBool>);
impl Drop for ImportLease {
    fn drop(&mut self) { self.0.store(false, Ordering::Release); }
}
#[cfg(test)]
mod threading_tests {
    use super::*;
    #[test]
    fn import_busy_lease_releases_on_failure_without_resetting_cancellation() {
        let busy=Arc::new(AtomicBool::new(true));let cancelled=Arc::new(AtomicBool::new(true));
        let held=busy.clone();
        let _=std::panic::catch_unwind(move || {let _lease=ImportLease(held);panic!("import failed");});
        assert!(!busy.load(Ordering::Acquire));assert!(cancelled.load(Ordering::Acquire));
    }
}
#[tauri::command]
async fn list_projects(store: tauri::State<'_, Store>) -> Result<Vec<storage::ProjectMeta>, NativeError> {
    let root = store.root.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(storage::list(&root).into_iter().filter(|m| !m.parser_version.is_empty()).collect()))
        .await.map_err(|error| NativeError::new(NativeErrorCode::Internal,error.to_string()))?
}
#[tauri::command]
async fn prepare_project(app: tauri::AppHandle, store: tauri::State<'_, Store>, input: storage::ImportFile) -> Result<storage::Prepared, NativeError> {
    let s = store.inner().clone();
    if s.busy.swap(true, Ordering::AcqRel) {
        return tauri::async_runtime::spawn_blocking(move || {
            storage::discard(&s.root, &input.path)?;
            Err("已有导入正在进行，请稍后重试".into())
        }).await.map_err(|error| NativeError::new(NativeErrorCode::Internal,error.to_string()))?;
    }
    s.cancelled.store(false, Ordering::Relaxed);
    let lease = ImportLease(s.busy.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        storage::prepare(&s.root, input, &s.cancelled, |stage, done, total| {
            let _ = app.emit("import-progress", serde_json::json!({"stage":stage,"done":done,"total":total}));
        })
    }).await.map_err(|e| NativeError::new(NativeErrorCode::Internal,e.to_string()))?
}
#[tauri::command]
async fn discard_import(store: tauri::State<'_, Store>, path: String) -> Result<(), NativeError> {
    let root = store.root.clone();
    tauri::async_runtime::spawn_blocking(move || storage::discard(&root, &path)).await.map_err(|error| NativeError::new(NativeErrorCode::Internal,error.to_string()))?
}
#[tauri::command]
fn cancel_import(store: tauri::State<Store>) { store.cancelled.store(true, Ordering::Relaxed); }
#[tauri::command]
async fn get_project_cache(store: tauri::State<'_, Store>, id: String) -> Result<tauri::ipc::Response, NativeError> { let s = store.inner().clone(); tauri::async_runtime::spawn_blocking(move || { storage::touch(&s.root, &id)?; Ok(tauri::ipc::Response::new(storage::cached_json(&s.root, &id).unwrap_or(None).unwrap_or_else(|| "null".into()))) }).await.map_err(|e| NativeError::new(NativeErrorCode::Internal,e.to_string()))? }
#[tauri::command]
async fn read_text_entries(store: tauri::State<'_, Store>, id: String) -> Result<Vec<storage::TextEntry>, NativeError> { let root = store.root.clone(); tauri::async_runtime::spawn_blocking(move || storage::text_entries(&root, &id)).await.map_err(|e| NativeError::new(NativeErrorCode::Internal,e.to_string()))? }
#[tauri::command]
async fn commit_project(store: tauri::State<'_, Store>, id: String, payload_json: String) -> Result<(), NativeError> { let root = store.root.clone(); tauri::async_runtime::spawn_blocking(move || storage::commit_json(&root, &id, payload_json)).await.map_err(|e| NativeError::new(NativeErrorCode::Internal,e.to_string()))? }
#[tauri::command]
async fn read_source(store: tauri::State<'_, Store>, id: String, path: String) -> Result<String, NativeError> { let root = store.root.clone(); tauri::async_runtime::spawn_blocking(move || storage::source(&root, &id, &path)).await.map_err(|e| NativeError::new(NativeErrorCode::Internal,e.to_string()))? }
#[tauri::command]
async fn read_project_header(store: tauri::State<'_, Store>, id: String) -> Result<Vec<u8>, NativeError> { let root = store.root.clone(); tauri::async_runtime::spawn_blocking(move || storage::header(&root, &id)).await.map_err(|e| NativeError::new(NativeErrorCode::Internal,e.to_string()))? }
#[tauri::command]
async fn delete_project(store: tauri::State<'_, Store>, id: String) -> Result<(), NativeError> {
    let root = store.root.clone();
    tauri::async_runtime::spawn_blocking(move || storage::delete(&root, &id)).await.map_err(|error| NativeError::new(NativeErrorCode::Internal,error.to_string()))?
}
#[tauri::command]
async fn preview_cache(store: tauri::State<'_, Store>, id: String, key: String, data: Option<serde_json::Value>) -> Result<Option<serde_json::Value>, NativeError> { let root = store.root.clone(); tauri::async_runtime::spawn_blocking(move || storage::preview(&root, &id, &key, data)).await.map_err(|e| NativeError::new(NativeErrorCode::Internal,e.to_string()))? }
#[tauri::command]
async fn get_settings(store: tauri::State<'_, Store>) -> Result<Settings, NativeError> {
    let root = store.root.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(settings::load(&root))).await.map_err(|error| NativeError::new(NativeErrorCode::Internal,error.to_string()))?
}
#[tauri::command]
async fn save_settings(store: tauri::State<'_, Store>, settings: Settings) -> Result<(), NativeError> {
    let root = store.root.clone();
    tauri::async_runtime::spawn_blocking(move || settings::save(&root, settings)).await.map_err(|error| NativeError::new(NativeErrorCode::Internal,error.to_string()))?
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

#[cfg(test)]
fn workspace_test_temp() -> std::path::PathBuf {
    let root=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tmp/tests/mobile-native");
    std::fs::create_dir_all(&root).expect("workspace test directory must be writable");root
}
