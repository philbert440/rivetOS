/**
 * IPC surface for the preload's `window.rivetShell` bridge. Every handler
 * validates its input in the MAIN process — the renderer runs remote-ish
 * content (the bundled hub talks to LAN nodes) and must not be able to point
 * shell capabilities anywhere the shell would not go itself.
 */

import { clipboard, ipcMain, Notification, shell } from 'electron'
import type { PipeState } from './mtls-pipe.js'

export interface IpcDeps {
  pipes: PipeState
  setUnread: (count: number) => void
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('mtls:proxyPort', async (_e, target: unknown): Promise<number> => {
    if (typeof target !== 'string') throw new Error('target must be a string')
    return deps.pipes.proxyPort(target)
  })

  ipcMain.handle('shell:openExternal', async (_e, url: unknown): Promise<void> => {
    // http(s) only — never file:, never a protocol handler someone registered.
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    await shell.openExternal(url)
  })

  ipcMain.handle('clipboard:writeText', (_e, text: unknown): void => {
    if (typeof text !== 'string') return
    clipboard.writeText(text)
  })

  ipcMain.handle('clipboard:readText', () => clipboard.readText())

  ipcMain.handle('notify:send', (_e, opts: unknown): void => {
    if (typeof opts !== 'object' || opts === null) return
    const { title, body } = opts as { title?: unknown; body?: unknown }
    if (typeof title !== 'string' || typeof body !== 'string') return
    if (!Notification.isSupported()) return
    new Notification({ title, body }).show()
  })

  ipcMain.handle('unread:set', (_e, count: unknown): void => {
    const n = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, count) : 0
    deps.setUnread(Math.floor(n))
  })
}
