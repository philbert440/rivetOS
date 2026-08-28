/**
 * Preload — the ONLY bridge between the hub renderer and the shell. Exposes a
 * minimal typed surface as `window.rivetShell`; the web app feature-detects it
 * (lib/shell-bridge.ts) the same way it detects `__TAURI__` for the Tauri
 * shell and the Android WebView shim.
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
}

export type RivetShellApi = typeof api

contextBridge.exposeInMainWorld('rivetShell', api)
