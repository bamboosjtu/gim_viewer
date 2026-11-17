use std::{fs,io,path::Path};

/// icacls /T must never traverse a junction or another reparse point. This
/// metadata-only walk runs only before ACL initialization, not for project IO.
pub(crate) fn validate_runtime_tree(root:&Path)->io::Result<()> {
    let mut pending=vec![root.to_path_buf()];
    while let Some(path)=pending.pop() {
        let metadata=fs::symlink_metadata(&path)?;
        #[cfg(windows)] let reparse={use std::os::windows::fs::MetadataExt;metadata.file_attributes()&0x400!=0};
        #[cfg(not(windows))] let reparse=metadata.file_type().is_symlink();
        if reparse || metadata.file_type().is_symlink() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput,format!("WebView2 runtime contains a link/reparse point: {}",path.display())));
        }
        if metadata.is_dir(){for entry in fs::read_dir(&path)?{pending.push(entry?.path());}}
        else if !metadata.is_file(){return Err(io::Error::new(io::ErrorKind::InvalidInput,"Unsupported runtime entry"));}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_linked_runtime_subtrees_before_recursive_acl_changes() {
        let root=crate::workspace_test_temp().join(format!("runtime-tree-{}",std::process::id()));
        let runtime=root.join("runtime");let target=root.join("outside-runtime");let link=runtime.join("linked");
        fs::create_dir_all(&runtime).unwrap();fs::create_dir_all(&target).unwrap();fs::write(target.join("preserved"),b"unchanged").unwrap();
        assert!(validate_runtime_tree(&runtime).is_ok());
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            let result=std::process::Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-WindowStyle","Hidden","-Command",
                "New-Item -ItemType Junction -Path $env:GIM_TEST_LINK -Target $env:GIM_TEST_TARGET -ErrorAction Stop | Out-Null"])
                .env("GIM_TEST_LINK",&link).env("GIM_TEST_TARGET",&target).creation_flags(0x08000000).status().unwrap();
            assert!(result.success());
        }
        #[cfg(unix)] std::os::unix::fs::symlink(&target,&link).unwrap();
        assert!(validate_runtime_tree(&runtime).is_err());assert!(validate_runtime_tree(&link).is_err());
        assert_eq!(fs::read(target.join("preserved")).unwrap(),b"unchanged");
        #[cfg(windows)] fs::remove_dir(&link).unwrap();
        #[cfg(unix)] fs::remove_file(&link).unwrap();
        assert!(validate_runtime_tree(&runtime).is_ok());fs::remove_dir_all(root).unwrap();
    }
}
