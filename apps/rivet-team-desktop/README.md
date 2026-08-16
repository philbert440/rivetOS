# @rivetos/rivet-team-desktop

Thin Tauri v2 shell around rivet-team-web. Same posture as rivethub-desktop:
the webview loads the web dist. This slice does not add Hub chrome (tray,
shortcuts, mTLS pipe). Built where a desktop lives, not in CI.

Identifier: dev.rivetos.rivetteam

## Run

1. Install a stable Rust toolchain and tauri-cli 2.x on the desktop machine.
2. Build or serve the web app (port 5180 for dev).
3. From this directory: cargo tauri dev   (uses devUrl 127.0.0.1:5180)
4. Or: cargo tauri build   (bundles apps/rivet-team-web/dist)

Artifacts land in src-tauri/target/ (gitignored).
