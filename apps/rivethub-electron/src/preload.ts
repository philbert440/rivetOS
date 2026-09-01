/**
 * Preload — the ONLY bridge between the hub renderer and the shell. Exposes a
 * minimal typed surface as `window.rivetShell`; the web app feature-detects
 * it in lib/shell-bridge.ts (alongside the `__TAURI__` shapes the Android
 * WebView shim still uses).
 */

import { contextBridge, ipcRenderer } from 'electron'

// Renderer context — the app tsconfig is Node-only, so declare the one DOM
// global this file touches.
declare const window: { self: unknown; top: unknown }

// Top frame only, explicitly. Electron's default (nodeIntegrationInSubFrames
// off) already keeps preloads out of iframes, and the main process
// additionally fences every IPC channel by sender-frame origin — but den
// iframes render LAN-served content, so the invariant "remote content never
// sees rivetShell" gets its own guard here rather than resting on a default
// (review finding, PR #555).
if (window.self !== window.top) {
  // eslint-disable-next-line no-restricted-syntax
  throw new Error('rivetShell preload is top-frame only')
}

const api = {
  /** Which shell this is — lets the web side special-case if it ever must. */
  kind: 'electron' as const,
  /** Loopback mTLS pipe port for an https gateway base (#491). */
  mtlsProxyPort: (target: string): Promise<number> =>
    ipcRenderer.invoke('mtls:proxyPort', target) as Promise<number>,
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('shell:openExternal', url) as Promise<void>,
  clipboardWriteText: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:writeText', text) as Promise<void>,
  clipboardReadText: (): Promise<string> =>
    ipcRenderer.invoke('clipboard:readText') as Promise<string>,
  sendNotification: (opts: { title: string; body: string }): Promise<void> =>
    ipcRenderer.invoke('notify:send', opts) as Promise<void>,
  /** Mirror the unread count to the tray tooltip. */
  setUnread: (count: number): Promise<void> =>
    ipcRenderer.invoke('unread:set', count) as Promise<void>,
  // ---- optional surface (feature-detected; NOT in the web side's required
  // shape check, so an older shell keeps working against a newer dist) ----
  /** Which OS this shell runs on. */
  platform: process.platform as 'win32' | 'linux' | 'darwin',
  /** Open one more shell window (no application menu on Windows — the
   *  renderer owns the chord and forwards it here). */
  newWindow: (): Promise<void> => ipcRenderer.invoke('window:new') as Promise<void>,
  /** Zoom this window: 1 = in, -1 = out, 0 = reset. */
  zoomAdjust: (delta: 1 | -1 | 0): Promise<void> =>
    ipcRenderer.invoke('window:zoom', delta) as Promise<void>,
  /** Quit the app for real (close-to-tray does not apply). */
  quitApp: (): Promise<void> => ipcRenderer.invoke('app:quit') as Promise<void>,
  /** Shell binary version (electron app version, not the web dist). */
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version') as Promise<string>,
  /** Ask MAIN to read the mesh update manifest for the given gateway base
   *  (main resolves its own mTLS pipe; the renderer supplies no URL). */
  checkUpdate: (
    gatewayBase: string,
  ): Promise<{
    current: string
    platform: string
    available?: { version: string; sizeBytes?: number }
  }> =>
    ipcRenderer.invoke('update:check', gatewayBase) as Promise<{
      current: string
      platform: string
      available?: { version: string; sizeBytes?: number }
    }>,
  /** Download+verify+launch the manifest's build for this platform, then the
   *  app quits itself. Main re-reads the manifest at install time — the
   *  renderer supplies only the gateway base, never a URL or digest. */
  installUpdate: (gatewayBase: string): Promise<void> =>
    ipcRenderer.invoke('update:install', gatewayBase) as Promise<void>,
  /** Read all settings from the main process's settings.json file. */
  settingsGetAll: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('settings:getAll') as Promise<Record<string, unknown>>,
  /** Write a single setting to the main process's settings.json file. */
  settingsSet: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke('settings:set', key, value) as Promise<void>,
  /** Write multiple settings to the main process's settings.json file. */
  settingsSetAll: (updates: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('settings:setAll', updates) as Promise<void>,
  /** Remove a single setting from the main process's settings.json file. */
  settingsRemove: (key: string): Promise<void> =>
    ipcRenderer.invoke('settings:remove', key) as Promise<void>,
}

export type RivetShellApi = typeof api

contextBridge.exposeInMainWorld('rivetShell', api)
