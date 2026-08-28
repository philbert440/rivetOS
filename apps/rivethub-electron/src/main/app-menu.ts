/**
 * Application menu. `Menu.setApplicationMenu(null)` on Linux/Windows didn't
 * just drop the bar — it dropped every accelerator Chromium hangs off menu
 * roles: zoom (Ctrl+= / Ctrl+- / Ctrl+0), reload, devtools, and any
 * in-window Quit, leaving the tray as the only exit (four-agent desktop
 * review, consolidated punch list #2/#7).
 *
 * The menu exists for its ACCELERATORS: on Linux/Windows the bar itself
 * stays hidden (autoHideMenuBar — Alt reveals it), on macOS it is the normal
 * top bar. New Window rides a menu accelerator now instead of a GLOBAL
 * Ctrl+Shift+N, which used to steal the combo system-wide (Chrome's
 * incognito) even while RivetHub was in the background.
 *
 * Template is data (roles + handler tags), built pure for testability; the
 * caller maps tags to real handlers.
 */

export type AppMenuAction = 'new-window' | 'quit'

export interface AppMenuItem {
  role?: string
  label?: string
  accelerator?: string
  action?: AppMenuAction
  type?: 'separator'
  submenu?: AppMenuItem[]
}

export function appMenuTemplate(platform: NodeJS.Platform): AppMenuItem[] {
  const template: AppMenuItem[] = []
  if (platform === 'darwin') {
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
        // for real — exactly the X-button semantics.
        { role: 'close' },
        ...(platform === 'darwin'
          ? []
          : ([
              { type: 'separator' },
              { label: 'Quit RivetHub', accelerator: 'CmdOrCtrl+Q', action: 'quit' },
            ] satisfies AppMenuItem[])),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
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
