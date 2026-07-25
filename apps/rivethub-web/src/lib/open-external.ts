/**
 * Open a link in the user's browser from any Hub surface. In the Tauri shell
 * window.open is a silent no-op (WebKitGTK drops new-window requests and the
 * shell registers no handler), so external links must ride the opener
 * plugin's IPC; browsers keep plain window.open.
 *
 * Prefer `__TAURI__.opener` (withGlobalTauri + Android RivetHubBridge shim);
 * fall back to `__TAURI_INTERNALS__.invoke` when the property is missing so
 * a partial global still opens links.
 */

interface TauriOpener {
  openUrl(url: string): Promise<void>
}

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
}

function openViaTauri(url: string): boolean {
  const opener = (globalThis as { __TAURI__?: { opener?: TauriOpener } }).__TAURI__?.opener
  if (opener && typeof opener.openUrl === 'function') {
    void opener.openUrl(url).catch(() => window.open(url, '_blank', 'noopener'))
    return true
  }
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (internals && typeof internals.invoke === 'function') {
    void internals
      .invoke('plugin:opener|open_url', { url })
      .catch(() => window.open(url, '_blank', 'noopener'))
    return true
  }
  return false
}

export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return // never forward javascript:/file: etc
  if (openViaTauri(url)) return
  window.open(url, '_blank', 'noopener')
}
