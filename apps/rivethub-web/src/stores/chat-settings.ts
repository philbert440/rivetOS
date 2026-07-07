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

function load(): Record<string, ChatSettings> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ChatSettings>) : {}
  } catch {
    return {}
  }
}

interface SettingsState {
  byKey: Record<string, ChatSettings>
  get: (key: string) => ChatSettings
  set: (key: string, patch: Partial<ChatSettings>) => void
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
}))

export const EFFORTS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: 'no thinking' },
  { value: 'low', label: 'think: low' },
  { value: 'medium', label: 'think: medium' },
  { value: 'high', label: 'think: high' },
  { value: 'xhigh', label: 'think: xhigh' },
]
