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

const {
  normalizeSettings,
  resolveXtermTheme,
  TERMINAL_DEFAULTS,
  TERMINAL_LIMITS,
  TERMINAL_STORAGE_KEY,
  useTerminalSettings,
} = await import('./terminal-settings.js')
const { APP_THEME_FALLBACK, getTerminalScheme, paletteToXtermTheme } = await import(
  '../lib/terminal-schemes.js'
)

function resetStore(): void {
  localStorage.clear()
  useTerminalSettings.setState({
    ...TERMINAL_DEFAULTS,
    rendererActual: TERMINAL_DEFAULTS.renderer,
  })
}

describe('terminal settings store', () => {
  beforeEach(resetStore)

  it('starts at the documented defaults', () => {
    const s = useTerminalSettings.getState()
    expect(s.fontFamily).toBe("'JetBrains Mono', monospace")
    expect(s.fontSize).toBe(13)
    expect(s.lineHeight).toBe(1.0)
    expect(s.letterSpacing).toBe(0)
    expect(s.ligatures).toBe(false)
    expect(s.cursorStyle).toBe('block')
    expect(s.cursorBlink).toBe(true)
    expect(s.scrollback).toBe(5000)
    expect(s.renderer).toBe('webgl')
    expect(s.bell).toBe('none')
    expect(s.copyOnSelect).toBe(false)
    expect(s.themeSource).toBe('app')
    expect(typeof s.rightClickPaste).toBe('boolean')
  })

  it('clamps fontSize / lineHeight / scrollback on update', () => {
    const s = useTerminalSettings.getState()
    s.update({ fontSize: 3 })
    expect(useTerminalSettings.getState().fontSize).toBe(TERMINAL_LIMITS.fontSize.min)
    s.update({ fontSize: 99 })
    expect(useTerminalSettings.getState().fontSize).toBe(TERMINAL_LIMITS.fontSize.max)
    s.update({ lineHeight: 0.1 })
    expect(useTerminalSettings.getState().lineHeight).toBe(TERMINAL_LIMITS.lineHeight.min)
    s.update({ lineHeight: 5 })
    expect(useTerminalSettings.getState().lineHeight).toBe(TERMINAL_LIMITS.lineHeight.max)
    s.update({ scrollback: 1 })
    expect(useTerminalSettings.getState().scrollback).toBe(TERMINAL_LIMITS.scrollback.min)
    s.update({ scrollback: 1e9 })
    expect(useTerminalSettings.getState().scrollback).toBe(TERMINAL_LIMITS.scrollback.max)
  })

  it('rejects invalid enum values and blank font families', () => {
    const s = useTerminalSettings.getState()
    s.update({
      fontFamily: '   ',
      cursorStyle: 'beam' as never,
      renderer: 'opengl' as never,
      themeSource: 'system' as never,
    })
    const after = useTerminalSettings.getState()
    expect(after.fontFamily).toBe(TERMINAL_DEFAULTS.fontFamily)
    expect(after.cursorStyle).toBe('block')
    expect(after.renderer).toBe('webgl')
    expect(after.themeSource).toBe('app')
  })

  it('persists the settings envelope and reloads it (round-trip)', async () => {
    useTerminalSettings.getState().update({
      fontSize: 17,
      themeSource: 'scheme',
      scheme: 'nord',
      copyOnSelect: true,
    })
    const raw = localStorage.getItem(TERMINAL_STORAGE_KEY)
    expect(raw).toBeTruthy()
    const stored = JSON.parse(raw!) as { state: Record<string, unknown> }
    expect(stored.state.fontSize).toBe(17)
    expect(stored.state.scheme).toBe('nord')
    // Runtime state and actions never hit storage.
    expect(stored.state.rendererActual).toBeUndefined()
    expect(stored.state.update).toBeUndefined()

    // Any setState re-serializes through persist, so simulate a reload by
    // moving state on (storage now holds 20), restoring the captured
    // envelope, and rehydrating from it.
    useTerminalSettings.getState().update({ fontSize: 20, scheme: 'dracula' })
    localStorage.setItem(TERMINAL_STORAGE_KEY, raw!)
    await useTerminalSettings.persist.rehydrate()
    const s = useTerminalSettings.getState()
    expect(s.fontSize).toBe(17)
    expect(s.themeSource).toBe('scheme')
    expect(s.scheme).toBe('nord')
    expect(s.copyOnSelect).toBe(true)
  })

  it('re-normalizes out-of-range persisted values on rehydrate', async () => {
    localStorage.setItem(
      TERMINAL_STORAGE_KEY,
      JSON.stringify({
        state: { fontSize: 99, scrollback: 5, cursorStyle: 'beam', themeSource: 'scheme', scheme: 'dracula' },
        version: 0,
      }),
    )
    await useTerminalSettings.persist.rehydrate()
    const s = useTerminalSettings.getState()
    expect(s.fontSize).toBe(TERMINAL_LIMITS.fontSize.max)
    expect(s.scrollback).toBe(TERMINAL_LIMITS.scrollback.min)
    expect(s.cursorStyle).toBe('block')
    expect(s.scheme).toBe('dracula')
  })

  it('setRendererActual flips only on change and is not persisted', () => {
    const s = useTerminalSettings.getState()
    s.setRendererActual('canvas')
    expect(useTerminalSettings.getState().rendererActual).toBe('canvas')
    const stored = JSON.parse(localStorage.getItem(TERMINAL_STORAGE_KEY) ?? '{}') as {
      state?: Record<string, unknown>
    }
    expect(stored.state?.rendererActual).toBeUndefined()
  })

  it('resetToDefaults restores defaults but keeps an imported palette', () => {
    const imported = paletteToXtermTheme(getTerminalScheme('nord')!.palette)
    const palette = {
      foreground: imported.foreground!,
      background: imported.background!,
      ansi: [
        imported.black!,
        imported.red!,
        imported.green!,
        imported.yellow!,
        imported.blue!,
        imported.magenta!,
        imported.cyan!,
        imported.white!,
        imported.brightBlack!,
        imported.brightRed!,
        imported.brightGreen!,
        imported.brightYellow!,
        imported.brightBlue!,
        imported.brightMagenta!,
        imported.brightCyan!,
        imported.brightWhite!,
      ],
    }
    const s = useTerminalSettings.getState()
    s.update({ fontSize: 20, themeSource: 'imported', imported: palette })
    s.resetToDefaults()
    const after = useTerminalSettings.getState()
    expect(after.fontSize).toBe(TERMINAL_DEFAULTS.fontSize)
    expect(after.themeSource).toBe(TERMINAL_DEFAULTS.themeSource)
    expect(after.imported).toEqual(palette)
  })

  it('normalizeSettings keeps a valid imported palette and drops broken ones', () => {
    const dracula = getTerminalScheme('dracula')!
    expect(normalizeSettings({ imported: dracula.palette }).imported).toEqual(dracula.palette)
    expect(
      normalizeSettings({ imported: { foreground: 1 } as never }).imported,
    ).toBeUndefined()
  })
})

