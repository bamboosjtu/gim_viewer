fn main() {
    // Workaround for Rust 1.96.0 std::process::Command::output() bug on Windows
    // that causes tauri_winres (which calls rustc_version) to panic.
    match std::panic::catch_unwind(|| {
        tauri_build::build()
    }) {
        Ok(_) => {}
        Err(_) => {
            println!("cargo:warning=tauri_build: Windows resource compilation skipped (Rust 1.96.0 process bug), embedding manifest via linker");

            let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
            let manifest_path = std::path::Path::new(&manifest_dir).join("app.manifest");

            if manifest_path.exists() {
                // Use MSVC linker's /MANIFEST:EMBED /MANIFESTINPUT to embed the manifest
                // This bypasses rc.exe and embed_resource entirely
                println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
                println!("cargo:rustc-link-arg-bins=/MANIFESTINPUT:{}", manifest_path.display());
                println!("cargo:rerun-if-changed=app.manifest");
            } else {
                println!("cargo:warning=app.manifest not found");
            }
        }
    }
}
