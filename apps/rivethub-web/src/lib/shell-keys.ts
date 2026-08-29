/**
 * Window-management chords for the Electron shell on WINDOWS ONLY: the shell
 * installs no application menu there (menu accelerators put per-keystroke
 * work on the main-process input path — terminal typing lag), so the chords
 * are handled here and forwarded over rivetShell. Linux/macOS keep the
 * accelerator-bearing menu, which consumes these combos in main — installing
 * here too would double-fire. Capture phase so a focused xterm cannot
 * swallow them; none of these are terminal keys (plain Ctrl+Q/R/F are
 * deliberately not bound). A chord is claimed ONLY when the shell method
 * exists — a newer dist on an older shell must let the key fall through,
 * not eat it.
 */

import { rivetShell } from './shell-bridge.js'

export function installShellKeys(): void {
  const shell = rivetShell()
  if (!shell || shell.platform !== 'win32') return
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const key = e.key.toLowerCase()
      // Zoom-in tolerates Shift: Ctrl+= and Ctrl+Shift+= (i.e. Ctrl++) are
      // the same physical intent on most layouts.
      if (e.shiftKey && key === 'n' && shell.newWindow) {
        e.preventDefault()
        void shell.newWindow()
      } else if (e.shiftKey && key === 'q' && shell.quitApp) {
        e.preventDefault()
        void shell.quitApp()
      } else if ((key === '=' || key === '+') && shell.zoomAdjust) {
        e.preventDefault()
        void shell.zoomAdjust(1)
      } else if (!e.shiftKey && key === '-' && shell.zoomAdjust) {
        e.preventDefault()
        void shell.zoomAdjust(-1)
      } else if (!e.shiftKey && key === '0' && shell.zoomAdjust) {
        e.preventDefault()
        void shell.zoomAdjust(0)
      }
    },
    { capture: true },
  )
}