describe('resolveXtermTheme', () => {
  it('app source derives from the app theme (token fallback without a document)', () => {
    expect(resolveXtermTheme({ themeSource: 'app', scheme: 'nord' }, 'dark')).toEqual(
      APP_THEME_FALLBACK.dark,
    )
    expect(resolveXtermTheme({ themeSource: 'app', scheme: 'nord' }, 'light')).toEqual(
      APP_THEME_FALLBACK.light,
    )
  })

  it('scheme source maps the chosen built-in palette', () => {
    const dracula = getTerminalScheme('dracula')!
    expect(resolveXtermTheme({ themeSource: 'scheme', scheme: 'dracula' }, 'dark')).toEqual(
      paletteToXtermTheme(dracula.palette),
    )
  })

  it('unknown scheme id falls back to the app theme', () => {
    expect(resolveXtermTheme({ themeSource: 'scheme', scheme: 'nope' }, 'dark')).toEqual(
      APP_THEME_FALLBACK.dark,
    )
  })

  it('imported palette takes precedence when present', () => {
    const nord = getTerminalScheme('nord')!
    const dracula = getTerminalScheme('dracula')!
    expect(
      resolveXtermTheme(
        { themeSource: 'imported', scheme: 'nord', imported: dracula.palette },
        'light',
      ),
    ).toEqual(paletteToXtermTheme(dracula.palette))
    expect(nord.palette.background).not.toBe(dracula.palette.background)
  })

  it('imported source without a palette falls back to the app theme', () => {
    expect(resolveXtermTheme({ themeSource: 'imported', scheme: 'nord' }, 'dark')).toEqual(
      APP_THEME_FALLBACK.dark,
    )
  })
})
