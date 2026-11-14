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
        return if saved.version == 1 { saved.settings } else { Settings::default() };
    }
    Settings::default()
}
pub fn load(root: &Path) -> Settings {
    std::fs::read(root.join("settings.json")).map(|bytes| decode(&bytes)).unwrap_or_default()
}
pub fn save(root: &Path, settings: Settings) -> Result<(), String> {
    if settings.tianditu_key.len() > 128 || !settings.tianditu_key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') || !["imagery", "vector", "terrain", "osm", "canvas"].contains(&settings.base_layer.as_str()) { return Err("地图设置无效".into()); }
    let saved = SavedSettings { version: 1, settings };
    std::fs::write(root.join("settings.json"), serde_json::to_vec(&saved).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicitly_saved_key_survives_reload_and_can_be_cleared() {
        for key in ["user-configured-key", ""] {
            let bytes = serde_json::to_vec(&SavedSettings { version: 1, settings: Settings { tianditu_key: key.into(), base_layer: "vector".into() } }).unwrap();
            let settings = decode(&bytes); assert_eq!(settings.tianditu_key, key); assert_eq!(settings.base_layer, "vector");
        }
    }
}
