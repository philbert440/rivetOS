/**
 * Escalation/notification push (4e). One WS on /api/notifications/ws for
 * the app's lifetime; frames land as toasts + an inbox list. Ephemeral by
 * contract — /api/outcomes is the durable record; this is the tap on the
 * shoulder.
 */

import { create } from 'zustand'
import type { NotificationFrame } from '@rivetos/types'
import type { Subscription } from '@rivetos/gateway-client'
import { isValidGatewayUrl, useConnection } from './connection.js'

export interface NotificationEntry {
  id: string
  frame: NotificationFrame
  /** still showing as a toast (auto-dismisses); inbox keeps it after */
  toast: boolean
}

const TOAST_MS = 8_000
const INBOX_MAX = 50

/**
 * Desktop shell bridge (4j): under Tauri (withGlobalTauri) forward frames to
 * OS notifications when the window isn't visible — the in-app toast covers
 * the focused case. Feature-detected; the web app takes no Tauri dependency.
 */
interface TauriGlobal {
  notification?: {
    isPermissionGranted(): Promise<boolean>
    requestPermission(): Promise<string>
    sendNotification(opts: { title: string; body: string }): void
  }
}

function nativeNotify(frame: NotificationFrame): void {
  const tauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__
  const api = tauri?.notification
  // Skip the OS notification only when the window is truly foreground —
  // visible AND focused — where the in-app toast already covers it. A
  // visible-but-unfocused window (behind another, other monitor) still gets
  // the native ping (#306 review: the visibilityState-only gate missed it).
  if (!api || (document.visibilityState === 'visible' && document.hasFocus())) return
  void (async () => {
    let granted = await api.isPermissionGranted()
    if (!granted) granted = (await api.requestPermission()) === 'granted'
    if (!granted) return
    api.sendNotification(
      frame.kind === 'escalation'
        ? { title: `⚠ Rivet escalation — ${frame.agentId}`, body: frame.summary }
        : { title: `Rivet task ${frame.status}`, body: frame.taskId },
    )
  })()
}

interface NotificationsState {
  entries: NotificationEntry[]
  unread: number
  connect: (endpointKey: string) => void
  disconnect: () => void
  dismissToast: (id: string) => void
  markAllRead: () => void
}

let subscription: Subscription | undefined
let currentEndpoint: string | undefined
let counter = 0
// Pending toast auto-dismiss timers — cleared on connect/disconnect so no
// timer fires into a torn-down or switched-endpoint store (#300 review).
const timers = new Set<ReturnType<typeof setTimeout>>()

function clearTimers(): void {
  for (const t of timers) clearTimeout(t)
  timers.clear()
}

export const useNotifications = create<NotificationsState>((set) => ({
  entries: [],
  unread: 0,

  connect: (endpointKey) => {
    subscription?.close()
    clearTimers()
    if (currentEndpoint !== undefined && currentEndpoint !== endpointKey) {
      set({ entries: [], unread: 0 })
    }
    currentEndpoint = endpointKey
    // Skip the socket when no http(s) gateway is configured (desktop shell
    // first-run: origin is tauri://localhost) — #4j.
    if (!isValidGatewayUrl(useConnection.getState().baseUrl)) return
    const { gateway } = useConnection.getState()
    subscription = gateway.watchNotifications((frame) => {
      nativeNotify(frame)
      counter += 1
      const id = `n-${String(counter)}`
      set((s) => ({
        entries: [{ id, frame, toast: true }, ...s.entries].slice(0, INBOX_MAX),
        unread: s.unread + 1,
      }))
      const timer = setTimeout(() => {
        timers.delete(timer)
        set((s) => ({
          entries: s.entries.map((e) => (e.id === id ? { ...e, toast: false } : e)),
        }))
      }, TOAST_MS)
      timers.add(timer)
      ;(timer as { unref?: () => void }).unref?.()
    })
  },

  disconnect: () => {
    subscription?.close()
    subscription = undefined
    clearTimers()
  },

  dismissToast: (id) =>
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? { ...e, toast: false } : e)) })),

  markAllRead: () => set({ unread: 0 }),
}))
