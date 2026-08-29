/**
 * RivetHub desktop shell — Electron main. Feature-parity port of the Tauri
 * shell (apps/rivethub-desktop): webview over the bundled rivethub-web dist,
 * tray with show/hide + new-window + quit, a summon shortcut (Ctrl+Shift+R,
 * global only while unfocused), an accelerator-bearing application menu
 * (hidden bar on Linux/Windows), right-click context menus, clickable native
 * notifications, close-to-tray + bounds persistence for the main window,
 * single instance, and the loopback mTLS pipe (#491) — here implemented in
 * Node (mtls-pipe.ts) instead of Rust.
 *
 * Renderer isolation: contextIsolation on, sandbox on, nodeIntegration off.
 * The preload's `window.rivetShell` is the entire shell surface.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron'
import { PipeState } from './mtls-pipe.js'
import { registerIpc } from './ipc.js'
import { APP_ORIGIN, APP_SCHEME, serveDist } from './serve-dist.js'
import { legacySqlitePath, prepareMigration } from './tauri-storage-migration.js'
import { appMenuTemplate, type AppMenuItem } from './app-menu.js'
import { contextMenuTemplate } from './context-menu.js'
import { loadWindowState, saveWindowState, type WindowState } from './window-state.js'

// Unpackaged dev runs otherwise derive userData from the scoped package name
// (~/.config/@rivetos/rivethub-electron), so a dev-time enrollment would land
// where neither the packaged build nor the Tauri fallback ever looks (review
// finding, PR #555). Must precede any getPath('userData') use.
app.setName('RivetHub')

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

/** True only for the bundled app origin, by PARSED protocol+host — never a
 *  string-prefix test (Node's URL gives custom schemes origin 'null', so
 *  origin equality cannot be used either). */
function isBundledUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}` === APP_ORIGIN
  } catch {
    return false
  }
}

/** Parsed http(s) check — a prefix regex would pass junk after the scheme. */
function isWebUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
/** webContents ids of windows THIS shell created — the migration IPC's
 *  sender fence (frame URLs can still be empty at preload time). */
const shellWindowIds = new Set<number>()
/** Base tray tooltip — carries a shortcut-conflict warning for app lifetime
 *  so it survives unread-count rewrites. */
let baseTip = 'RivetHub'

/** Main-window bounds file — see window-state.ts. */
function windowStateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function createWindow(isMain: boolean): BrowserWindow {
  // Only the MAIN window restores saved bounds; extra windows take the
  // default so they don't stack pixel-exactly on top of the main one.
  const state: WindowState = isMain
    ? loadWindowState(
        windowStateFile(),
        screen.getAllDisplays().map((d) => d.workArea),
      )
    : { width: 1280, height: 820 }
  const win = new BrowserWindow({
    title: 'RivetHub',
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0d1117',
    // NO autoHideMenuBar: an auto-hide bar answers the single Alt key
    // (Electron docs), and Alt is a terminal modifier in den xterms. The
    // bar is fully hidden off macOS via setMenuBarVisibility(false) below;
    // application-menu accelerators work regardless (grok round 2).
    icon: path.join(__dirname, '../icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Explicit, not default-reliant: preloads must never load in den
      // iframes (review finding, PR #555).
      nodeIntegrationInSubFrames: false,
    },
  })
  shellWindowIds.add(win.webContents.id)
  win.on('closed', () => shellWindowIds.delete(win.webContents.id))
  // window.open: DENY, full stop — no shell.openExternal side door. The
  // handler cannot tell which frame asked, and den iframes render untrusted
  // LAN content that must not be able to drive the OS browser (cookies, CSRF
  // against local services — review finding, PR #555). The hub's own
  // external links ride rivetShell.openExternal, which is sender-fenced in
  // main; this matches the Tauri shell, where WebKitGTK dropped new-window
  // requests outright.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Right-click menu: pure template (context-menu.ts), roles route edit
  // actions to the FOCUSED frame (den iframes included) without the shell
  // reading their content; the only custom action is a validated-URL
  // clipboard write.
  win.webContents.on('context-menu', (_e, params) => {
    const template = contextMenuTemplate({
      isEditable: params.isEditable,
      selectionText: params.selectionText,
      linkURL: params.linkURL,
      mainFrame: params.frame === win.webContents.mainFrame,
      editFlags: params.editFlags,
    })
    if (template.length === 0) return
    Menu.buildFromTemplate(
      template.map((item): MenuItemConstructorOptions => {
        if (item.copyLink !== undefined) {
          const url = item.copyLink
          return {
            label: item.label,
            click: () => {
              void clipboard.writeText(url)
            },
          }
        }
        return item
      }),
    ).popup({ window: win })
  })
  if (isMain) {
    // Persist bounds — getNormalBounds so a maximized session restores to
    // the pre-maximize size, with maximized re-applied separately. The
    // maximized bit is TRACKED via events, not snapshotted at save time:
    // win.isMaximized() reads false while the window is minimized, which
    // would silently drop the flag on a minimize-then-quit (grok review of
    // this PR). Saves fire on close AND debounced on resize/move — hide-
    // via-summon never fires close, so a resize followed by a crash would
    // otherwise lose the geometry.
    let maximized = state.maximized === true
    win.on('maximize', () => {
      maximized = true
    })
    win.on('unmaximize', () => {
      maximized = false
    })
    const save = (): void => {
      if (win.isDestroyed()) return
      saveWindowState(windowStateFile(), {
        ...win.getNormalBounds(),
        ...(maximized ? { maximized: true } : {}),
      })
    }
    let saveTimer: NodeJS.Timeout | undefined
    const saveSoon = (): void => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(save, 1000)
    }
    win.on('resize', saveSoon)
    win.on('move', saveSoon)
    win.on('close', save)
    // a hidden main window can keep phantom focus on some Linux WMs — treat
    // hide as app-blur so the summon shortcut re-arms
    win.on('hide', onAppBlur)
  }
  // Top-frame navigation stays on the bundled origin: a target=_self link or
  // a location assignment from rendered content must not walk the privileged
  // window (preload attached) off to an arbitrary origin. Main-frame-only —
  // den iframes navigate freely. Parsed comparison, not a string prefix:
  // `app://bundle.evil.com` startsWith the origin string but is a different
  // host (review finding, PR #555).
  win.webContents.on('will-navigate', (e, url) => {
    if (!isBundledUrl(url)) {
      e.preventDefault()
      if (isWebUrl(url)) void shell.openExternal(url)
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
  // The menu exists for its accelerators; the BAR never shows off macOS.
  if (process.platform !== 'darwin') win.setMenuBarVisibility(false)
  if (isMain && state.maximized) win.maximize()
  void win.loadURL(`${APP_ORIGIN}/index.html`)
  return win
}

/** Tray "Show": unconditionally bring the window forward — never a hide,
 *  even when it's already focused. Destroyed guard: a late notification
 *  click during quit must no-op, not throw (grok review of this PR). */
function showMain(): void {
  // quitting: a notification click between before-quit and destroy must not
  // re-show a window that is on its way out
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return
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
  // Dock/taskbar badge where the platform has one (macOS dock, Unity
  // launcher); returns false elsewhere — the tooltip stays the fallback.
  try {
    app.setBadgeCount(Math.min(count, 999))
  } catch {
    /* badge is best-effort */
  }
}

/**
 * The summon shortcut is global ONLY while no shell window is focused.
 * A permanently-global Ctrl+Shift+R swallowed the combo even while the app
 * was frontmost — hiding the window mid-keystroke and starving xterm (and
 * the universal hard-reload reflex) of the key it was owed. An OS-level
 * grab cannot be conditionally forwarded, so registration itself follows
 * focus: register on blur, release on focus.
 */
const SUMMON_COMBO = 'Control+Shift+R'
let summonRegistered = false
let summonConflict = false

function setConflictTip(conflict: boolean): void {
  summonConflict = conflict
  baseTip = conflict
    ? 'RivetHub — shortcut conflict: Ctrl+Shift+R (summon) not registered'
    : 'RivetHub'
  tray?.setToolTip(baseTip)
}

function registerSummon(): void {
  // quitting is a hard inhibit: tray Quit blurs the windows on their way
  // out, and a re-grab racing will-quit's unregisterAll could leak the
  // grab past process exit.
  if (summonRegistered || quitting) return
  let ok: boolean
  try {
    ok = globalShortcut.register(SUMMON_COMBO, toggleMain)
  } catch {
    ok = false
  }
  summonRegistered = ok
  if (ok) {
    // a conflict can clear (the owning app quit) — un-lie the tooltip
    if (summonConflict) setConflictTip(false)
  } else if (!summonConflict) {
    console.error(
      'RivetHub: global shortcut Ctrl+Shift+R (summon) was NOT registered — another application probably owns it',
    )
    setConflictTip(true)
  }
}

function releaseSummon(): void {
  if (!summonRegistered) return
  try {
    globalShortcut.unregister(SUMMON_COMBO)
    // cleared ONLY on success: flipping the flag on a throw would leave the
    // OS grab live while the state machine thinks it's gone — the next
    // focus would skip the release and Ctrl+Shift+R would swallow keys
    // in-app again (grok review of this PR).
    summonRegistered = false
  } catch {
    /* keep summonRegistered=true so the next focus retries the release */
  }
}

/** Blur → re-grab, but deferred: blur also fires transiently between two
 *  shell windows, when the new context menu pops, and for undocked
 *  DevTools. Only a REST state with no focused window re-arms the grab. */
let blurTimer: NodeJS.Timeout | undefined
function onAppBlur(): void {
  if (blurTimer) clearTimeout(blurTimer)
  blurTimer = setTimeout(() => {
    blurTimer = undefined
    // a hidden window that the WM still reports focused counts as unfocused
    // — that phantom state is exactly why hide feeds this path
    const focused = BrowserWindow.getFocusedWindow()
    if (focused === null || !focused.isVisible()) registerSummon()
  }, 150)
}

// Single instance: launching again must summon the existing window, not
// spawn a second tray + a shortcut-registration fight.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMain)

  void app.whenReady().then(() => {
    serveDist(protocol, distDir())
    // The Tauri webview's localStorage lives under XDG DATA home
    // (~/.local/share/dev.rivetos.rivethub/…) — NOT Electron's appData
    // (~/.config). Do not "fix" this to app.getPath('appData'); that is
    // where the mtls identity lives, a different tree (review finding,
    // PR #556).
    const migration = prepareMigration(
      path.join(app.getPath('userData'), 'tauri-storage-migrated'),
      legacySqlitePath(
        process.env.XDG_DATA_HOME ?? path.join(app.getPath('home'), '.local', 'share'),
      ),
    )
    registerIpc({
      pipes,
      setUnread,
      isBundledUrl,
      migration,
      isShellWindow: (id) => shellWindowIds.has(id),
      summon: showMain,
    })

    // Deny every renderer permission request (camera/mic/geolocation/…).
    // Electron's default handler GRANTS, and den iframes render LAN-served
    // content. The app needs none of them: notifications ride the main
    // process, clipboard rides IPC. BOTH gates: the check handler backs
    // navigator.permissions.query, which would otherwise report 'granted'
    // for permissions the request handler denies (review finding, PR #555).
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => {
      cb(false)
    })
    session.defaultSession.setPermissionCheckHandler(() => false)

    // Summon follows focus (see registerSummon): global while every shell
    // window is blurred or hidden, released the moment one has focus so the
    // combo reaches the renderer. No startup register — the main window is
    // created focused (registering with no window fails on some Linux WMs
    // and would stick a false conflict in the tooltip); the first blur or
    // hide arms it. New Window is a MENU accelerator now — the old global
    // Ctrl+Shift+N stole Chrome's incognito combo system-wide for as long
    // as the tray process lived.
    app.on('browser-window-focus', releaseSummon)
    app.on('browser-window-blur', onAppBlur)

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

    // Application menu. On Windows, Menu.setApplicationMenu() makes Chromium
    // round-trip EVERY keydown through the main-process accelerator matcher.
    // That is the den-xterm typing lag that landed with #560 — typing was
    // fine on the Electron shell before that commit. Null the menu on win32;
    // the tray still has Show / New Window / Quit. Linux and macOS keep the
    // accelerator-bearing menu (bar stays hidden off darwin).
    if (process.platform === 'win32') {
      Menu.setApplicationMenu(null)
    } else {
      const mapMenuItem = (item: AppMenuItem): MenuItemConstructorOptions => {
        const { action, submenu, ...rest } = item
        const out = rest as MenuItemConstructorOptions
        if (submenu) out.submenu = submenu.map(mapMenuItem)
        if (action === 'new-window') out.click = spawnWindow
        if (action === 'reload')
          out.click = (_i, win) => {
            if (win instanceof BrowserWindow) win.webContents.reload()
          }
        if (action === 'close-window') out.click = (_i, win) => win?.close()
        if (action === 'quit')
          out.click = () => {
            quitting = true
            app.quit()
          }
        return out
      }
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(appMenuTemplate(process.platform, app.isPackaged).map(mapMenuItem)),
      )
    }
    mainWindow = createWindow(true)

    // macOS: dock click / Cmd+Tab onto a hidden-to-tray app must restore
    // the window — without this, close-to-tray left the dock icon a no-op.
    // Registered inside the single-instance branch: the losing instance has
    // no window to restore.
    app.on('activate', showMain)
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
