/**
 * IPC surface for the preload's `window.rivetShell` bridge. Every handler
 * validates its input in the MAIN process — the renderer runs remote-ish
 * content (the bundled hub talks to LAN nodes) and must not be able to point
 * shell capabilities anywhere the shell would not go itself.
 */

import {
  clipboard,
  ipcMain,
  Notification,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import type { PipeState } from './mtls-pipe.js'
import type { MigrationHandle } from './tauri-storage-migration.js'

export interface IpcDeps {
  pipes: PipeState
  setUnread: (count: number) => void
  /** True when the given frame URL belongs to the bundled app origin. */
  isBundledUrl: (url: string) => boolean
  /** One-time Tauri localStorage migration (see tauri-storage-migration.ts). */
  migration: MigrationHandle
  /** True when a webContents id belongs to a window this shell created. */
  isShellWindow: (webContentsId: number) => boolean
}

export function registerIpc(deps: IpcDeps): void {
  // Sender fence, defense-in-depth (review finding, PR #555): only the
  // bundled MAIN frame carries the preload today, but nothing else should
  // ever reach this surface either — a den iframe, an app://-URLed subframe,
  // a future preload-in-subframes flip. Origin AND top-frameness are both
  // required; a missing senderFrame fails closed.
  const trusted = (e: IpcMainInvokeEvent): boolean => {
    const frame = e.senderFrame
    if (!frame || frame !== e.sender.mainFrame) return false
    return deps.isBundledUrl(frame.url)
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
    // Real validation (https-only, host allowlist) lives in parseTarget; the
    // length cap just refuses absurd inputs before they reach a parser.
    if (typeof target !== 'string' || target.length > 512) {
      throw new Error('target must be a gateway base url')
    }
    return deps.pipes.proxyPort(target)
  })

  guarded('shell:openExternal', async (_e, url: unknown): Promise<void> => {
    // Parsed http(s) only — never file:, never a registered protocol
    // handler, never junk that merely starts with a scheme.
    if (typeof url !== 'string' || url.length > 2048) return
    try {
      const p = new URL(url).protocol
      if (p !== 'http:' && p !== 'https:') return
    } catch {
      return
    }
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

  // Tauri localStorage migration — sendSync on purpose: the preload must
  // seed BEFORE the app's first storage reads, and the payload is tiny and
  // handed out once (main writes the marker at hand-out; there is no second
  // IPC leg to lose). Fence: WINDOW IDENTITY, not the frame URL — at
  // preload time the committed URL can still be empty, and a fence that
  // silently never opens would strand every upgrade (review finding,
  // PR #556). Only frames of windows this app created carry the preload at
  // all, and only the main frame passes. The whole handler is fail-closed:
  // sendSync with no returnValue assigned would hang the renderer on a
  // white screen, so every path assigns.
  const trustedSync = (e: IpcMainEvent): boolean => {
    try {
      const frame = e.senderFrame
      if (!frame || frame !== e.sender.mainFrame) return false
      return deps.isShellWindow(e.sender.id)
    } catch {
      return false
    }
  }
  ipcMain.on('migration:legacy', (e) => {
    let payload: Record<string, string> | null = null
    try {
      if (trustedSync(e)) payload = deps.migration.consume()
    } catch {
      payload = null
    }
    e.returnValue = payload
  })
}
