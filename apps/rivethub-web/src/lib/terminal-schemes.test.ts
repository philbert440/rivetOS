import { describe, expect, it } from 'vitest'
import {
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

  it('scheme ids are unique and lookup round-trips', () => {
    expect(new Set(TERMINAL_SCHEMES.map((s) => s.id)).size).toBe(TERMINAL_SCHEMES.length)
    for (const s of TERMINAL_SCHEMES) expect(getTerminalScheme(s.id)).toBe(s)
    expect(getTerminalScheme('no-such-scheme')).toBeUndefined()
  })

  it('xterm default ANSI fallback is 16 valid hex entries', () => {
    expect(XTERM_DEFAULT_ANSI).toHaveLength(16)
    for (const c of XTERM_DEFAULT_ANSI) expect(c).toMatch(HEX)
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
})
