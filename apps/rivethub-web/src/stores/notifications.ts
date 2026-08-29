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
import { rivetShell } from '../lib/shell-bridge.js'

export interface NotificationEntry {
  id: string
  frame: NotificationFrame
  /** still showing as a toast (auto-dismisses); inbox keeps it after */
  toast: boolean
}

const TOAST_MS = 8_000
const INBOX_MAX = 50

function notifyPayload(frame: NotificationFrame): { title: string; body: string } {
  return frame.kind === 'escalation'
    ? { title: `⚠ Rivet escalation — ${frame.agentId}`, body: frame.summary }
    : frame.kind === 'workflow.gate'
      ? {
          title: `Rivet gate · ${frame.workflowId}`,
          body: frame.prompt?.trim() || `${frame.label} — ${frame.runId}`,
        }
      : { title: `Rivet task ${frame.status}`, body: frame.taskId }
}

function nativeNotify(frame: NotificationFrame): void {
  const shell = rivetShell()
  // Skip the OS notification only when the window is truly foreground —
  // visible AND focused — where the in-app toast already covers it. A
  // visible-but-unfocused window (behind another, other monitor) still gets
  // the native ping (#306 review: the visibilityState-only gate missed it).
  if (!shell || (document.visibilityState === 'visible' && document.hasFocus())) return
  // Electron main-process notifications need no permission handshake.
  void shell.sendNotification(notifyPayload(frame)).catch(() => undefined)
}

/** Mirror the unread count to the desktop shell's tray (feature-detected —
 *  no-op in the browser). The tray is the only surface a hidden-to-tray app
 *  has, so it must know when something is waiting. */
function emitUnreadToShell(count: number): void {
  void rivetShell()
    ?.setUnread(count)
    .catch(() => undefined)
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
      emitUnreadToShell(0)
    }
    currentEndpoint = endpointKey
    // Skip the socket when no http(s) gateway is configured (desktop shell
    // first-run before a node is enrolled).
    if (!isValidGatewayUrl(useConnection.getState().baseUrl)) return
    const { gateway } = useConnection.getState()
    subscription = gateway.watchNotifications((frame) => {
      nativeNotify(frame)
      counter += 1
      const id = `n-${String(counter)}`
      set((s) => {
        emitUnreadToShell(s.unread + 1)
        return {
          entries: [{ id, frame, toast: true }, ...s.entries].slice(0, INBOX_MAX),
          unread: s.unread + 1,
        }
      })
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

  markAllRead: () => {
    emitUnreadToShell(0)
    set({ unread: 0 })
  },
}))
