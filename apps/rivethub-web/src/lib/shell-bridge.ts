/**
 * Detection for the Electron shell's preload bridge (`window.rivetShell`).
 *
 * Precedence across every consumer (mtls-proxy, clipboard, open-external,
 * notifications): rivetShell first, then the legacy `__TAURI__` shapes —
 * which must KEEP working, because the Android hub WebView's RivetHubBridge
 * shims the Tauri surface and does not carry rivetShell.
 */

export interface RivetShell {
  kind: string
  mtlsProxyPort(target: string): Promise<number>
  openExternal(url: string): Promise<void>
  clipboardWriteText(text: string): Promise<void>
  clipboardReadText(): Promise<string>
  sendNotification(opts: { title: string; body: string }): Promise<void>
  setUnread(count: number): Promise<void>
}

export function rivetShell(
  g: { rivetShell?: RivetShell } = globalThis as { rivetShell?: RivetShell },
): RivetShell | undefined {
  const shell = g.rivetShell
  if (shell && typeof shell.mtlsProxyPort === 'function') return shell
  return undefined
}

/** True inside any desktop shell (Electron bridge or Tauri global). */
export function isDesktopShell(
  g: { rivetShell?: RivetShell; __TAURI__?: unknown } = globalThis as {
    rivetShell?: RivetShell
    __TAURI__?: unknown
  },
): boolean {
  return rivetShell(g) !== undefined || g.__TAURI__ != null
}
