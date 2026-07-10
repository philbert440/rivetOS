// RivetHub desktop shell (4j): webview over the bundled rivethub-web dist,
// tray with show/hide + new-window + quit, global shortcuts (Ctrl+Shift+R to
// summon the main window, Ctrl+Shift+N to open another), and native
// notifications — the web app feature-detects window.__TAURI__
// (withGlobalTauri) and forwards escalation frames to the notification plugin
// when the window is hidden/unfocused. Close-to-tray: the main window's X
// button hides instead of exiting (Quit lives in the tray menu); extra windows
// close for real.

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Monotonic suffix for additional window labels (main is "main").
static WINDOW_SEQ: AtomicU32 = AtomicU32::new(1);

/// Left-click tray / Ctrl+Shift+R: hide when already front-and-center,
/// otherwise summon the main window.
fn toggle_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = win.hide();
        } else {
            show_main(app);
        }
    }
}

/// Tray menu "Show": unconditionally bring the window forward — never a
/// hide, even when it's already focused (#306 review).
fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Open an additional RivetHub window — same bundled app, its own webview (so
/// its own in-memory session view; the node roster in localStorage is shared).
/// Extra windows get a unique label and close normally (only "main" hides to
/// tray), so they can't pile up hidden.
fn spawn_window(app: &tauri::AppHandle) {
    let label = format!("win-{}", WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    match WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("RivetHub")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .build()
    {
        Ok(win) => {
            let _ = win.set_focus();
        }
        Err(e) => eprintln!("RivetHub: failed to open a new window: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance: launching the AppImage again must summon the
        // existing window, not spawn a second tray + a shortcut-registration
        // fight. Registered FIRST so the second process exits before any
        // other plugin initializes (plugin docs requirement).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyR),
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN),
                ])
                .expect("valid shortcuts")
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // Ctrl+Shift+N → new window; the other registered shortcut
                    // (Ctrl+Shift+R) toggles the main window.
                    let new_window_sc =
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN);
                    if *shortcut == new_window_sc {
                        spawn_window(app);
                    } else {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Registration can fail silently when another app owns the
            // combo (the plugin swallows per-shortcut conflicts) — summon
            // just "doesn't work" with no signal. Verify and at least say so.
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                for (combo, label) in [
                    (
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyR),
                        "Ctrl+Shift+R (summon)",
                    ),
                    (
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN),
                        "Ctrl+Shift+N (new window)",
                    ),
                ] {
                    if !app.global_shortcut().is_registered(combo) {
                        eprintln!(
                            "RivetHub: global shortcut {label} was NOT registered — \
                             another application probably owns it"
                        );
                    }
                }
            }
            let show = MenuItem::with_id(app, "show", "Show RivetHub", true, None::<&str>)?;
            // no accelerator hint: the real binding is the global Ctrl+Shift+N
            // (registered above); a "CmdOrCtrl+N" hint here would mislead.
            let new_window =
                MenuItem::with_id(app, "new_window", "New Window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &new_window, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .tooltip("RivetHub")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "new_window" => spawn_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // left click summons; right click opens the menu
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // close-to-tray for the MAIN window only (Quit is a deliberate act
            // via the tray menu); additional windows close for real so they
            // don't accumulate hidden.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running RivetHub");
}
