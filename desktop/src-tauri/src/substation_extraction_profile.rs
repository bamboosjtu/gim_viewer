use crate::gim_extract::{is_core_semantic_path, ExtractionEntryTiming};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticCheckpoint {
    pub semantic_inputs_decoded_at: f64,
    pub semantic_inputs_written_at: f64,
    pub semantic_bytes_decoded_at: u64,
    pub remaining_archive_after_semantic: u64,
    pub remaining_entries_after_semantic: usize,
    pub large_ifc_decoded_before_semantic: bool,
    pub physical_order: usize,
}
pub fn checkpoint(entries: &[ExtractionEntryTiming]) -> Option<SemanticCheckpoint> {
    let last = entries
        .iter()
        .rev()
        .find(|e| is_core_semantic_path(&e.path))?;
    let total = entries.last()?.cumulative_bytes;
    Some(SemanticCheckpoint {
        semantic_inputs_decoded_at: last.decoded_at_ms,
        semantic_inputs_written_at: last.sink_complete_at_ms,
        semantic_bytes_decoded_at: last.cumulative_bytes,
        remaining_archive_after_semantic: total - last.cumulative_bytes,
        remaining_entries_after_semantic: entries.len() - last.physical_order,
        large_ifc_decoded_before_semantic: entries.iter().any(|e| {
            e.physical_order <= last.physical_order
                && e.path.to_ascii_lowercase().ends_with(".ifc")
                && e.size >= 64 * 1024 * 1024
        }),
        physical_order: last.physical_order,
    })
}
