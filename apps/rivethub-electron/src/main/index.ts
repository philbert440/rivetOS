/**
 * RivetHub desktop shell — Electron main. Webview over the bundled
 * rivethub-web dist, tray with show/hide + new-window + quit, a summon
 * shortcut (Ctrl+Shift+R, global only while unfocused), right-click context
 * menus, clickable native notifications, close-to-tray + bounds persistence
 * for the main window, single instance, in-app updates from the mesh
 * filestore, and the loopback mTLS pipe (#491).
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
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron'
import { CrashLog } from './crash-log.js'
import { PipeState } from './mtls-pipe.js'
import { registerIpc } from './ipc.js'
import {
  allowMediaCheck,
  allowMediaRequest,
  APP_ORIGIN,
  APP_SCHEME,
  isBundledUrl,
  serveDist,
} from './serve-dist.js'
import { appMenuTemplate, type AppMenuItem } from './app-menu.js'
import { contextMenuTemplate } from './context-menu.js'
import { RendererReloadPolicy } from './reload-policy.js'
import { totalUnread } from './unread.js'
import { cascadePoint, loadWindowState, saveWindowState, type WindowState } from './window-state.js'

// Unpackaged dev runs otherwise derive userData from the scoped package name
// (~/.config/@rivetos/rivethub-electron), so a dev-time enrollment would land
// where neither the packaged build nor the Tauri fallback ever looks (review
// finding, PR #555). Must precede any getPath('userData') use.
app.setName('RivetHub')

// Windows drops toast notifications unless the running process's AUMID
// matches the Start-Menu shortcut NSIS creates from electron-builder's appId
// — Notification.isSupported() still reports true, so the failure is silent.
if (process.platform === 'win32') app.setAppUserModelId('dev.rivetos.rivethub')
// Plasma's system tray ranks an SNI item visible only when its id matches a
// desktop entry; without this the icon lands in the hidden overflow. The
// entry name follows executableName (`rivethub`) from electron-builder.yml.
if (process.platform === 'linux') app.setDesktopName('rivethub.desktop')

// app:// registers secure:false DELIBERATELY (mixed-content must stay
// allowed so the UI can talk to plain-http LAN gateways) — but an insecure
// context has no navigator.mediaDevices, which kills voice dictation. This
// switch restores secure-context APIs for the bundle origin only; mixed
// content stays allowed because `app:` is not a cryptographic scheme, so
// Chromium's mixed-content checker never engages for it.
app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', 'app://bundle')

/** Faults that would otherwise read as "the app just closed" get a trail. */
const crashLog = new CrashLog(() => path.join(app.getPath('userData'), 'logs', 'main.log'))

/** Every fault-path append rides this: CrashLog.append is contractually
 *  never-throw, but the code between a fault and its log line must not be
 *  able to abort the handler it runs in. */
function logFault(kind: string, detail: unknown): void {
  try {
    crashLog.append(kind, detail)
  } catch {
    /* the log is best-effort even about itself */
  }
}

// Keep running on main-process faults where possible: Electron's default for
// an uncaught exception is a blocking error dialog, and an unhandled
// rejection kills the process under Node's throw default — both read as a
// crash-close with nothing to go on.
process.on('uncaughtException', (err) => {
  logFault('uncaughtException', err instanceof Error ? (err.stack ?? err.message) : err)
})
process.on('unhandledRejection', (reason) => {
  logFault(
    'unhandledRejection',
    reason instanceof Error ? (reason.stack ?? reason.message) : reason,
  )
})
app.on('child-process-gone', (_e, details) => {
  logFault(
    'child-process-gone',
    `${details.type} ${details.reason} exitCode=${String(details.exitCode ?? '')}`,
  )
})

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


/** Parsed http(s) check — a prefix regex would pass junk after the scheme. */
function isWebUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

function isMailtoUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'mailto:'
  } catch {
    return false
  }
}

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
/** Base tray tooltip — carries a shortcut-conflict warning for app lifetime
 *  so it survives unread-count rewrites. */
let baseTip = 'RivetHub'
/** Unread counts per window (webContents id) — the tray shows the SUM, not
 *  whichever window reported last. */
const unreadByWindow = new Map<number, number>()

