/**
 * Open a link in the user's browser from any Hub surface. Desktop shells
 * route external links over IPC (Electron denies window.open into new shell
 * windows; WebKitGTK silently drops new-window requests); browsers keep
 * plain window.open.
 *
 * Order: `rivetShell.openExternal` (Electron preload bridge), then
 * `__TAURI__.opener` (Android RivetHubBridge shim).
 */

import { rivetShell } from './shell-bridge.js'

interface TauriOpener {
  openUrl(url: string): Promise<void>
}

function openViaTauri(url: string): boolean {
  const opener = (globalThis as { __TAURI__?: { opener?: TauriOpener } }).__TAURI__?.opener
  if (opener && typeof opener.openUrl === 'function') {
    void opener.openUrl(url).catch(() => window.open(url, '_blank', 'noopener'))
    return true
  }
  return false
}

export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return // never forward javascript:/file: etc
  const shell = rivetShell()
  if (shell) {
    void shell.openExternal(url).catch(() => window.open(url, '_blank', 'noopener'))
    return
  }
  if (openViaTauri(url)) return
  window.open(url, '_blank', 'noopener')
}
