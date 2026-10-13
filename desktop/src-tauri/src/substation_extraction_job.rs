//! Opt-in desktop 7z job. Early sources are session-local, not a published cache.
use crate::db::{
    commit_cache_staging, create_cache_staging_dir, ensure_project_exists,
    remove_cache_dir_if_safe, BatchCachePathResolver, CacheStagingWriter, DbState,
};
use crate::gim_extract::{
    extract_substation_semantic_order_cancellable, inspect_substation_entries,
    is_core_semantic_path, ExtractionEntryTiming, ExtractionProfile, ExtractionQuota,
};
use crate::substation_parse_copy::{CopyReceipt, ParseCopy, COPY_PATH};
use crate::{require_authorized_path, AuthorizedFilePaths};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Instant,
};

type SharedJob = Arc<Mutex<Job>>;
static JOBS: OnceLock<Mutex<HashMap<String, SharedJob>>> = OnceLock::new();
static CLOSING: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
struct WorkerLease;
impl Drop for WorkerLease {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}
pub fn has_running_job() -> bool {
    ACTIVE.load(Ordering::Acquire) > 0
}
pub fn cancel_all() {
    CLOSING.store(true, Ordering::Release);
    CURRENT_START.store(0, Ordering::Release);
    if let Ok(jobs) = registry().lock() {
        for job in jobs.values() {
            if let Ok(j) = job.lock() {
                j.cancelled.store(true, Ordering::Release);
            }
        }
    }
}

