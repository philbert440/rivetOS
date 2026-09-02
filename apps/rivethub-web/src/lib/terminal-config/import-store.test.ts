/**
 * Round-trip: a real emulator config → the parser → `importPatch` → the
 * settings store → the theme xterm is handed. This is the seam the Apply
 * button sits on; the component itself is a thin wrapper over exactly these
 * calls (the web app's vitest run has no DOM, so the logic lives in
 * lib/terminal-config where it can be asserted).
 */

import { readFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  }
}

vi.stubGlobal('localStorage', memoryStorage())
afterAll(() => vi.unstubAllGlobals())

const { TERMINAL_DEFAULTS, resolveXtermTheme, useTerminalSettings } =
  await import('../../stores/terminal-settings.js')
const { importPatch, parseAlacritty, parseGhostty, parseKitty, parseWindowsTerminal } =
  await import('./index.js')
const { isTerminalPalette } = await import('../terminal-schemes.js')

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')

beforeEach(() => {
  localStorage.clear()
  useTerminalSettings.setState({
    ...TERMINAL_DEFAULTS,
    rendererActual: TERMINAL_DEFAULTS.renderer,
  })
})

async function applyAndRehydrate(patch: ReturnType<typeof importPatch>): Promise<void> {
  useTerminalSettings.getState().update(patch)
  // createJSONStorage writes synchronously; yield once so any queued persist
  // flush lands before we read the blob back.
  await Promise.resolve()
  expect(useTerminalSettings.persist.hasHydrated()).toBe(true)
  await useTerminalSettings.persist.rehydrate()
}

describe('import → store round trip', () => {
  it('applies a Ghostty config to the live settings and the resolved theme', () => {
    const imp = parseGhostty(fixture('ghostty-config'), {
      includes: { 'local.conf': fixture('ghostty-local.conf') },
    })
    useTerminalSettings.getState().update(importPatch(imp))

    const s = useTerminalSettings.getState()
    expect(s.fontFamily).toBe("'JetBrains Mono', 'Symbols Nerd Font Mono', monospace")
    expect(s.fontSize).toBe(14)
    expect(s.lineHeight).toBeCloseTo(1.08)
    expect(s.themeSource).toBe('imported')
    expect(isTerminalPalette(s.imported)).toBe(true)

    const theme = resolveXtermTheme(s, 'dark')
    expect(theme.background).toBe('#1e1e2e')
    expect(theme.red).toBe('#ff5555')
    expect(theme.brightWhite).toBe('#a6adc8')
  })

  it('survives a persist round trip', async () => {
    const imp = parseWindowsTerminal(fixture('windows-terminal-settings.json'))
    await applyAndRehydrate(importPatch(imp))

    const s = useTerminalSettings.getState()
    expect(s.themeSource).toBe('imported')
    expect(s.imported).toEqual(imp.palette)
    expect(resolveXtermTheme(s, 'dark').magenta).toBe('#c678dd')
  })

  it('round-trips a JSONC Windows Terminal stock fixture', async () => {
    const imp = parseWindowsTerminal(fixture('windows-terminal-stock.json'))
    await applyAndRehydrate(importPatch(imp))
    const s = useTerminalSettings.getState()
    expect(s.fontFamily).toBe("'Cascadia Code', monospace")
    expect(s.fontSize).toBe(14)
    expect(s.themeSource).toBe('imported')
    expect(s.imported).toEqual(imp.palette)
    expect(resolveXtermTheme(s, 'dark').background).toBe('#282c34')
  })

  it('round-trips a kitty config through the store', async () => {
    const imp = parseKitty(fixture('kitty.conf'), {
      includes: { './current-theme.conf': fixture('kitty-theme.conf') },
    })
    await applyAndRehydrate(importPatch(imp))
    const s = useTerminalSettings.getState()
    expect(s.fontFamily).toBe("'FiraCode Nerd Font', monospace")
    expect(s.fontSize).toBe(12)
    expect(s.themeSource).toBe('imported')
    expect(resolveXtermTheme(s, 'dark').background).toBe('#282828')
  })

  it('round-trips an Alacritty config through the store', async () => {
    const imp = parseAlacritty(fixture('alacritty.toml'), {
      path: '/home/u/.config/alacritty/alacritty.toml',
      includes: { 'themes/tokyonight.toml': fixture('alacritty-theme.toml') },
    })
    await applyAndRehydrate(importPatch(imp))
    const s = useTerminalSettings.getState()
    expect(s.fontFamily).toBe("'JetBrains Mono', monospace")
    expect(s.fontSize).toBe(12) // 11.5 rounded by importPatch
    expect(s.themeSource).toBe('imported')
    expect(resolveXtermTheme(s, 'dark').background).toBe('#16161e')
  })

  it('clearing the import keeps the font and falls back to the app theme', () => {
    const imp = parseGhostty(fixture('ghostty-config'), {
      includes: { 'local.conf': fixture('ghostty-local.conf') },
    })
    const patch = importPatch(imp)
    useTerminalSettings.getState().update(patch)
    expect(useTerminalSettings.getState().themeSource).toBe('imported')

    // What the "Clear imported palette" button does.
    useTerminalSettings.getState().update({ imported: undefined, themeSource: 'app' })
    const s = useTerminalSettings.getState()
    expect(s.imported).toBeUndefined()
    expect(s.themeSource).toBe('app')
    expect(s.fontFamily).toBe(patch.fontFamily)
    expect(s.fontSize).toBe(patch.fontSize)
    expect(s.lineHeight).toBeCloseTo(patch.lineHeight!)
    expect(resolveXtermTheme(s, 'dark')).toEqual(
      resolveXtermTheme({ themeSource: 'app', scheme: s.scheme, imported: undefined }, 'dark'),
    )
  })

  it('a font-only import leaves the palette source alone', () => {
    useTerminalSettings.getState().update({ themeSource: 'scheme', scheme: 'nord' })
    useTerminalSettings.getState().update(importPatch({ fontFamily: "'Iosevka'", warnings: [] }))
    const s = useTerminalSettings.getState()
    expect(s.fontFamily).toBe("'Iosevka'")
    expect(s.themeSource).toBe('scheme')
  })
})
