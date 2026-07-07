/**
 * Escalation/notification push (4e). One WS on /api/notifications/ws for
 * the app's lifetime; frames land as toasts + an inbox list. Ephemeral by
 * contract — /api/outcomes is the durable record; this is the tap on the
 * shoulder.
 */

import { create } from 'zustand'
import type { NotificationFrame } from '@rivetos/types'
import type { Subscription } from '@rivetos/gateway-client'
import { useConnection } from './connection.js'

export interface NotificationEntry {
  id: string
  frame: NotificationFrame
  /** still showing as a toast (auto-dismisses); inbox keeps it after */
  toast: boolean
}

const TOAST_MS = 8_000
const INBOX_MAX = 50

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
    const { gateway } = useConnection.getState()
    subscription = gateway.watchNotifications((frame) => {
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
