/**
 * IPC surface for the preload's `window.rivetShell` bridge. Every handler
 * validates its input in the MAIN process — the renderer runs remote-ish
 * content (the bundled hub talks to LAN nodes) and must not be able to point
 * shell capabilities anywhere the shell would not go itself.
 */

import { clipboard, ipcMain, Notification, shell, type IpcMainInvokeEvent } from 'electron'
import type { PipeState } from './mtls-pipe.js'

export interface IpcDeps {
  pipes: PipeState
  setUnread: (count: number) => void
  /** True when the given frame URL belongs to the bundled app origin. */
  isBundledUrl: (url: string) => boolean
}

export function registerIpc(deps: IpcDeps): void {
  // Sender fence, defense-in-depth (review finding, PR #555): only the
  // bundled top frame carries the preload today, but nothing else should
  // ever reach this surface either — a den iframe, a future subframe with
  // preloads enabled, anything. A missing senderFrame fails closed.
  const trusted = (e: IpcMainInvokeEvent): boolean => {
    const url = e.senderFrame?.url
    return typeof url === 'string' && deps.isBundledUrl(url)
  }
  const guarded = <T>(
    channel: string,
    handler: (e: IpcMainInvokeEvent, ...args: unknown[]) => T,
  ): void => {
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      if (!trusted(e)) throw new Error(`${channel}: untrusted sender`)
      return handler(e, ...args)
    })
  }

  guarded('mtls:proxyPort', (_e, target: unknown): Promise<number> => {
    if (typeof target !== 'string') throw new Error('target must be a string')
    return deps.pipes.proxyPort(target)
  })

  guarded('shell:openExternal', async (_e, url: unknown): Promise<void> => {
    // http(s) only — never file:, never a protocol handler someone registered.
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    await shell.openExternal(url)
  })

  guarded('clipboard:writeText', (_e, text: unknown): void => {
    if (typeof text !== 'string') return
    clipboard.writeText(text)
  })

  guarded('clipboard:readText', () => clipboard.readText())

  guarded('notify:send', (_e, opts: unknown): void => {
    if (typeof opts !== 'object' || opts === null) return
    const { title, body } = opts as { title?: unknown; body?: unknown }
    if (typeof title !== 'string' || typeof body !== 'string') return
    if (!Notification.isSupported()) return
    new Notification({ title, body }).show()
  })

  guarded('unread:set', (_e, count: unknown): void => {
    const n = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, count) : 0
    deps.setUnread(Math.floor(n))
  })
}
