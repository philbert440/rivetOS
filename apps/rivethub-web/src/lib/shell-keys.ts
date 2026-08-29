/**
 * Window-management chords for the Electron shell. The shell installs no
 * application menu on Windows (menu accelerators put per-keystroke work on
 * the main-process input path — terminal typing lag), so the chords are
 * handled here and forwarded over rivetShell. Capture phase so a focused
 * xterm cannot swallow them; none of these are terminal keys (plain
 * Ctrl+Q/R/F are deliberately not bound).
 */

import { rivetShell } from './shell-bridge.js'

export function installShellKeys(): void {
  const shell = rivetShell()
  if (!shell) return
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const key = e.key.toLowerCase()
      if (e.shiftKey && key === 'n') {
        e.preventDefault()
        void shell.newWindow?.()
      } else if (e.shiftKey && key === 'q') {
        e.preventDefault()
        void shell.quitApp?.()
      } else if (!e.shiftKey && (key === '=' || key === '+')) {
        e.preventDefault()
        void shell.zoomAdjust?.(1)
      } else if (!e.shiftKey && key === '-') {
        e.preventDefault()
        void shell.zoomAdjust?.(-1)
      } else if (!e.shiftKey && key === '0') {
        e.preventDefault()
        void shell.zoomAdjust?.(0)
      }
    },
    { capture: true },
  )
}