static CURRENT_START: AtomicU64 = AtomicU64::new(0);
static NEXT: AtomicU64 = AtomicU64::new(1);
fn registry() -> &'static Mutex<HashMap<String, SharedJob>> {
    JOBS.get_or_init(Default::default)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    job_id: String,
    project_id: i64,
    source_sha256: String,
    status: String,
    entries: Vec<(String, u64)>,
    semantic_copy: Option<CopyReceipt>,
    semantic_ready_at_ms: Option<f64>,
    materialization_complete_at_ms: Option<f64>,
    materialized_entries: usize,
    error: Option<String>,
    profile: Option<ExtractionProfile>,
    trace: Vec<ExtractionEntryTiming>,
    cache_root: Option<String>,
}
impl JobSnapshot {
    fn clone_without_details(&self) -> Self {
        Self {
            job_id: self.job_id.clone(),
            project_id: self.project_id,
            source_sha256: self.source_sha256.clone(),
            status: self.status.clone(),
            entries: Vec::new(),
            trace: Vec::new(),
            semantic_copy: self.semantic_copy.clone(),
            semantic_ready_at_ms: self.semantic_ready_at_ms,
            materialization_complete_at_ms: self.materialization_complete_at_ms,
            materialized_entries: self.materialized_entries,
            error: self.error.clone(),
            profile: self.profile.clone(),
            cache_root: self.cache_root.clone(),
        }
    }
}
struct Job {
    snapshot: JobSnapshot,
    staging: PathBuf,
    final_root: PathBuf,
    ticket: u64,
    ready: HashSet<String>,
    cancelled: Arc<AtomicBool>,
}
fn get(id: &str) -> Result<SharedJob, String> {
    registry()
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or("extraction job unavailable".into())
}
pub(crate) fn source_sha(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Only explicit capability absence permits full-native fallback. Err is fail-closed.
#[tauri::command]
pub async fn inspect_substation_early_eligibility(
    access: tauri::State<'_, AuthorizedFilePaths>, db: tauri::State<'_, DbState>,
    file_path: String, project_id: i64, source_sha256: String,
) -> Result<crate::gim_extract::SubstationEarlyEligibility, String> {
    let path = require_authorized_path(&access, &file_path, Some("gim"))?;
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ensure_project_exists(&conn, project_id)?;
        let (record_path, record_sha): (String,String) = conn.query_row(
            "SELECT path, sha256 FROM gim_project WHERE id=?1", [project_id], |r| Ok((r.get(0)?,r.get(1)?)))
            .map_err(|e| e.to_string())?;
        if record_sha != source_sha256 || crate::canonical_identity(Path::new(&record_path))?.1 != crate::canonical_identity(&path)?.1 {
            return Err("extraction project/source identity mismatch".into());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        if source_sha(&path)? != source_sha256 { return Err("extraction source SHA mismatch".into()); }
        crate::gim_extract::inspect_substation_eligibility(&path, &ExtractionQuota::default())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_substation_extraction(
    app: tauri::AppHandle,
    access: tauri::State<'_, AuthorizedFilePaths>,
    db: tauri::State<'_, DbState>,
    file_path: String,
    project_id: i64,
    source_sha256: String,
) -> Result<JobSnapshot, String> {
    if CLOSING.load(Ordering::Acquire) {
        return Err("application closing".into());
    }
    let path = require_authorized_path(&access, &file_path, Some("gim"))?;
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ensure_project_exists(&conn, project_id)?;
        let (record_path, record_sha): (String, String) = conn
            .query_row(
                "SELECT path, sha256 FROM gim_project WHERE id=?1",
                [project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        if record_sha != source_sha256
            || crate::canonical_identity(Path::new(&record_path))?.1
                != crate::canonical_identity(&path)?.1
        {
            return Err("extraction project/source identity mismatch".into());
        }
    }
    ACTIVE.fetch_add(1, Ordering::AcqRel);
    let _start_lease = WorkerLease;
    let ticket = NEXT.fetch_add(1, Ordering::Relaxed);
    CURRENT_START.store(ticket, Ordering::Release);
    // Starting another job revokes all older publication rights, including the same project.
    for job in registry().lock().map_err(|e| e.to_string())?.values() {
        job.lock()
            .map_err(|e| e.to_string())?
            .cancelled
            .store(true, Ordering::Release);
    }
    let (entries, actual_sha) = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || {
            Ok::<_, String>((
                inspect_substation_entries(&path, &ExtractionQuota::default())?,
                source_sha(&path)?,
            ))
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    if CURRENT_START.load(Ordering::Acquire) != ticket || CLOSING.load(Ordering::Acquire) {
        return Err("extraction start superseded".into());
    }
    if actual_sha != source_sha256 {
        return Err("extraction source SHA mismatch".into());
    }
    let (final_root, staging) = create_cache_staging_dir(&app, project_id)?;
    let id = format!("{}-{}", std::process::id(), ticket);
    let snapshot = JobSnapshot {
        job_id: id.clone(),
        project_id,
        source_sha256,
        status: "running".into(),
        entries,
        semantic_copy: None,
        semantic_ready_at_ms: None,
        materialization_complete_at_ms: None,
        materialized_entries: 0,
        error: None,
        profile: None,
        trace: Vec::new(),
        cache_root: None,
    };
    let job = Arc::new(Mutex::new(Job {
        snapshot: snapshot.clone(),
        staging,
        final_root,
        ticket,
        ready: HashSet::new(),
        cancelled: Arc::new(AtomicBool::new(false)),
    }));
    {
        let mut jobs = registry().lock().map_err(|e| e.to_string())?;
        if CURRENT_START.load(Ordering::Acquire) != ticket || CLOSING.load(Ordering::Acquire) {
            let staging = job.lock().map_err(|e| e.to_string())?.staging.clone();
            let _ = remove_cache_dir_if_safe(&staging, " superseded staging");
            return Err("extraction start superseded".into());
        }
        jobs.insert(id, job.clone());
    }
    ACTIVE.fetch_add(1, Ordering::AcqRel);
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = WorkerLease;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_job(app, path, job.clone())
        }));
        if outcome.is_err() {
            let staging = {
                let mut j = job.lock().unwrap_or_else(|e| e.into_inner());
                j.snapshot.status = "failed".into();
                j.snapshot.error = Some("extraction worker panicked".into());
                j.staging.clone()
            };
            let _ = remove_cache_dir_if_safe(&staging, " failed early staging");
        }
    });
    Ok(snapshot)
}

