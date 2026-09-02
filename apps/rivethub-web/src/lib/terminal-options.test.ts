import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { ImageAddon } from '@xterm/addon-image'
import { buildTerminalOptions } from './terminal-options.js'

/** Store-free stand-in for TERMINAL_DEFAULTS — this module must not import
 *  terminal-settings (persist hydrate reads localStorage / window). */
const TERMINAL_DEFAULTS = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  lineHeight: 1.0,
  letterSpacing: 0,
  ligatures: false,
  cursorStyle: 'block' as const,
  cursorBlink: true,
  scrollback: 5000,
  renderer: 'webgl' as const,
  bell: 'none' as const,
  copyOnSelect: true,
  rightClickPaste: true,
  themeSource: 'app' as const,
  scheme: 'catppuccin-mocha',
}

describe('buildTerminalOptions', () => {
  it('sets allowProposedApi so unicode11 and image addons can load', () => {
    const opts = buildTerminalOptions(TERMINAL_DEFAULTS)
    expect(opts.allowProposedApi).toBe(true)
  })

  // The assertion that would have caught the 0.5.7–0.5.9 breakage: construct
  // a REAL xterm Terminal with the builder's options (headless in node works
  // for construction + addon activation) and load the two proposed-API
  // addons. Flip allowProposedApi to false and this goes red.
  it('a real Terminal built from these options loads the proposed-API addons', () => {
    const term = new Terminal(buildTerminalOptions(TERMINAL_DEFAULTS))
    expect(() => term.loadAddon(new Unicode11Addon())).not.toThrow()
    expect(() => term.loadAddon(new ImageAddon())).not.toThrow()
    term.dispose()
  })

  it('without allowProposedApi the same addons throw (proves the guard is live)', () => {
    const term = new Terminal({
      ...buildTerminalOptions(TERMINAL_DEFAULTS),
      allowProposedApi: false,
    })
    expect(() => term.loadAddon(new Unicode11Addon())).toThrow(/allowProposedApi/)
    term.dispose()
  })

  it('maps font, cursor, and scrollback from settings', () => {
    const a = buildTerminalOptions({
      ...TERMINAL_DEFAULTS,
      fontFamily: 'Hack',
      fontSize: 16,
      cursorStyle: 'bar',
      scrollback: 2000,
    })
    expect(a.fontFamily).toBe('Hack')
    expect(a.fontSize).toBe(16)
    expect(a.cursorStyle).toBe('bar')
    expect(a.scrollback).toBe(2000)

    const b = buildTerminalOptions({
      ...TERMINAL_DEFAULTS,
      fontFamily: 'Fira Code',
      fontSize: 11,
      cursorStyle: 'underline',
      scrollback: 8000,
    })
    expect(b.fontFamily).toBe('Fira Code')
    expect(b.fontSize).toBe(11)
    expect(b.cursorStyle).toBe('underline')
    expect(b.scrollback).toBe(8000)
  })
})
