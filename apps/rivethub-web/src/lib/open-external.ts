/**
 * Open a link in the user's browser from any Hub surface. In the Tauri shell
 * window.open is a silent no-op (WebKitGTK drops new-window requests and the
 * shell registers no handler), so external links must ride the opener
 * plugin's IPC; browsers keep plain window.open.
 */

interface TauriOpener {
  openUrl(url: string): Promise<void>
}

export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return // never forward javascript:/file: etc
  const opener = (globalThis as { __TAURI__?: { opener?: TauriOpener } }).__TAURI__?.opener
  if (opener && typeof opener.openUrl === 'function') {
    void opener.openUrl(url).catch(() => window.open(url, '_blank', 'noopener'))
    return
  }
  window.open(url, '_blank', 'noopener')
}
