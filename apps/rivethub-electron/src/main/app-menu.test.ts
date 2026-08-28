import { describe, expect, it } from 'vitest'
import { appMenuTemplate, type AppMenuItem } from './app-menu.js'

function flatten(items: AppMenuItem[]): AppMenuItem[] {
  return items.flatMap((i) => [i, ...(i.submenu ? flatten(i.submenu) : [])])
}

describe('appMenuTemplate', () => {
  it('linux/windows carry the accelerators the nulled menu used to drop', () => {
    const all = flatten(appMenuTemplate('linux'))
    // zoom + reload + devtools come back as roles
    for (const role of ['resetZoom', 'zoomIn', 'zoomOut', 'reload', 'toggleDevTools', 'editMenu']) {
      expect(all.some((i) => i.role === role)).toBe(true)
    }
    // in-window quit exists (tray is no longer the only exit)
    expect(all.some((i) => i.action === 'quit' && i.accelerator === 'CmdOrCtrl+Q')).toBe(true)
    // new window is an app-scoped accelerator, not a global grab
    expect(
      all.some((i) => i.action === 'new-window' && i.accelerator === 'CmdOrCtrl+Shift+N'),
    ).toBe(true)
    // no appMenu role outside darwin
    expect(all.some((i) => i.role === 'appMenu')).toBe(false)
  })

  it('darwin keeps the standard app menu and drops the custom Quit', () => {
    const all = flatten(appMenuTemplate('darwin'))
    expect(all[0]?.role).toBe('appMenu')
    // Quit lives in the app menu role on macOS; a second one would be noise
    expect(all.some((i) => i.action === 'quit')).toBe(false)
    expect(all.some((i) => i.role === 'close')).toBe(true)
  })
})
