import type { TermAttachInfo } from '@rivetos/types'

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
  // ---- optional surface (post-first-Electron-release additions) ----
  // Feature-detect at the call site and NEVER add these to SHELL_METHODS:
  // a required method absent from an installed shell fails the full-shape
  // check and turns the whole bridge off for that user.
  platform?: string
  appVersion?(): Promise<string>
  /** Main-process update check for the given gateway base. The renderer
   *  never passes a URL or digest — main owns the manifest and the pipe. */
  checkUpdate?(gatewayBase: string): Promise<{
    current: string
    platform: string
    available?: { version: string; sizeBytes?: number }
  }>
  installUpdate?(gatewayBase: string): Promise<void>
  /** Open one more shell window. */
  newWindow?(): Promise<void>
  /** Zoom this window: 1 = in, -1 = out, 0 = reset. */
  zoomAdjust?(delta: 1 | -1 | 0): Promise<void>
  /** Quit the app for real (close-to-tray does not apply). */
  quitApp?(): Promise<void>
  /** The user's installed terminal-emulator configs (Settings → Terminal →
   *  Import from…). Read-only and argument-free: main owns the path
   *  allowlist, the renderer owns the parsing. */
  readTerminalConfigs?(): Promise<
    Array<{
      kind: 'ghostty' | 'alacritty' | 'kitty' | 'windows-terminal' | 'omarchy'
      path: string
      text: string
      includes: Record<string, string>
      themeName?: string
      usesOmarchy?: boolean
    }>
  >
  /** Read all settings from the main process's settings.json file. */
  settingsGetAll?(): Promise<Record<string, unknown>>
  /** Write a single setting to the main process's settings.json file. */
  settingsSet?(key: string, value: unknown): Promise<void>
  /** Write multiple settings to the main process's settings.json file. */
  settingsSetAll?(updates: Record<string, unknown>): Promise<void>
  /** Remove a single setting from the main process's settings.json file. */
  settingsRemove?(key: string): Promise<void>
  /** Launch the user's real terminal emulator onto a tmux attach (feature-detected). */
  openInTerminal?(attach: TermAttachInfo): Promise<void>
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

/** True inside any desktop/WebView shell (Electron bridge or the Android
 *  shim's `__TAURI__` global). */
export function isDesktopShell(
  g: {
    rivetShell?: RivetShell
    __TAURI__?: unknown
  } = globalThis as {
    rivetShell?: RivetShell
    __TAURI__?: unknown
  },
): boolean {
  return rivetShell(g) !== undefined || g.__TAURI__ != null
}

/** Type guard for Electron shell (has `kind: 'electron'`). */
export function isElectronShell(
  shell: RivetShell | undefined,
): shell is RivetShell & { kind: 'electron' } {
  return shell?.kind === 'electron'
}
