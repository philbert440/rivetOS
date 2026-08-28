/**
 * Preload — the ONLY bridge between the hub renderer and the shell. Exposes a
 * minimal typed surface as `window.rivetShell`; the web app feature-detects it
 * (lib/shell-bridge.ts) the same way it detects `__TAURI__` for the Tauri
 * shell and the Android WebView shim.
 */

import { contextBridge, ipcRenderer } from 'electron'

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
