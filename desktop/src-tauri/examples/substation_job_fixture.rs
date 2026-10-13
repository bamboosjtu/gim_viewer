//! Small native job fault inputs, generated locally; no original sample is edited.
use sevenz_rust::{Password, SevenZArchiveEntry, SevenZReader, SevenZWriter};
use std::{fs, io::Cursor, path::Path};
fn package(items: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    {
        let mut w = SevenZWriter::new(&mut output).unwrap();
        for (name, bytes) in items {
            let mut e = SevenZArchiveEntry::new();
            e.name = name.to_string();
            e.has_stream = !bytes.is_empty();
            w.push_archive_entry(e, Some(Cursor::new(bytes))).unwrap();
        }
        w.finish().unwrap();
    }
    let mut gim = b"GIMPKGS\0fixture\0local\0\0\0\0".to_vec();
    gim.extend(output.into_inner());
    gim
}
fn main() {
    let root = std::env::args().nth(1).expect("output directory");
    let root = Path::new(&root);
    fs::create_dir_all(root).unwrap();
    let core = ("CBM/project.cbm", b"TYPE=SS\r\n".to_vec());
    let fam = ("DEV/a.fam", b"[test]\r\nk=v\r\nk=v2\r\n".to_vec());
    let mut seed = 7u32;
    let data: Vec<u8> = (0..16384)
        .map(|_| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 24) as u8
        })
        .collect();
    let valid = package(&[core.clone(), fam.clone(), ("MOD/a.mod", data)]);
    fs::write(root.join("valid.gim"), &valid).unwrap();
    let offset = valid
        .windows(6)
        .position(|w| w == [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
        .unwrap();
    let reader = SevenZReader::new(
        Cursor::new(&valid[offset..]),
        (valid.len() - offset) as u64,
        Password::empty(),
    )
    .unwrap();
    let archive = reader.archive();
    let p = archive.stream_map.folder_first_pack_stream_index[2];
    let corrupt_at = offset
        + 32
        + archive.pack_pos as usize
        + archive.stream_map.pack_stream_offsets[p] as usize
        + archive.pack_sizes[p] as usize / 2;
    let mut corrupt = valid.clone();
    corrupt[corrupt_at] ^= 0x80;
    fs::write(root.join("later-crc-failure.gim"), corrupt).unwrap();
    let mut malformed = valid;
    malformed[offset + 8] ^= 1;
    fs::write(root.join("malformed.gim"), malformed).unwrap();
    fs::write(
        root.join("quota.gim"),
        package(&[core.clone(), ("MOD/big.mod", vec![0; 16 * 1024 * 1024])]),
    )
    .unwrap();
    fs::write(
        root.join("traversal.gim"),
        package(&[("../escape.cbm", b"x".to_vec())]),
    )
    .unwrap();
    fs::write(
        root.join("copy-name-collision.gim"),
        package(&[
            core,
            fam,
            (
                "_substation-parse-copy.bin",
                b"original source, not an acceleration copy".to_vec(),
            ),
        ]),
    )
    .unwrap();
}
