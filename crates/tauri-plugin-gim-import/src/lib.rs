use gim_native_core::{NativeError, NativeErrorCode, PickedFile};

#[cfg(any(target_os = "android", test))]
fn rejected_error(code: Option<String>, message: Option<String>) -> NativeError {
    let code = match code {
        Some(code) => serde_json::from_value::<NativeErrorCode>(serde_json::Value::String(code))
            .unwrap_or(NativeErrorCode::ProtocolInvalid),
        None => NativeErrorCode::OperationFailed,
    };
    NativeError::new(code, message.unwrap_or_else(|| "Android 平台操作失败".into()))
}

#[cfg(target_os = "android")]
fn platform_error(error: tauri::plugin::mobile::PluginInvokeError) -> NativeError {
    use tauri::plugin::mobile::PluginInvokeError;
    match error {
        PluginInvokeError::InvokeRejected(rejection) => rejected_error(rejection.code, rejection.message),
        PluginInvokeError::CannotDeserializeResponse(error) => {
            NativeError::new(NativeErrorCode::ResponseInvalid, error.to_string())
        }
        PluginInvokeError::CannotSerializePayload(error) => {
            NativeError::new(NativeErrorCode::ProtocolInvalid, error.to_string())
        }
        error => NativeError::new(NativeErrorCode::BackendUnavailable, error.to_string()),
    }
}
fn unavailable(message:&str) -> NativeError {
    NativeError::new(NativeErrorCode::BackendUnavailable, message)
}
use tauri::{plugin::{Builder, TauriPlugin}, Runtime};
#[cfg(target_os = "android")]
struct ImportHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);
#[tauri::command]
async fn pick<R: Runtime>(app: tauri::AppHandle<R>, progress: tauri::ipc::Channel<serde_json::Value>) -> Result<PickedFile, NativeError> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let archive_limit = gim_native_core::extraction_limits().mobile.max_archive_bytes;
        app.state::<ImportHandle<R>>().0.run_mobile_plugin_async("pick", serde_json::json!({
            "progress": progress,
            "maxArchiveBytes": archive_limit,
        })).await.map_err(platform_error)
    }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, progress); Err(unavailable("SAF 文件选择仅在 Android 应用中可用")) }
}
#[tauri::command]
async fn cancel<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), NativeError> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; let _: serde_json::Value = app.state::<ImportHandle<R>>().0.run_mobile_plugin_async("cancel", serde_json::json!({})).await.map_err(platform_error)?; }
    #[cfg(not(target_os = "android"))]
    { let _ = app; }
    Ok(())
}
#[tauri::command]
async fn check_location_permissions<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, NativeError> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; app.state::<ImportHandle<R>>().0.run_mobile_plugin("checkLocationPermissions", serde_json::json!({})).map_err(platform_error) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; Err(unavailable("定位仅在 Android 应用中可用")) }
}
#[tauri::command]
async fn request_location_permissions<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, NativeError> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; app.state::<ImportHandle<R>>().0.run_mobile_plugin("requestLocationPermissions", serde_json::json!({})).map_err(platform_error) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; Err(unavailable("定位仅在 Android 应用中可用")) }
}
#[tauri::command]
async fn get_position<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, NativeError> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; app.state::<ImportHandle<R>>().0.run_mobile_plugin("getPosition", serde_json::json!({})).map_err(platform_error) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; Err(unavailable("定位仅在 Android 应用中可用")) }
}
#[tauri::command]
async fn get_window_state<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, NativeError> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; app.state::<ImportHandle<R>>().0.run_mobile_plugin("getWindowState", serde_json::json!({})).map_err(platform_error) }
    #[cfg(not(target_os = "android"))]
    { let _ = app; Err(unavailable("窗口控制仅在 Android 应用中可用")) }
}
#[tauri::command]
async fn set_immersive<R: Runtime>(app: tauri::AppHandle<R>, enabled: bool) -> Result<serde_json::Value, NativeError> {
    #[cfg(target_os = "android")]
    { use tauri::Manager; app.state::<ImportHandle<R>>().0.run_mobile_plugin("setImmersive", serde_json::json!({"enabled":enabled})).map_err(platform_error) }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, enabled); Err(unavailable("窗口控制仅在 Android 应用中可用")) }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gim-import")
        .invoke_handler(tauri::generate_handler![pick, cancel, check_location_permissions, request_location_permissions, get_position, get_window_state, set_immersive])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            { use tauri::Manager; let handle = _api.register_android_plugin("com.gimviewer.importer", "GimImportPlugin")?; _app.manage(ImportHandle(handle)); }
            Ok(())
        }).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_codes_are_preserved_without_interpreting_the_message() {
        for (wire_code, expected) in [
            ("CANCELLED", NativeErrorCode::Cancelled),
            ("RESOURCE_LIMIT", NativeErrorCode::ResourceLimit),
            ("INVALID_INPUT", NativeErrorCode::InvalidInput),
            ("UNAUTHORIZED", NativeErrorCode::Unauthorized),
            ("IO", NativeErrorCode::Io),
        ] {
            let error = rejected_error(Some(wire_code.into()), Some("different wording".into()));
            assert_eq!(error.code, expected);
            assert_eq!(serde_json::to_value(error).unwrap(), serde_json::json!({
                "code": wire_code,
                "message": "different wording",
            }));
        }
        assert_eq!(rejected_error(None, Some("CANCELLED".into())).code, NativeErrorCode::OperationFailed);
        assert_eq!(rejected_error(Some("UNKNOWN".into()), None).code, NativeErrorCode::ProtocolInvalid);
    }
}
