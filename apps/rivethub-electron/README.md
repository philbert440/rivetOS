# RivetHub Desktop (Electron)

Thin Electron shell over `apps/rivethub-web`: tray with show/hide +
new-window + quit, multi-window (tray, right-click menu, or Ctrl+Shift+N),
a summon shortcut (Ctrl+Shift+R — global only while the app is unfocused),
native notifications with click-through, close-to-tray for the main window,
window-bounds persistence, single instance, in-app updates from the mesh
filestore, and the loopback mTLS pipe (#491) for device-identity gateway
auth (`src/main/mtls-pipe.ts`).

Chromium is here for the terminal (xterm.js) and for TLS done in the Node
main process, which holds the device identity as the same PEM files
rivet-ca.sh issues — enrollment is unchanged.

No application menu is installed on Windows (menu accelerators add
per-keystroke main-process work — terminal typing lag); window-management
chords are handled in the renderer (`rivethub-web/src/lib/shell-keys.ts`)
and forwarded over `window.rivetShell`. Linux/macOS keep an
accelerator-bearing menu with the bar hidden off macOS.

Main-process faults, renderer crashes, and startup errors are appended to
`<userData>/logs/main.log`. If the tray cannot be created (unreadable icon,
no SNI host), the shell runs trayless: close-to-tray is disabled — closing
the last window quits instead of hiding behind nothing.

## Build

Not an npm workspace: CI never downloads Electron binaries; the desktop
builds on the desktop.

```sh
cd apps/rivethub-web && npm run build          # the UI the shell bundles
cd ../rivethub-electron
npm install
npm run test                                    # pure-logic + pipe units
npm run dist                                    # AppImage (linux) / NSIS (win)
# artifacts land in release/
```

`npm run dev` bundles main+preload and launches Electron against the sibling
`rivethub-web/dist` without packaging. `npm run publish-mesh` publishes this
platform's build to the mesh filestore for in-app updates.

## Device identity

Looked up per call, preferred first:

1. `<userData>/mtls/` — e.g. `~/.config/RivetHub/mtls/`
2. `~/.config/dev.rivetos.rivethub/mtls/` — the legacy (Tauri-era) dir, so an
   already-enrolled device migrates with zero touches.

Files: `device.crt`, `device.key` (rivet-ca.sh issue-client leaf), `ca.pem`.
Missing material is a soft per-call error — http nodes keep working, and
identity dropped in mid-run engages without a relaunch.

## Renderer contract

The preload exposes `window.rivetShell` (see `src/preload.ts`); the web app
feature-detects it in `src/lib/shell-bridge.ts` alongside the legacy
`__TAURI__` shapes (still used by the Android WebView shim). The UI is served
over `app://bundle` with the CSP in `src/main/serve-dist.ts`.
