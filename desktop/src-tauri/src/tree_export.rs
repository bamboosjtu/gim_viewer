use std::fs;
use tauri_plugin_dialog::DialogExt;

/// The destination is obtained by the backend dialog, never accepted from JS.
#[tauri::command]
pub async fn save_engineering_tree_json(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<Option<String>, String> {
    if content.len() > 384 * 1024 * 1024 {
        return Err("模型树 JSON 超过 384 MiB 导出上限".into());
    }
    let _: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("模型树 JSON 无效：{e}"))?;
    let name: String = filename
        .chars()
        .filter(|c| !"<>:\"/\\|?*".contains(*c) && !c.is_control())
        .take(120)
        .collect();
    let name = if name.to_lowercase().ends_with(".json") {
        name
    } else {
        format!("{name}.json")
    };
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .add_filter("JSON 模型树", &["json"])
            .set_file_name(&name)
            .blocking_save_file();
        let Some(selected) = selected else { return Ok(None); };
        let path = selected
            .into_path()
            .map_err(|e| format!("无法取得保存路径：{e}"))?;
        if !path
            .extension()
            .is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("json"))
        {
            return Err("请将模型树保存为 .json 文件".into());
        }
        fs::write(&path, content.as_bytes()).map_err(|e| format!("模型树保存失败：{e}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("模型树导出任务失败：{e}"))?
}
