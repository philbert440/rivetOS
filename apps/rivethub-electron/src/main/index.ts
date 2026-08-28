/**
 * RivetHub desktop shell — Electron main. Feature-parity port of the Tauri
 * shell (apps/rivethub-desktop): webview over the bundled rivethub-web dist,
 * tray with show/hide + new-window + quit, global shortcuts (Ctrl+Shift+R
 * summon, Ctrl+Shift+N new window), native notifications, close-to-tray for
 * the main window, single instance, and the loopback mTLS pipe (#491) — here
 * implemented in Node (mtls-pipe.ts) instead of Rust.
 *
 * Renderer isolation: contextIsolation on, sandbox on, nodeIntegration off.
 * The preload's `window.rivetShell` is the entire shell surface.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  protocol,
  session,
  shell,
  Tray,
} from 'electron'
import { PipeState } from './mtls-pipe.js'
import { registerIpc } from './ipc.js'
import { APP_ORIGIN, APP_SCHEME, serveDist } from './serve-dist.js'

// Must run before app ready: privileges are part of scheme registration.
// `secure: false` is DELIBERATE: a secure origin would mixed-content-block
// fetch/WS to plain http:// LAN nodes, which must keep working. The web app
// is already built for insecure contexts (IPC clipboard bridge, uuid
// fallback); flipping this later would not change the origin, so
// localStorage survives either way.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: false, supportFetchAPI: true, stream: true },
  },
])

/** Bundled web UI: packaged → resources/web; dev → the sibling app's dist. */
function distDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.resolve(__dirname, '../../rivethub-web/dist')
}

/**
 * Device identity for gateway mTLS. The Electron shell's own config dir is
 * preferred; the Tauri shell's dir (dev.rivetos.rivethub) is the fallback so
 * an already-enrolled device migrates with zero touches. Resolved per call —
 * enrolling mid-run must work without a relaunch.
 */
function identityDir(): string {
  const own = path.join(app.getPath('userData'), 'mtls')
  if (fs.existsSync(path.join(own, 'device.crt'))) return own
  const legacy = path.join(app.getPath('appData'), 'dev.rivetos.rivethub', 'mtls')
  if (fs.existsSync(path.join(legacy, 'device.crt'))) return legacy
  return own
}

const pipes = new PipeState(identityDir)

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
/** Base tray tooltip — carries a shortcut-conflict warning for app lifetime
 *  so it survives unread-count rewrites. */
let baseTip = 'RivetHub'

function createWindow(isMain: boolean): BrowserWindow {
  const win = new BrowserWindow({
    title: 'RivetHub',
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, '../icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  // External links: the web app routes clicks through rivetShell.openExternal,
  // but anything that still calls window.open must land in the browser, never
  // in a new privileged shell window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Top-frame navigation stays on the bundled origin: a target=_self link or
  // a location assignment from rendered content must not walk the privileged
  // window (preload attached) off to an arbitrary origin. Main-frame-only —
  // den iframes navigate freely.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })
  if (isMain) {
    // close-to-tray for the MAIN window only (Quit is a deliberate act via
    // the tray menu); additional windows close for real so they don't
    // accumulate hidden.
    win.on('close', (e) => {
      if (!quitting) {
        e.preventDefault()
        win.hide()
      }
    })
  }
  void win.loadURL(`${APP_ORIGIN}/index.html`)
  return win
}

/** Tray "Show": unconditionally bring the window forward — never a hide,
 *  even when it's already focused. */
function showMain(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Left-click tray / Ctrl+Shift+R: hide when already front-and-center,
 *  otherwise summon. */
function toggleMain(): void {
  if (!mainWindow) return
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide()
  else showMain()
}

function spawnWindow(): void {
  createWindow(false)
}

function setUnread(count: number): void {
  tray?.setToolTip(count === 0 ? baseTip : `${baseTip} — ${count} unread`)
}

// Single instance: launching again must summon the existing window, not
// spawn a second tray + a shortcut-registration fight.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMain)

  void app.whenReady().then(() => {
    serveDist(protocol, distDir())
    registerIpc({ pipes, setUnread })

    // Deny every renderer permission request (camera/mic/geolocation/…).
    // Electron's default handler GRANTS, and den iframes render LAN-served
    // content. The app needs none of them: notifications ride the main
    // process, clipboard rides IPC.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => {
      cb(false)
    })

    // Register each global shortcut and SURFACE a conflict (another app
    // owning the combo at the OS level): stderr for terminal launches, the
    // tray tooltip for the GUI case, where a dead summon is otherwise
    // indistinguishable from "app is broken".
    const failed: string[] = []
    for (const [combo, label, handler] of [
      ['Control+Shift+R', 'Ctrl+Shift+R (summon)', toggleMain],
      ['Control+Shift+N', 'Ctrl+Shift+N (new window)', spawnWindow],
    ] as const) {
      let ok = false
      try {
        ok = globalShortcut.register(combo, handler)
      } catch {
        ok = false
      }
      if (!ok) {
        console.error(
          `RivetHub: global shortcut ${label} was NOT registered — another application probably owns it`,
        )
        failed.push(label)
      }
    }
    if (failed.length > 0) baseTip = `RivetHub — shortcut conflict: ${failed.join(', ')} not registered`

    const icon = nativeImage.createFromPath(path.join(__dirname, '../icons/icon.png'))
    tray = new Tray(icon.resize({ width: 24, height: 24 }))
    tray.setToolTip(baseTip)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show RivetHub', click: showMain },
        { label: 'New Window', click: spawnWindow },
        {
          label: 'Quit',
          click: () => {
            quitting = true
            app.quit()
          },
        },
      ]),
    )
    // Left click summons; right click opens the menu. On Linux appindicator
    // hosts click events never arrive — the menu is the fallback there.
    tray.on('click', toggleMain)

    Menu.setApplicationMenu(null)
    mainWindow = createWindow(true)
  })
}

// Tray app: closing every window must not exit (main hides to tray; extra
// windows close for real). Quit is the tray's job on every platform.
app.on('window-all-closed', () => {
  /* keep running */
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  pipes.dispose()
})
