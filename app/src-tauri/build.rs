use std::{env, fs, path::PathBuf};
fn main() {
    // The bootstrap key is native-only; it never enters Vite's JavaScript bundle.
    let dotenv = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../.env");
    println!("cargo:rerun-if-changed={}", dotenv.display());
    let mut key = String::new();
    if let Ok(text) = fs::read_to_string(dotenv) {
        for line in text.lines() {
            if let Some(value) = line.trim().strip_prefix("VITE_TIANDITU_KEY=") {
                key = value.trim().trim_matches(|c| c == '\'' || c == '"').to_string();
            }
        }
    }
    let source = format!("pub const BOOTSTRAP_KEY: &str = {:?};\n", key);
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("bootstrap.rs"), source).unwrap();
    tauri_build::build()
}
