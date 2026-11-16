use super::*;
use std::sync::{mpsc, Arc};

#[test]
fn queued_file_identity_uses_authorized_source_at_execution_time() {
    let root=workspace_test_temp().join("native-command-identity");
    fs::create_dir_all(&root).unwrap();
    let path=root.join("source.bin");
    fs::write(&path,b"old").unwrap();
    let access=Arc::new(AuthorizedFilePaths(std::sync::Mutex::new(HashSet::new())));
    let authorized=authorize_selected_path(&access,&path,None).unwrap();
    let (started_tx,started_rx)=mpsc::channel();
    let (continue_tx,continue_rx)=mpsc::channel();
    let work=tauri::async_runtime::spawn({
        let access=access.clone();
        async move {
            native_command::blocking("identity-test",move || {
                started_tx.send(()).unwrap();
                continue_rx.recv().unwrap();
                inspect_authorized_file(&access,&authorized)
            }).await
        }
    });
    started_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    fs::write(&path,b"abc").unwrap();
    continue_tx.send(()).unwrap();
    let info=tauri::async_runtime::block_on(work).unwrap().unwrap();
    assert_eq!(info.name,"source.bin");assert_eq!(info.size,3);
    assert_eq!(info.sha256,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    let unauthorized=AuthorizedFilePaths(std::sync::Mutex::new(HashSet::new()));
    assert!(inspect_authorized_file(&unauthorized,path.to_str().unwrap()).is_err());
}