fn run_job(app: tauri::AppHandle, path: PathBuf, job: SharedJob) {
    let started = Instant::now();
    let (staging, cancelled, expected_sha, required) = {
        let j = job.lock().unwrap();
        (
            j.staging.clone(),
            j.cancelled.clone(),
            j.snapshot.source_sha256.clone(),
            j.snapshot
                .entries
                .iter()
                .filter(|(p, _)| is_core_semantic_path(p))
                .count(),
        )
    };
    let result = (|| -> Result<(), String> {
        let mut writer = CacheStagingWriter::new(&staging)?;
        let expected_sizes: HashMap<String, u64> = job
            .lock()
            .map_err(|e| e.to_string())?
            .snapshot
            .entries
            .iter()
            .cloned()
            .collect();
        let copy_allowed = !job
            .lock()
            .map_err(|e| e.to_string())?
            .snapshot
            .entries
            .iter()
            .any(|(p, _)| p.eq_ignore_ascii_case(COPY_PATH));
        let mut semantic_copy = copy_allowed.then(ParseCopy::default);
        let mut semantic_written = 0;
        let (info, profile) = extract_substation_semantic_order_cancellable(
            &path,
            &ExtractionQuota::default(),
            |p, bytes| {
                if cancelled.load(Ordering::Acquire) {
                    return Err("extraction cancelled".into());
                }
                if expected_sizes.get(&p) != Some(&(bytes.len() as u64)) {
                    return Err("decoded source size mismatch".into());
                }
                writer.write_with_timing(&p, &bytes)?;
                let mut j = job.lock().map_err(|e| e.to_string())?;
                j.ready.insert(p.clone());
                j.snapshot.materialized_entries = j.ready.len();
                if is_core_semantic_path(&p) {
                    if let Some(copy) = semantic_copy.as_mut() {
                        if copy.append(&p, &bytes).is_err() {
                            semantic_copy = None;
                        }
                    }
                    semantic_written += 1;
                    if semantic_written == required {
                        j.snapshot.semantic_copy = semantic_copy
                            .take()
                            .and_then(|copy| copy.finish(&staging).ok());
                        j.snapshot.semantic_ready_at_ms =
                            Some(started.elapsed().as_secs_f64() * 1000.0);
                        j.snapshot.status = "semanticReady".into();
                    }
                }
                Ok(())
            },
            &mut |e| {
                if let Ok(mut j) = job.lock() {
                    j.snapshot.trace.push(e);
                }
            },
            &cancelled,
        )?;
        if info.magic != "GIMPKGS" || source_sha(&path)? != expected_sha {
            return Err("extraction source changed".into());
        }
        let mut j = job.lock().map_err(|e| e.to_string())?;
        // cancel and commit are a short serialized publication phase. Partial staging is never valid.
        if j.cancelled.load(Ordering::Acquire) || CURRENT_START.load(Ordering::Acquire) != j.ticket
        {
            return Err("extraction cancelled".into());
        }
        if j.ready.len() != j.snapshot.entries.len() || semantic_written != required {
            return Err("incomplete extraction".into());
        }
        commit_cache_staging(&app, j.snapshot.project_id, &staging)?;
        j.snapshot.profile = Some(profile);
        j.snapshot.materialization_complete_at_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
        j.snapshot.status = "complete".into();
        j.snapshot.cache_root = Some(j.final_root.to_string_lossy().to_string());
        Ok(())
    })();
    if let Err(error) = result {
        if let Ok(mut j) = job.lock() {
            j.snapshot.status = if cancelled.load(Ordering::Acquire) {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            j.snapshot.error = Some(error);
        }
        let _ = remove_cache_dir_if_safe(&staging, " early staging");
    }
}

#[tauri::command]
pub fn substation_extraction_status(
    job_id: String,
    details: Option<bool>,
) -> Result<JobSnapshot, String> {
    let job = get(&job_id)?;
    let j = job.lock().map_err(|e| e.to_string())?;
    // Polls do not clone/serialize 11k paths and timings.
    let mut snapshot = JobSnapshot {
        entries: Vec::new(),
        trace: Vec::new(),
        ..j.snapshot.clone_without_details()
    };
    if details == Some(true) {
        snapshot.entries = j.snapshot.entries.clone();
        snapshot.trace = j.snapshot.trace.clone();
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn read_substation_extraction_source(
    job_id: String,
    entry_path: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let job = get(&job_id)?;
    let j = job.lock().map_err(|e| e.to_string())?;
    if j.cancelled.load(Ordering::Acquire) || j.snapshot.status == "failed" {
        return Err("extraction unavailable".into());
    }
    let (path, expected_size) = if let Some(path) = entry_path {
        let expected = j
            .snapshot
            .entries
            .iter()
            .find(|(p, _)| p == &path)
            .ok_or("unknown source entry")?
            .1;
        if !j.ready.contains(&path) {
            return Err("source materializing".into());
        }
        (path, expected)
    } else {
        (
            COPY_PATH.to_string(),
            j.snapshot
                .semantic_copy
                .as_ref()
                .ok_or("source materializing")?
                .size as u64,
        )
    };
    let root = if j.snapshot.status == "complete" {
        &j.final_root
    } else {
        &j.staging
    };
    let mut resolver = BatchCachePathResolver::new(root)?;
    let file_path = resolver.resolve(&path)?;
    // Hold the short lifecycle lock across this read so commit cannot rename its source.
    use std::io::Read;
    let file = std::fs::File::open(file_path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != expected_size {
        return Err("source size mismatch".into());
    }
    let mut bytes = Vec::with_capacity(expected_size as usize);
    file.take(expected_size + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 != expected_size {
        return Err("source size mismatch".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn cancel_substation_extraction(job_id: String) -> Result<(), String> {
    let job = get(&job_id)?;
    job.lock()
        .map_err(|e| e.to_string())?
        .cancelled
        .store(true, Ordering::Release);
    registry()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&job_id);
    Ok(())
}
