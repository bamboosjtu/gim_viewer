//! Private local inventory using the same quota/path/container reader as the product.
//! stdin: one JSON path per line. stdout: anonymous counts only, no source names/errors.
use gim_native_core::{inspect_archive_entries, extract_from_path_with_quota, ExtractionQuota};
use std::{collections::BTreeMap, io::{self, BufRead}, path::Path};

fn main() {
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(path) = serde_json::from_str::<String>(&line) else { println!("{{\"status\":\"invalid-request\"}}"); continue };
        let mut counts = BTreeMap::<String,u64>::new();
        let mut bytes = 0u64;
        let mut files = 0u64;
        let mut add = |path: &str, size: u64| {
            let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            let key = match ext.as_str() { "cbm"|"dev"|"phm"|"mod"|"fam"|"stl"|"ifc"|"gl"|"sch"|"std"|"sld" => ext, _ => "other".into() };
            *counts.entry(key).or_default() += 1; bytes += size; files += 1;
        };
        let quota = ExtractionQuota::default();
        let (status, method) = match inspect_archive_entries(Path::new(&path), &quota) {
            Ok((_,_,entries)) => { for (name,size) in entries {add(&name,size);} ("available","native-archive-directory") },
            Err(error) if error == "not-7z-archive" => {
                match extract_from_path_with_quota(Path::new(&path),&quota,|name,data| {add(&name,data.len() as u64);Ok(())}) {
                    Ok(_) => ("available","native-zip-stream"), Err(_) => ("unavailable","native-zip-stream")
                }
            },
            Err(_) => ("unavailable","native-archive-directory"),
        };
        println!("{}",serde_json::json!({"status":status,"method":method,"files":files,"uncompressedBytes":bytes,"extensions":counts}));
    }
}
