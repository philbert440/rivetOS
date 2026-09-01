import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appXtermTheme,
  APP_THEME_FALLBACK,
  getTerminalScheme,
  isTerminalPalette,
  paletteToXtermTheme,
  TERMINAL_SCHEMES,
  XTERM_DEFAULT_ANSI,
} from './terminal-schemes.js'

const HEX = /^#[0-9a-f]{6}$/i

describe('terminal schemes', () => {
  it('covers the expected built-ins', () => {
    expect(TERMINAL_SCHEMES.map((s) => s.id)).toEqual([
      'catppuccin-mocha',
      'catppuccin-latte',
      'gruvbox-dark',
      'gruvbox-light',
      'solarized-dark',
      'solarized-light',
      'dracula',
      'one-dark',
      'nord',
    ])
  })

  it('every scheme has valid hex fg/bg and 16 valid hex ANSI entries', () => {
    for (const s of TERMINAL_SCHEMES) {
      expect(s.palette.foreground, `${s.id} foreground`).toMatch(HEX)
      expect(s.palette.background, `${s.id} background`).toMatch(HEX)
      expect(s.palette.ansi, `${s.id} ansi`).toHaveLength(16)
      for (const c of s.palette.ansi) expect(c, `${s.id} ansi entry`).toMatch(HEX)
      if (s.palette.cursor !== undefined) expect(s.palette.cursor, `${s.id} cursor`).toMatch(HEX)
      if (s.palette.selectionBackground !== undefined)
        expect(s.palette.selectionBackground, `${s.id} selection`).toMatch(HEX)
    }
  })

  it('pins the dracula palette by value', () => {
    const dracula = getTerminalScheme('dracula')!
    expect(dracula.palette).toEqual({
      foreground: '#f8f8f2',
      background: '#282a36',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      ansi: [
        '#21222c',
        '#ff5555',
        '#50fa7b',
        '#f1fa8c',
        '#bd93f9',
        '#ff79c6',
        '#8be9fd',
        '#f8f8f2',
        '#6272a4',
        '#ff6e6e',
        '#69ff94',
        '#ffffa5',
        '#d6acff',
        '#ff92df',
        '#a4ffff',
        '#ffffff',
      ],
    })
  })

  it('scheme ids are unique and lookup round-trips', () => {
    expect(new Set(TERMINAL_SCHEMES.map((s) => s.id)).size).toBe(TERMINAL_SCHEMES.length)
    for (const s of TERMINAL_SCHEMES) expect(getTerminalScheme(s.id)).toBe(s)
    expect(getTerminalScheme('no-such-scheme')).toBeUndefined()
  })

  it('xterm default ANSI matches the xterm 6 Tango-derived ramp, pinned by value', () => {
    expect(XTERM_DEFAULT_ANSI).toEqual([
      '#2e3436',
      '#cc0000',
      '#4e9a06',
      '#c4a000',
      '#3465a4',
      '#75507b',
      '#06989a',
      '#d3d7cf',
      '#555753',
      '#ef2929',
      '#8ae234',
      '#fce94f',
      '#729fcf',
      '#ad7fa8',
      '#34e2e2',
      '#eeeeec',
    ])
  })

  it('paletteToXtermTheme maps ansi in xterm order', () => {
    const dracula = getTerminalScheme('dracula')!
    const theme = paletteToXtermTheme(dracula.palette)
    expect(theme.foreground).toBe(dracula.palette.foreground)
    expect(theme.background).toBe(dracula.palette.background)
    expect(theme.black).toBe(dracula.palette.ansi[0])
    expect(theme.white).toBe(dracula.palette.ansi[7])
    expect(theme.brightBlack).toBe(dracula.palette.ansi[8])
    expect(theme.brightWhite).toBe(dracula.palette.ansi[15])
  })

  it('isTerminalPalette validates shape', () => {
    const dracula = getTerminalScheme('dracula')!
    expect(isTerminalPalette(dracula.palette)).toBe(true)
    expect(isTerminalPalette(undefined)).toBe(false)
    expect(isTerminalPalette({ foreground: '#fff', background: '#000' })).toBe(false)
    expect(
      isTerminalPalette({ foreground: '#ffffff', background: '#000000', ansi: ['#000000'] }),
    ).toBe(false)
  })

  it('isTerminalPalette rejects non-color strings and non-hex values everywhere', () => {
    const dracula = getTerminalScheme('dracula')!
    const base = { ...dracula.palette, ansi: [...dracula.palette.ansi] }
    // Empty / garbage colors, missing #, short hex, wrong type.
    expect(isTerminalPalette({ ...base, foreground: '' })).toBe(false)
    expect(isTerminalPalette({ ...base, foreground: 'nope' })).toBe(false)
    expect(isTerminalPalette({ ...base, background: '282a36' })).toBe(false)
    expect(isTerminalPalette({ ...base, foreground: '#fff' })).toBe(false)
    expect(isTerminalPalette({ ...base, cursor: 123 })).toBe(false)
    expect(isTerminalPalette({ ...base, cursor: 'red' })).toBe(false)
    expect(isTerminalPalette({ ...base, selectionBackground: '#44475' })).toBe(false)
    // Every one of the 16 ANSI slots is checked.
    const badAnsi = [...dracula.palette.ansi]
    badAnsi[7] = ''
    expect(isTerminalPalette({ ...base, ansi: badAnsi })).toBe(false)
    badAnsi[7] = 42 as never
    expect(isTerminalPalette({ ...base, ansi: badAnsi })).toBe(false)
    // Optional fields may be absent, and uppercase hex is a color too.
    const { cursor: _c, selectionBackground: _s, ...minimal } = dracula.palette
    expect(isTerminalPalette(minimal)).toBe(true)
    expect(isTerminalPalette({ ...base, foreground: '#F8F8F2' })).toBe(true)
  })
})

describe('appXtermTheme', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('falls back to the baked-in tokens without a document (SSR / tests)', () => {
    expect(appXtermTheme('dark')).toEqual(APP_THEME_FALLBACK.dark)
    expect(appXtermTheme('light')).toEqual(APP_THEME_FALLBACK.light)
  })

  it('falls back when the CSS tokens are unset or empty', () => {
    vi.stubGlobal('document', { documentElement: {} })
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '  ' }))
    expect(appXtermTheme('dark')).toEqual(APP_THEME_FALLBACK.dark)
  })

  it('reads the live theme.css tokens when they are set', () => {
    vi.stubGlobal('document', { documentElement: {} })
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) =>
        ({ '--color-bg': '#111111', '--color-ink': '#222222', '--color-em': '#333333' })[name] ??
        '',
    }))
    expect(appXtermTheme('dark')).toEqual({
      background: '#111111',
      foreground: '#222222',
      cursor: '#333333',
    })
  })
})
