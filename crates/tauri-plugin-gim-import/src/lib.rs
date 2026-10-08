use tauri::{plugin::{Builder, TauriPlugin}, Runtime};
#[cfg(target_os = "android")]
struct ImportHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);
#[tauri::command]
async fn pick<R: Runtime>(app: tauri::AppHandle<R>, progress: tauri::ipc::Channel<serde_json::Value>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; app.state::<ImportHandle<R>>().0.run_mobile_plugin("pick", serde_json::json!({"progress": progress})).map_err(|e| e.to_string()) }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, progress); Err("SAF 文件选择仅在 Android 应用中可用".into()) }
}
#[tauri::command]
async fn cancel<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; let _: serde_json::Value = app.state::<ImportHandle<R>>().0.run_mobile_plugin("cancel", serde_json::json!({})).map_err(|e| e.to_string())?; }
    #[cfg(not(target_os = "android"))]
    { let _ = app; }
    Ok(())
}
#[tauri::command]
async fn check_location_permissions<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; app.state::<ImportHandle<R>>().0.run_mobile_plugin("checkLocationPermissions", serde_json::json!({})).map_err(|e| e.to_string()) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; Err("定位仅在 Android 应用中可用".into()) }
}
#[tauri::command]
async fn request_location_permissions<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; app.state::<ImportHandle<R>>().0.run_mobile_plugin("requestLocationPermissions", serde_json::json!({})).map_err(|e| e.to_string()) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; Err("定位仅在 Android 应用中可用".into()) }
}
#[tauri::command]
async fn get_position<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; app.state::<ImportHandle<R>>().0.run_mobile_plugin("getPosition", serde_json::json!({})).map_err(|e| e.to_string()) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; Err("定位仅在 Android 应用中可用".into()) }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gim-import")
        .invoke_handler(tauri::generate_handler![pick, cancel, check_location_permissions, request_location_permissions, get_position])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            { use tauri::Manager; let handle = _api.register_android_plugin("com.gimviewer.importer", "GimImportPlugin")?; _app.manage(ImportHandle(handle)); }
            Ok(())
        }).build()
}
