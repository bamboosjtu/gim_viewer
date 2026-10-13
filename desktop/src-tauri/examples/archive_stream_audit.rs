//! Read-only archive inventory; --decode writes a separate research copy, never a cache.
use serde_json::json;
use std::{collections::HashMap, fs, io::Cursor, path::Path, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let input = fs::read(args.get(1).ok_or("GIM path required")?)?;
    if !input.starts_with(b"GIMPKGS") {
        return Err("substation GIM required".into());
    }
    let offset = input[..input.len().min(1024 * 1024)]
        .windows(6)
        .position(|w| w == [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
        .ok_or("7z signature missing")?;
    let output = Path::new(args.get(2).ok_or("output directory required")?);
    fs::create_dir_all(output)?;
    let mut reader = sevenz_rust::SevenZReader::new(
        Cursor::new(&input[offset..]),
        (input.len() - offset) as u64,
        sevenz_rust::Password::empty(),
    )?;
    let archive = reader.archive();
    let files: Vec<_> = archive
        .files
        .iter()
        .enumerate()
        .map(|(i, e)| {
            json!({
                "archiveIndex": i, "path": e.name, "size": e.size, "directory": e.is_directory,
                "hasStream": e.has_stream, "folder": archive.stream_map.file_folder_index[i],
                "class": classify(&e.name), "coreSemantic": classify(&e.name) == "A"
            })
        })
        .collect();
    let folders: Vec<_> = archive.folders.iter().enumerate().map(|(i, f)| {
        let p = archive.stream_map.folder_first_pack_stream_index[i];
        json!({"folder": i, "firstFileIndex": archive.stream_map.folder_first_file_index[i],
            "substreams": f.num_unpack_sub_streams, "unpackedBytes": f.get_unpack_size(),
            "packOffset": offset as u64 + 32 + archive.pack_pos + archive.stream_map.pack_stream_offsets[p],
            "packedBytes": archive.pack_sizes[p], "coders": format!("{:?}", f.coders)})
    }).collect();
    let lookup: HashMap<_, _> = archive
        .files
        .iter()
        .enumerate()
        .map(|(i, e)| (e.name.clone(), (i, archive.stream_map.file_folder_index[i])))
        .collect();
    fs::write(
        output.join("inventory.json"),
        serde_json::to_vec_pretty(&json!({
            "inputBytes": input.len(), "payloadOffset": offset, "folders": folders, "files": files
        }))?,
    )?;
    if args.get(3).map(String::as_str) != Some("--decode") {
        return Ok(());
    }
    let start = Instant::now();
    let mut rows = Vec::new();
    let mut cumulative = 0u64;
    reader.for_each_entries(|entry, stream| {
        if entry.is_directory { return Ok(true); }
        let path = entry.name.replace('\\', "/");
        // Research output has the same lexical traversal restriction as production.
        if path.contains(':') || path.starts_with('/') || path.split('/').any(|p| p == ".." || p.is_empty()) {
            return Err(sevenz_rust::Error::other("unsafe archive path"));
        }
        let began = Instant::now();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).map_err(sevenz_rust::Error::io)?;
        let decode_ms = began.elapsed().as_secs_f64() * 1000.0;
        let write = Instant::now();
        let target = output.join("sources").join(&path);
        fs::create_dir_all(target.parent().unwrap()).map_err(sevenz_rust::Error::io)?;
        fs::write(target, &bytes).map_err(sevenz_rust::Error::io)?;
        let write_ms = write.elapsed().as_secs_f64() * 1000.0;
        cumulative += bytes.len() as u64;
        let (index, folder) = lookup[&entry.name];
        rows.push(json!({"physicalOrder": rows.len() + 1, "archiveIndex": index,
            "path": path, "extension": Path::new(&path).extension().and_then(|v| v.to_str()),
            "folder": folder, "size": bytes.len(), "class": classify(&path),
            "coreSemantic": classify(&path) == "A", "decodeMs": decode_ms, "sinkWriteMs": write_ms,
            "decodedAtMs": (write - start).as_secs_f64() * 1000.0,
            "sinkCompleteAtMs": start.elapsed().as_secs_f64() * 1000.0, "cumulativeBytes": cumulative}));
        Ok(true)
    })?;
    fs::write(
        output.join("stream.json"),
        serde_json::to_vec_pretty(&json!({
            "wallMs": start.elapsed().as_secs_f64() * 1000.0, "entries": rows
        }))?,
    )?;
    Ok(())
}

fn classify(path: &str) -> &'static str {
    let p = path.to_ascii_lowercase();
    match p.rsplit('.').next().unwrap_or("") {
        "cbm" | "fam" | "dev" => "A", // Includes CBM/FileDevRelation.cbm.
        "phm" | "mod" | "gl" | "stl" => "B",
        "ifc" => "C",
        _ => "D",
    }
}
