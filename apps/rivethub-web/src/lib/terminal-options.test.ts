import { afterEach, describe, expect, it, vi } from 'vitest'
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


afterEach(() => vi.unstubAllGlobals())

it('routes OSC hyperlinks through the desktop opener without a warning or blank window', () => {
  const open = vi.fn()
  const confirm = vi.fn()
  const openExternal = vi.fn(async () => undefined)
  vi.stubGlobal('window', { open, confirm })
  vi.stubGlobal('confirm', confirm)
  vi.stubGlobal('rivetShell', {
    kind: 'electron',
    mtlsProxyPort: async () => 12345,
    openExternal,
    clipboardWriteText: async () => undefined,
    clipboardReadText: async () => '',
    sendNotification: async () => undefined,
    setUnread: async () => undefined,
  })
  const term = new Terminal(buildTerminalOptions(TERMINAL_DEFAULTS))
  const handler = term.options.linkHandler!
  const event = {} as MouseEvent
  const range = { start: { x: 1, y: 1 }, end: { x: 8, y: 1 } }
  handler.activate(event, 'https://github.com/philbert440/rivetOS/pull/738', range)
  expect(openExternal).toHaveBeenCalledWith('https://github.com/philbert440/rivetOS/pull/738')
  expect(confirm).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(handler.allowNonHttpProtocols).toBe(false)
  for (const uri of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:test@example.com']) {
    handler.activate(event, uri, range)
  }
  expect(openExternal).toHaveBeenCalledTimes(1)
  term.dispose()
})
