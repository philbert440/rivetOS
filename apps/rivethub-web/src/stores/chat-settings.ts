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
      const next = { ...s.byKey, [key]: { ...(s.byKey[key] ?? DEFAULT), ...patch } }
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
