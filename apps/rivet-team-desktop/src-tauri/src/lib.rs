// Thin webview over the bundled rivet-team-web dist.
// Hub chrome (tray, global shortcuts, mTLS byte-pipe) is intentionally absent.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running rivet-team");
}
