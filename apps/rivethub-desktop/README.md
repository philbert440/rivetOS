# @rivetos/rivethub-desktop

A thin [Tauri v2](https://tauri.app) shell around `@rivetos/rivethub-web`.
The webview loads the built web dist; the native layer adds a tray, a global
summon shortcut, close-to-tray, and OS notifications for escalations when the
window isn't focused.

## Deliberately outside the JS build graph

This app is **not** an npm workspace or an nx project — same rationale as the
Android client: it's built where a desktop lives, not in CI. The canonical
build uses the native Tauri CLI (`cargo install tauri-cli`), so no
platform-specific npm binary has to resolve over the shared filesystem.

```sh
# one-time: rust toolchain + linux webview deps (Arch/CachyOS shown)
sudo pacman -S --needed rustup base-devel webkit2gtk-4.1 \
  libappindicator-gtk3 librsvg
rustup default stable
cargo install tauri-cli --version '^2.0' --locked

# build the web dist first (the shell bundles it as frontendDist)
npx nx build @rivetos/rivethub-web

# then the shell (from this directory)
cargo tauri build          # or: cargo tauri dev
```

Artifacts land in `src-tauri/target/` (or `$CARGO_TARGET_DIR`); both `target/`
and the generated `gen/` are gitignored.

## Native features

- **Tray** — left-click summons/hides the main window; right-click menu has
  Show, New Window, and Quit. Closing the main window hides to tray (Quit is
  the deliberate exit); additional windows close for real.
- **Multi-window** — `Ctrl+Shift+N` (or the tray's New Window) opens another
  RivetHub window over the same app; each has its own view (own active
  conversation), sharing the node roster via localStorage.
- **Global shortcut** — `Ctrl+Shift+R` toggles the main window from anywhere.
- **Notifications** — the web app feature-detects `window.__TAURI__`
  (`withGlobalTauri`) and forwards escalation/task frames to the OS
  notification plugin when the window is hidden or unfocused; the in-app
  toast still covers the focused case. No Tauri dependency leaks into the web
  package.

## Not in v1

Auto-update (needs signing/update-server infra — its own follow-up), custom
protocol/deep links.
