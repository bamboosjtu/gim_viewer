//! Blocking command work owns its inputs and keeps locks entirely off the async/IPC threads.

pub(crate) async fn blocking<T, F>(command: &'static str, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("原生后台任务失败 ({command}): {error}"))?
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
            assert_eq!(blocking::<(), _>("error-test", || Err("source changed".into())).await,
                Err("source changed".into()));
            let error = blocking::<(), _>("panic-test", || panic!("worker panic")).await.unwrap_err();
            assert!(error.contains("panic-test"));
            assert_eq!(blocking("recovery-test", || Ok(42)).await.unwrap(), 42);
        });
    }
}
