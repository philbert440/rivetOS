# RivetHub Desktop (Electron)

Thin Electron shell over `apps/rivethub-web`: tray with show/hide +
new-window + quit, multi-window (tray, right-click menu, or Ctrl+Shift+N),
a summon shortcut (Ctrl+Shift+R — global only while the app is unfocused),
native notifications with click-through, close-to-tray for the main window,
window-bounds persistence, single instance, in-app updates from the mesh
filestore, and the loopback mTLS pipe (#491) for device-identity gateway
auth (`src/main/mtls-pipe.ts`).

Chromium is here for the terminal (xterm.js) and for TLS done in the Node
main process, which holds the device identity as PEM files (a step-ca
device leaf, see Device identity).

No application menu is installed on Windows or Linux (menu accelerators add
per-keystroke main-process work — terminal typing lag); window-management
chords are handled in the renderer (`rivethub-web/src/lib/shell-keys.ts`)
and forwarded over `window.rivetShell`. Only macOS installs a menu.

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

Files: `device.crt`, `device.key` (a 30-day step-ca device leaf with a
`spiffe://…/device/<user>/<device>` URI SAN), `ca.pem` (the mesh root).
The app does not enroll or renew by itself: run `rh cert renew --principal
<device SPIFFE id> --ca-url <step-ca> --trust-root <root> --state <dir>` as a
user service and point `device.crt`/`device.key` at its
`<dir>/tls/holder.{cert,key}.pem` (symlinks are fine). The first run needs a
one-time token minted by the operator. Missing material is a soft per-call
error — http nodes keep working — and identity dropped in or renewed mid-run
engages on the next connection without a relaunch.

## Renderer contract

The preload exposes `window.rivetShell` (see `src/preload.ts`); the web app
feature-detects it in `src/lib/shell-bridge.ts` alongside the legacy
`__TAURI__` shapes (still used by the Android WebView shim). The UI is served
over `app://bundle` with the CSP in `src/main/serve-dist.ts`.
