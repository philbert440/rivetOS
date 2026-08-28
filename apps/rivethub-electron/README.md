# RivetHub Desktop (Electron)

Thin Electron shell over `apps/rivethub-web` — replaces the Tauri shell
(`apps/rivethub-desktop`). Same surface: tray with show/hide + new-window +
quit, global shortcuts (Ctrl+Shift+R summon, Ctrl+Shift+N new window), native
escalation notifications, close-to-tray for the main window, single instance,
and the loopback mTLS pipe (#491) for device-identity gateway auth — now
implemented in Node (`src/main/mtls-pipe.ts`) instead of Rust.

Why Electron: WebKitGTK (Tauri's Linux webview) cannot present TLS client
certificates and hosts xterm.js on its slowest render path. Chromium fixes the
terminal; the Node main process holds the device identity as the same PEM
files rivet-ca.sh issues, so enrollment is unchanged.

## Build

Not an npm workspace (same as the Tauri shell): CI never downloads Electron
binaries; the desktop builds on the desktop.

```sh
cd apps/rivethub-web && npm run build          # the UI the shell bundles
cd ../rivethub-electron
npm install
npm run test                                    # pipe + asset-resolver units
npm run dist                                    # AppImage (linux) / NSIS (win)
# artifacts land in release/
```

`npm run dev` bundles main+preload and launches Electron against the sibling
`rivethub-web/dist` without packaging.

## Device identity

Looked up per call, preferred first:

1. `<userData>/mtls/` — e.g. `~/.config/RivetHub/mtls/`
2. `~/.config/dev.rivetos.rivethub/mtls/` — the Tauri shell's dir, so an
   already-enrolled device migrates with zero touches.

Files: `device.crt`, `device.key` (rivet-ca.sh issue-client leaf), `ca.pem`.
Missing material is a soft per-call error — http nodes keep working, and
identity dropped in mid-run engages without a relaunch.

## Renderer contract

The preload exposes `window.rivetShell` (see `src/preload.ts`); the web app
feature-detects it in `src/lib/shell-bridge.ts` alongside the legacy
`__TAURI__` shapes (still used by the Android WebView shim). The UI is served
over `app://bundle` with the same CSP the Tauri config enforced.