/** Main-window bounds file — see window-state.ts. */
function windowStateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function createWindow(isMain: boolean): BrowserWindow {
  // Only the MAIN window restores saved bounds. A positionless BrowserWindow
  // is CENTERED, so extra windows would land pixel-exactly on top of each
  // other — cascade them off the focused window instead.
  let state: WindowState
  if (isMain) {
    state = loadWindowState(
      windowStateFile(),
      screen.getAllDisplays().map((d) => d.workArea),
    )
  } else {
    state = { width: 1280, height: 820 }
    const base = BrowserWindow.getFocusedWindow() ?? mainWindow
    if (base && !base.isDestroyed()) {
      const bounds = base.getBounds()
      state = { ...state, ...cascadePoint(bounds, screen.getDisplayMatching(bounds).workArea) }
    }
  }
  const win = new BrowserWindow({
    title: 'RivetHub',
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 720,
    minHeight: 480,
    // Pre-paint fill only — the renderer's own theme (rivethub.theme,
    // data-theme tokens) paints over this on load. Follow the OS so a
    // light-mode system doesn't flash a dark window frame first.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#f6f4ee',
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
  const wcId = win.webContents.id
  win.on('closed', () => {
    unreadByWindow.delete(wcId)
    applyUnread()
  })
  // window.open: never a real window, and never a side effect for untrusted
  // frames — den iframes render LAN content that must not be able to drive
  // the OS browser (#555). Only an opener whose referrer parses to the app
  // bundle origin gets http(s)/mailto forwarded to openExternal; the hub's
  // primary external-link path stays rivetShell.openExternal (sender-fenced
  // IPC), so a platform that strips custom-scheme referrers degrades to a
  // denied click, not an open door.
  win.webContents.setWindowOpenHandler(({ url, referrer }) => {
    if (isBundledUrl(referrer.url) && (isWebUrl(url) || isMailtoUrl(url))) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  // A dead renderer must not read as "the app closed": log and reload,
  // capped by RendererReloadPolicy — a finish-then-die cycle (post-load
  // script crash) must count against the cap, not re-arm it; only a load
  // that SURVIVES the healthy window resets the streak.
  // performance.now() is monotonic — a forward NTP/sleep jump on the wall
  // clock must not fake a healthy survival.
  const reloadPolicy = new RendererReloadPolicy()
  win.webContents.on('did-finish-load', () => {
    reloadPolicy.finished(performance.now())
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    logFault('render-process-gone', `${details.reason} exitCode=${String(details.exitCode ?? '')}`)
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    if (!reloadPolicy.shouldReload(performance.now())) return
    win.webContents.reload()
  })
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
              clipboard.writeText(url)
            },
          }
        }
        if (item.newWindow) return { label: item.label, click: spawnWindow }
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
    // accumulate hidden. Checked at close time: with no live tray a hidden
    // window has no discoverable road back, so X must really close.
    win.on('close', (e) => {
      if (!quitting && tray) {
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

/** Notification click-through: the window that sent it, else the main
 *  window, else any live one — a toast must always lead somewhere. */
function summonWindow(webContentsId?: number): void {
  if (quitting) return
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  const target =
    (webContentsId !== undefined
      ? wins.find((w) => w.webContents.id === webContentsId)
      : undefined) ?? (mainWindow && !mainWindow.isDestroyed() ? mainWindow : wins[0])
  if (!target) return
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
}

function spawnWindow(): void {
  createWindow(false)
}

function setUnread(webContentsId: number, count: number): void {
  // An in-flight report can land after `closed` already pruned the entry —
  // accepting it would resurrect a dead window's count forever.
  const alive = BrowserWindow.getAllWindows().some(
    (w) => !w.isDestroyed() && w.webContents.id === webContentsId,
  )
  if (!alive) return
  unreadByWindow.set(webContentsId, count)
  applyUnread()
}

function applyUnread(): void {
  const total = totalUnread(unreadByWindow.values())
  tray?.setToolTip(total === 0 ? baseTip : `${baseTip} — ${String(total)} unread`)
  // Dock/taskbar badge where the platform has one (macOS dock, Unity
  // launcher); returns false elsewhere — the tooltip stays the fallback.
  try {
    app.setBadgeCount(Math.min(total, 999))
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
  applyUnread()
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

// Single instance: a relaunch must not spawn a second tray + a
// shortcut-registration fight. What the relaunch MEANS depends on state:
// Plasma/GNOME's taskbar "Open New Window" re-runs Exec with no
// distinguishing argv, so it lands here exactly like a plain launcher
// click. With a window already on screen the user asked for another
// window; with everything hidden-to-tray they asked for the app back.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (quitting) return
    const anyVisible = BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isVisible(),
    )
    if (anyVisible) spawnWindow()
    else showMain()
  })

  void app.whenReady().then(() => {
    try {
      startup()
    } catch (err) {
      // One bad step must not abort startup with no window and no trail —
      // and the recovery steps must not be able to abort EACH OTHER.
      logFault('startup', err instanceof Error ? (err.stack ?? err.message) : err)
      try {
        if (!mainWindow) mainWindow = createWindow(true)
      } catch (err2) {
        logFault('startup-recovery', err2 instanceof Error ? (err2.stack ?? err2.message) : err2)
      }
      // No window AND no tray = an unreachable background process; quit
      // beats a phantom.
      if (!mainWindow && !tray) app.quit()
    }
  })
}

function startup(): void {
  // FIRST, before anything that can throw: with the menu left at Electron's
  // default, every keydown round-trips the main-process accelerator matcher
  // — the den-xterm typing lag fixed in #566. A startup fault later in this
  // function must not resurrect it.
  if (process.platform === 'win32') Menu.setApplicationMenu(null)

  serveDist(protocol, distDir())
  registerIpc({
    pipes,
    setUnread,
    isBundledUrl,
    summon: summonWindow,
    newWindow: spawnWindow,
    quit: () => {
      quitting = true
      app.quit()
    },
  })

  // Deny every renderer permission request EXCEPT microphone capture for the
  // bundled UI's main frame (voice dictation). Electron's default handler
  // GRANTS, and den iframes render LAN-served content — they must never
  // reach the mic or anything else. BOTH gates ride the same pure fences in
  // serve-dist.ts (unit-tested against the URL-vs-origin shape split): the
  // check handler backs navigator.permissions.query, which would otherwise
  // disagree with getUserMedia (review finding, PR #555).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(
      permission === 'media' &&
        allowMediaRequest(
          details as { requestingUrl?: string; isMainFrame?: boolean; mediaTypes?: string[] },
        ),
    )
  })
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission, requestingOrigin, details) =>
      permission === 'media' &&
      allowMediaCheck(
        requestingOrigin,
        details as { embeddingOrigin?: string; mediaType?: string; isMainFrame?: boolean },
      ),
  )

  // Summon follows focus (see registerSummon): global while every shell
  // window is blurred or hidden, released the moment one has focus so the
  // combo reaches the renderer. No startup register — the main window is
  // created focused (registering with no window fails on some Linux WMs
  // and would stick a false conflict in the tooltip); the first blur or
  // hide arms it.
  app.on('browser-window-focus', releaseSummon)
  app.on('browser-window-blur', onAppBlur)

  // Trayless is survivable (close-to-tray and window-all-closed both check
  // `tray`); a broken tray icon must not take startup down with it. An
  // unreadable path yields an EMPTY image, not a throw — and new Tray(empty)
  // can succeed on Linux, leaving a truthy `tray` behind an invisible icon
  // that close-to-tray would hide the last window behind.
  //
  // ⚠️ Electron is PINNED to exactly 43.4.0 for this tray. 43.3.0 and
  // 43.4.1/44.0.0 both ship SNI regressions (electron#52674, #53024): the
  // StatusNotifierItem D-Bus object exports no interfaces and never
  // registers with the StatusNotifierWatcher — new Tray() "succeeds" and
  // the icon silently never appears on KDE/GNOME. Verified per-version
  // against a live Plasma 6 Wayland session (Properties.GetAll + watcher
  // registration) before any bump: 43.4.0 works, 44.0.0 does not.
  try {
    const iconPath = path.join(__dirname, '../icons/icon.png')
    const icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) throw new Error(`tray icon unreadable: ${iconPath}`)
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
  } catch (err) {
    // A half-constructed tray (icon set, menu throw) must not survive as a
    // truthy ghost — destroy it, and unset even if destroy itself throws.
    try {
      tray?.destroy()
    } catch {
      /* already unusable */
    } finally {
      tray = undefined
    }
    logFault('tray', err instanceof Error ? (err.stack ?? err.message) : err)
  }

  // Application menu — accelerators for Linux/macOS (bar hidden off darwin).
  // win32 nulled the menu at the top of startup(): menu accelerators put
  // per-keystroke work on the main-process input path (#566); the tray keeps
  // Show / New Window / Quit and the renderer forwards window chords over
  // rivetShell (rivethub-web lib/shell-keys.ts).
  if (process.platform !== 'win32') {
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
}

// Tray app: closing every window must not exit (main hides to tray; extra
// windows close for real). Quit is the tray's job — except trayless, where
// a windowless background process would be unreachable.
app.on('window-all-closed', () => {
  if (!tray) app.quit()
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  pipes.dispose()
})
