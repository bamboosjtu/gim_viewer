use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings { pub tianditu_key: String, pub base_layer: String }
impl Default for Settings {
    fn default() -> Self { Self { tianditu_key: String::new(), base_layer: "imagery".into() } }
}
#[derive(Serialize, Deserialize)]
struct SavedSettings { version: u32, settings: Settings }

fn decode(bytes: &[u8]) -> Settings {
    if let Ok(saved) = serde_json::from_slice::<SavedSettings>(bytes) {
        return if saved.version == 2 { saved.settings } else { Settings::default() };
    }
    // The old format cannot distinguish the automatically saved embedded key from user input.
    // Retain the base layer, but require explicit key configuration once on upgrade.
    let mut legacy = serde_json::from_slice::<Settings>(bytes).unwrap_or_default();
    legacy.tianditu_key.clear(); legacy
}
pub fn load(root: &Path) -> Settings {
    std::fs::read(root.join("settings.json")).map(|bytes| decode(&bytes)).unwrap_or_default()
}
pub fn save(root: &Path, settings: Settings) -> Result<(), String> {
    if settings.tianditu_key.len() > 128 || !settings.tianditu_key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') || !["imagery", "vector", "terrain", "osm", "canvas"].contains(&settings.base_layer.as_str()) { return Err("地图设置无效".into()); }
    let saved = SavedSettings { version: 2, settings };
    std::fs::write(root.join("settings.json"), serde_json::to_vec(&saved).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_install_and_legacy_settings_require_manual_key() {
        assert!(Settings::default().tianditu_key.is_empty());
        let legacy = decode(br#"{"tiandituKey":"development-secret","baseLayer":"terrain"}"#);
        assert!(legacy.tianditu_key.is_empty()); assert_eq!(legacy.base_layer, "terrain");
        assert!(decode(b"damaged").tianditu_key.is_empty());
    }
    #[test]
    fn explicitly_saved_key_survives_reload_and_can_be_cleared() {
        for key in ["user-configured-key", ""] {
            let bytes = serde_json::to_vec(&SavedSettings { version: 2, settings: Settings { tianditu_key: key.into(), base_layer: "vector".into() } }).unwrap();
            let settings = decode(&bytes); assert_eq!(settings.tianditu_key, key); assert_eq!(settings.base_layer, "vector");
        }
    }
}
