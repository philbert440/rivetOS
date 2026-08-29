/**
 * Application menu. `Menu.setApplicationMenu(null)` on Linux/Windows didn't
 * just drop the bar — it dropped every accelerator Chromium hangs off menu
 * roles: zoom (Ctrl+= / Ctrl+- / Ctrl+0), fullscreen, and any in-window
 * Quit, leaving the tray as the only exit (four-agent desktop review,
 * consolidated punch list #2/#7).
 *
 * The menu exists for its ACCELERATORS on Linux and macOS. On Windows it
 * is NOT installed: Chromium round-trips every keydown through the
 * accelerator matcher, which is the den-xterm typing lag from #560. The
 * tray keeps Show / New Window / Quit there. Off Windows the bar itself is
 * never shown on Linux (setMenuBarVisibility(false) with auto-hide OFF —
 * an auto-hide bar answers the single Alt key, and Alt must stay a
 * terminal modifier), and on macOS it is the normal top bar. New Window
 * rides a menu accelerator now instead of a GLOBAL Ctrl+Shift+N, which
 * used to steal the combo system-wide (Chrome's incognito) even while
 * RivetHub was in the background.
 *
 * Deliberately accelerator-free or absent (grok review of this PR): Reload
 * has NO accelerator and forceReload does not exist — menu accelerators are
 * consumed in the main process before the focused frame sees the key, so
 * default Ctrl+R / Ctrl+Shift+R roles would starve den xterms of those
 * combos and collide with the summon shortcut — the exact bugs this PR
 * fixes. Close is likewise accelerator-free off macOS (Ctrl+W is
 * delete-word in a terminal; Cmd+W on macOS is a different key and stays).
 * DevTools ships only unpackaged: a devtools console on the privileged hub
 * is a self-XSS surface onto window.rivetShell. Fullscreen state is not
 * persisted by window-state — a choice, not an accident.
 *
 * Template is data (roles + handler tags), built pure for testability; the
 * caller maps tags to real handlers.
 */

export type AppMenuAction = 'new-window' | 'quit' | 'reload' | 'close-window'

export interface AppMenuItem {
  role?: string
  label?: string
  accelerator?: string
  action?: AppMenuAction
  type?: 'separator'
  submenu?: AppMenuItem[]
}

export function appMenuTemplate(platform: NodeJS.Platform, packaged: boolean): AppMenuItem[] {
  const darwin = platform === 'darwin'
  const template: AppMenuItem[] = []
  if (darwin) {
    // Standard macOS app menu — keeps Hide/Quit where Mac users expect them.
    template.push({ role: 'appMenu' })
  }
  template.push(
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', action: 'new-window' },
        { type: 'separator' },
        // Close routes through the window's close event, so the main window
        // hides to tray (its close-to-tray policy) and extra windows close
        // for real — exactly the X-button semantics. Role (with Cmd+W) on
        // macOS only; accelerator-free elsewhere, see header.
        ...(darwin
          ? ([{ role: 'close' }] satisfies AppMenuItem[])
          : ([{ label: 'Close Window', action: 'close-window' }] satisfies AppMenuItem[])),
        ...(darwin
          ? []
          : ([
              { type: 'separator' },
              { label: 'Quit RivetHub', accelerator: 'CmdOrCtrl+Q', action: 'quit' },
            ] satisfies AppMenuItem[])),
      ],
    },
    // Edit menu is DARWIN-ONLY: on Linux/Windows editMenu's default role
    // accelerators (Ctrl+C/Z/A/V/Y) are consumed in main before the focused
    // frame sees them — Ctrl+C in a den xterm is SIGINT, not copy. Chromium
    // handles editing keys natively inside inputs without menu roles, and
    // the context menu covers the pointer path; on macOS Cmd is not a
    // terminal modifier, so the standard menu stays (grok round 2).
    ...(darwin ? ([{ role: 'editMenu' }] satisfies AppMenuItem[]) : []),
    {
      label: 'View',
      submenu: [
        { label: 'Reload', action: 'reload' },
        ...(packaged ? [] : ([{ role: 'toggleDevTools' }] satisfies AppMenuItem[])),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  )
  return template
}
