import type { TerminalSettings } from '../stores/terminal-settings.js'

/**
 * Constructor options for `new Terminal(...)`. `allowProposedApi` is required
 * for addons that use xterm's proposed API (unicode11 grapheme widths, image
 * sixel/IIP). Without it, construction/loadAddon throws and the pane never
 * opens a WebSocket.
 */
export function buildTerminalOptions(settings: TerminalSettings): {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  cursorStyle: TerminalSettings['cursorStyle']
  cursorBlink: boolean
  scrollback: number
  allowProposedApi: true
} {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    letterSpacing: settings.letterSpacing,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    allowProposedApi: true,
  }
}
