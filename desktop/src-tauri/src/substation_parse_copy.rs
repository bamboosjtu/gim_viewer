//! Optional cold-parse acceleration copy. Independent extracted files remain authoritative.
use crate::db::{cache_file_path, ensure_project_exists, DbState};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};

pub const COPY_PATH: &str = "_substation-parse-copy.bin";
pub const MAX_COPY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize, Clone)]
pub struct CopyReceipt {
    pub size: usize,
    pub sha256: String,
}

#[derive(Serialize)]
struct Entry {
    path: String,
    offset: usize,
    size: usize,
}

#[derive(Default)]
pub struct ParseCopy {
    entries: Vec<Entry>,
    bytes: Vec<u8>,
}

impl ParseCopy {
    pub fn append(&mut self, path: &str, bytes: &[u8]) -> Result<(), String> {
        if path.to_ascii_lowercase().ends_with(".ifc") || bytes.len() > 256 * 1024 {
            return Ok(());
        }
        if self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|n| *n <= MAX_COPY_BYTES)
            .is_none()
        {
            return Err("parse copy exceeds bounded data size".into());
        }
        self.entries.push(Entry {
            path: path.to_string(),
            offset: self.bytes.len(),
            size: bytes.len(),
        });
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    pub fn finish(self, staging: &Path) -> Result<CopyReceipt, String> {
        let index = serde_json::to_vec(&self.entries).map_err(|e| e.to_string())?;
        if index.len() > MAX_COPY_BYTES {
            return Err("parse copy index exceeds limit".into());
        }
        let mut payload = Vec::with_capacity(4 + index.len() + self.bytes.len());
        payload.extend_from_slice(&(index.len() as u32).to_le_bytes());
        payload.extend_from_slice(&index);
        payload.extend_from_slice(&self.bytes);
        let receipt = CopyReceipt {
            size: payload.len(),
            sha256: format!("{:x}", Sha256::digest(&payload)),
        };
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(staging.join(COPY_PATH))
            .map_err(|e| e.to_string())?;
        file.write_all(&payload).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        Ok(receipt)
    }
}

#[tauri::command]
pub fn read_substation_parse_copy(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbState>,
    project_id: i64,
) -> Result<tauri::ipc::Response, String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ensure_project_exists(&conn, project_id)?;
    }
    // Reuse the production path/reparse checks; the caller cannot supply a pack path.
    let path = cache_file_path(&app, project_id, COPY_PATH)?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size > (2 * MAX_COPY_BYTES + 4) as u64 {
        return Err("parse copy exceeds limit".into());
    }
    use std::io::Read;
    let mut bytes = Vec::with_capacity(size as usize);
    std::io::Read::by_ref(&mut file)
        .take((2 * MAX_COPY_BYTES + 5) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 != size {
        return Err("parse copy changed while reading".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}
