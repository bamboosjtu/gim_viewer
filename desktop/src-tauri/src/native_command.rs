//! Blocking command work owns its inputs and keeps locks entirely off the async/IPC threads.

use gim_native_core::{NativeError, NativeErrorCode};
pub(crate) async fn blocking<T, F>(command: &'static str, work: F) -> Result<T, NativeError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, NativeError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| NativeError::new(NativeErrorCode::Internal,format!("原生后台任务失败 ({command}): {error}")).operation(command))?
        .map_err(|error| error.operation(command))
}

#[cfg(test)]
mod tests {
    use super::blocking;

    #[test]
    fn work_and_errors_cross_the_blocking_boundary() {
        tauri::async_runtime::block_on(async {
            let caller = std::thread::current().id();
            let worker = blocking("thread-test", || Ok(std::thread::current().id())).await.unwrap();
            assert_ne!(caller, worker);
            let error=blocking::<(), _>("error-test", || Err("source changed".into())).await.unwrap_err();
            assert_eq!(error.code,gim_native_core::NativeErrorCode::OperationFailed);
            assert_eq!(error.message,"source changed");
            assert_eq!(error.context.unwrap().operation.as_deref(),Some("error-test"));
            let error = blocking::<(), _>("panic-test", || panic!("worker panic")).await.unwrap_err();
            assert!(error.message.contains("panic-test"));
            assert_eq!(error.code,gim_native_core::NativeErrorCode::Internal);
            assert_eq!(blocking("recovery-test", || Ok(42)).await.unwrap(), 42);
        });
    }
}
