fn main() {
    tauri_plugin::Builder::new(&["pick", "cancel", "check_location_permissions", "request_location_permissions", "get_position"]).android_path("android").build();
}
