import { describe, expect, it } from 'vitest'
import { appMenuTemplate, type AppMenuItem } from './app-menu.js'

function flatten(items: AppMenuItem[]): AppMenuItem[] {
  return items.flatMap((i) => [i, ...(i.submenu ? flatten(i.submenu) : [])])
}

describe('appMenuTemplate', () => {
  it('linux template carries the accelerators the nulled menu used to drop', () => {
    // win32 uses the same template data, but index.ts must NOT install it:
    // Electron's application-menu accelerator matcher lags every keystroke
    // on Windows (the #560 typing-lag regression).
    const all = flatten(appMenuTemplate('linux', true))
    expect(flatten(appMenuTemplate('win32', true)).some((i) => i.action === 'quit')).toBe(true)
    // zoom + fullscreen come back as roles
    for (const role of ['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']) {
      expect(all.some((i) => i.role === role)).toBe(true)
    }
    // NO editMenu off darwin: its role accelerators would eat Ctrl+C/Z/A/V
    // before a den xterm sees them (Ctrl+C is SIGINT, not copy)
    expect(all.some((i) => i.role === 'editMenu')).toBe(false)
    // in-window quit exists (tray is no longer the only exit)
    expect(all.some((i) => i.action === 'quit' && i.accelerator === 'CmdOrCtrl+Q')).toBe(true)
    // new window is an app-scoped accelerator, not a global grab
    expect(
      all.some((i) => i.action === 'new-window' && i.accelerator === 'CmdOrCtrl+Shift+N'),
    ).toBe(true)
    // no appMenu role outside darwin
    expect(all.some((i) => i.role === 'appMenu')).toBe(false)
  })

  it('never ships combos the focused frame is owed', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const all = flatten(appMenuTemplate(platform, true))
      // forceReload's default is Ctrl/Cmd+Shift+R — the summon combo and a
      // terminal chord; reload's default Ctrl+R is bash reverse-i-search.
      // Both exist only accelerator-free (reload) or not at all (force).
      expect(all.some((i) => i.role === 'forceReload')).toBe(false)
      expect(all.some((i) => i.role === 'reload')).toBe(false)
      const reload = all.find((i) => i.action === 'reload')
      expect(reload).toBeDefined()
      expect(reload?.accelerator).toBeUndefined()
    }
    // Ctrl+W is delete-word in a terminal: Close is accelerator-free off mac
    const linux = flatten(appMenuTemplate('linux', true))
    expect(linux.some((i) => i.role === 'close')).toBe(false)
    const close = linux.find((i) => i.action === 'close-window')
    expect(close).toBeDefined()
    expect(close?.accelerator).toBeUndefined()
  })

  it('devtools ships only unpackaged', () => {
    expect(flatten(appMenuTemplate('linux', true)).some((i) => i.role === 'toggleDevTools')).toBe(
      false,
    )
    expect(flatten(appMenuTemplate('linux', false)).some((i) => i.role === 'toggleDevTools')).toBe(
      true,
    )
  })

  it('darwin keeps the standard app menu and drops the custom Quit', () => {
    const all = flatten(appMenuTemplate('darwin', true))
    expect(all[0]?.role).toBe('appMenu')
    // Cmd is not a terminal modifier — the Edit menu is safe (and expected) there
    expect(all.some((i) => i.role === 'editMenu')).toBe(true)
    // Quit lives in the app menu role on macOS; a second one would be noise
    expect(all.some((i) => i.action === 'quit')).toBe(false)
    // Cmd+W is standard there and Cmd is not a terminal modifier
    expect(all.some((i) => i.role === 'close')).toBe(true)
  })
})
