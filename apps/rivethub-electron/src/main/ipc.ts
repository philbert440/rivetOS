/**
 * IPC surface for the preload's `window.rivetShell` bridge. Every handler
 * validates its input in the MAIN process — the renderer runs remote-ish
 * content (the bundled hub talks to LAN nodes) and must not be able to point
 * shell capabilities anywhere the shell would not go itself.
 */

import { app, clipboard, ipcMain, Notification, shell, type IpcMainInvokeEvent } from 'electron'
import { openInTerminal } from './external-terminal.js'
import type { PipeState } from './mtls-pipe.js'
import type { SettingsStore } from './settings-store.js'
import { checkForUpdate, downloadAndInstall } from './updater.js'

export interface IpcDeps {
  pipes: PipeState
  settingsStore: SettingsStore
  /** Per-window unread report; the shell aggregates across windows. */
  setUnread: (webContentsId: number, count: number) => void
  /** True when the given frame URL belongs to the bundled app origin. */
  isBundledUrl: (url: string) => boolean
  /** Bring a window forward (notification click-through) — the sender when
   *  it is still alive, a sane fallback otherwise. */
  summon: (webContentsId?: number) => void
  /** Open one more shell window. */
  newWindow: () => void
  /** Quit for real (bypasses close-to-tray). */
  quit: () => void
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

  // Open TermAttachInfo in the user's real emulator (T5). MAIN validates the
  // fields and builds argv — a compromised renderer cannot choose argv[0]
  // or smuggle tmux/ssh flags (`-f`, `-oProxyCommand`, …).
  guarded('terminal:open-external', async (_e, attach: unknown): Promise<void> => {
    await openInTerminal(attach)
  })

  guarded('clipboard:writeText', (_e, text: unknown): void => {
    if (typeof text !== 'string') return
    clipboard.writeText(text)
  })

  guarded('clipboard:readText', () => clipboard.readText())

  // Live notifications: an unreferenced Notification is eligible for GC the
  // moment the handler returns, and Electron drops its click/close listeners
  // with the JS object while the OS banner stays on screen — the click
  // handler silently dies within seconds (grok review of this PR; documented
  // Electron failure mode, most reliable on Linux). Retained here until the
  // OS reports click/close/failed.
  const liveNotifications = new Set<Notification>()
  const NOTIFY_TEXT_MAX = 512

  guarded('notify:send', (e, opts: unknown): void => {
    if (typeof opts !== 'object' || opts === null) return
    const { title, body } = opts as { title?: unknown; body?: unknown }
    if (typeof title !== 'string' || typeof body !== 'string') return
    if (!Notification.isSupported()) return
    const senderId = e.sender.id
    const n = new Notification({
      title: title.slice(0, NOTIFY_TEXT_MAX),
      body: body.slice(0, NOTIFY_TEXT_MAX),
    })
    liveNotifications.add(n)
    const drop = (): void => {
      liveNotifications.delete(n)
    }
    // The native path only fires while the window is hidden/unfocused —
    // exactly when the user needs a way back in. A click-less notification
    // was a dead end: the OS banner did nothing and the tray was the only
    // road back (review punch list #3).
    n.on('click', () => {
      deps.summon(senderId)
      drop()
    })
    n.on('close', drop)
    n.on('failed', drop)
    n.show()
  })

  guarded('unread:set', (e, count: unknown): void => {
    const n = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, count) : 0
    deps.setUnread(e.sender.id, Math.floor(n))
  })

  guarded('window:new', (): void => {
    deps.newWindow()
  })

  guarded('app:quit', (): void => {
    deps.quit()
  })

  // Zoom on the SENDER's contents. No application menu carries the zoom
  // roles on Windows (per-keystroke accelerator matching is the #566 typing
  // lag), so the renderer forwards the chords here. ±0.5 matches the
  // zoomIn/zoomOut menu-role step.
  guarded('window:zoom', (e, delta: unknown): void => {
    if (delta !== 1 && delta !== -1 && delta !== 0) return
    const wc = e.sender
    wc.setZoomLevel(
      delta === 0 ? 0 : Math.max(-8, Math.min(9, wc.getZoomLevel() + (delta as number) * 0.5)),
    )
  })

  guarded('app:version', () => app.getVersion())

  // In-app update (settings → Updates): the renderer names only the gateway
  // base it is connected to; the manifest fetch, entry validation, URL
  // construction, download, and digest check all happen in main (updater.ts
  // — main is the trust root, review PR #562). Serialized; on a successful
  // install the flag deliberately STAYS set — the process is quitting, and
  // clearing it early opened a window to race a second installer.
  const gatewayBaseArg = (raw: unknown): string => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512)
      throw new Error('update: gatewayBase must be the connected gateway base url')
    return raw
  }
  let updating = false
  guarded('update:check', (_e, raw: unknown) => checkForUpdate(deps.pipes, gatewayBaseArg(raw)))
  guarded('update:install', async (_e, raw: unknown): Promise<void> => {
    if (updating) throw new Error('installUpdate: already in progress')
    const base = gatewayBaseArg(raw)
    updating = true
    try {
      await downloadAndInstall(deps.pipes, base)
    } catch (err) {
      updating = false
      throw err
    }
  })

  // Settings persistence: the main process owns settings.json in userData,
  // and hydrates the renderer's localStorage on boot if Chromium store is
  // empty. The renderer reads all settings on load, then writes back to
  // the file on every change via setSettings.
  guarded('settings:getAll', () => deps.settingsStore.getAll())
  guarded('settings:set', (_e, key: unknown, value: unknown): void => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 256) return
    deps.settingsStore.set(key, value)
  })
  guarded('settings:setAll', (_e, updates: unknown): void => {
    if (typeof updates !== 'object' || updates === null) return
    deps.settingsStore.setAll(updates as Record<string, unknown>)
  })
  guarded('settings:remove', (_e, key: unknown): void => {
    if (typeof key !== 'string') return
    deps.settingsStore.remove(key)
  })
}
