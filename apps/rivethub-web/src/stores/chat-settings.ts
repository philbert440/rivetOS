/**
 * Per-conversation model + effort, persisted (Claude-app style: pick once,
 * sticks for the thread). Keyed by `${baseUrl}::${sessionId}` so a session's
 * choice is per-node. Model is an agent id ('' = node default); effort is a
 * thinking level.
 */

import { create } from 'zustand'
import type { ThinkingLevel } from '@rivetos/types'

export interface ChatSettings {
  /** agent id; '' = the node's default agent */
  agent: string
  effort: ThinkingLevel
}

const KEY = 'rivethub.chatSettings'
const DEFAULT: ChatSettings = { agent: '', effort: 'medium' }

function load(): Record<string, ChatSettings | undefined> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, ChatSettings | undefined>)
      : {}
  } catch {
    return {}
  }
}

interface SettingsState {
  /** values are `| undefined` — see session-names.ts */
  byKey: Record<string, ChatSettings | undefined>
  get: (key: string) => ChatSettings
  set: (key: string, patch: Partial<ChatSettings>) => void
  /** Drop a key outright — the migration half that `set` cannot express, so a
   *  rekeyed thread leaves nothing behind for a later key reuse to resurrect
   *  through the read fallback. Mirrors session-names' empty-string clear. */
  clear: (key: string) => void
}

export const useChatSettings = create<SettingsState>((set, getState) => ({
  byKey: load(),
  get: (key) => getState().byKey[key] ?? DEFAULT,
  set: (key, patch) =>
    set((s) => {
      let next = { ...s.byKey, [key]: { ...(s.byKey[key] ?? DEFAULT), ...patch } }
      // Cap growth: keep the most-recently-touched N (the updated key is
      // re-inserted last, so slicing the tail keeps it) — #310 review.
      const MAX = 200
      const keys = Object.keys(next)
      if (keys.length > MAX) {
        next = Object.fromEntries(keys.slice(-MAX).map((k) => [k, next[k]]))
      }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // storage full / disabled — keep the in-memory value, lose persistence
      }
      return { byKey: next }
    }),

  clear: (key) =>
    set((s) => {
      if (!(key in s.byKey)) return s
      const next = Object.fromEntries(Object.entries(s.byKey).filter(([k]) => k !== key))
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* storage full/disabled — keep in-memory */
      }
      return { byKey: next }
    }),
}))

export const EFFORTS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: 'no thinking' },
  { value: 'low', label: 'think: low' },
  { value: 'medium', label: 'think: medium' },
  { value: 'high', label: 'think: high' },
  { value: 'xhigh', label: 'think: xhigh' },
]
