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

const SHELL_METHODS = [
  'mtlsProxyPort',
  'openExternal',
  'clipboardWriteText',
  'clipboardReadText',
  'sendNotification',
  'setUnread',
] as const

export function rivetShell(
  g: { rivetShell?: RivetShell } = globalThis as { rivetShell?: RivetShell },
): RivetShell | undefined {
  const shell = g.rivetShell
  if (!shell) return undefined
  // Full-shape check: a partial/foreign global passing detection would make
  // the OTHER consumers throw at call time — all methods or nothing.
  for (const m of SHELL_METHODS) {
    if (typeof shell[m] !== 'function') return undefined
  }
  return shell
}

/** True inside any desktop shell (Electron bridge or either Tauri-shaped
 *  global — the Android shim / a partial host may expose only INTERNALS). */
export function isDesktopShell(
  g: { rivetShell?: RivetShell; __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown } = globalThis as {
    rivetShell?: RivetShell
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
  },
): boolean {
  return rivetShell(g) !== undefined || g.__TAURI__ != null || g.__TAURI_INTERNALS__ != null
}
