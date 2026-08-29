/**
 * Application menu — exists for its ACCELERATORS on Linux/macOS (the bar is
 * hidden off darwin). NOT installed on Windows: menu accelerators make
 * Chromium round-trip every keydown through main, the den-xterm typing lag
 * (#566); the renderer forwards win32 chords over rivetShell instead.
 *
 * Constraints, all load-bearing: no auto-hide bar (it answers the lone Alt
 * key, a terminal modifier); no editMenu off darwin (Ctrl+C in a den xterm
 * is SIGINT, not copy); Reload carries NO accelerator and forceReload does
 * not exist (Ctrl+R / Ctrl+Shift+R must reach xterms, and the latter is the
 * summon shortcut); Close is accelerator-free off macOS (Ctrl+W is
 * delete-word in a terminal); DevTools ships only unpackaged (a devtools
 * console on the privileged hub is a self-XSS surface onto rivetShell).
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
