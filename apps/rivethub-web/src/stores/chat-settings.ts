/**
 * Per-conversation model + effort, persisted (Claude-app style: pick once,
 * sticks for the thread). Keyed by `${baseUrl}::${sessionId}` so a session's
 * choice is per-node. Launch settings and per-turn overrides are separate.
 */

import type { ConversationTurnPick } from '../lib/conversation-model-options.js'
import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import type { HarnessId, ThinkingLevel } from '@rivetos/types'

export interface ChatSettings {
  /** Model/effort overrides for subsequent turns; never POST /term flags. */
  turnPick?: ConversationTurnPick
  /** Catalog agent / roster command for the chat-loop picker; '' = node default. */
  agent: string
  /** Chat-loop thinking level. */
  effort: ThinkingLevel
  /** Harness this thread should spawn. */
  harnessId?: HarnessId
  /** Real model id passed to POST /term; empty = harness default. */
  model?: string
  /** Effort id passed to POST /term when it is not a ThinkingLevel (e.g. max). */
  harnessEffort?: string
  /** Agent-preset system prompt for this thread; '' / omitted = none. */
  systemPrompt?: string
}

/** Agent/harness changes invalidate overrides even when supplied in the same patch. */
export function mergeChatSettings(
  current: ChatSettings | undefined,
  patch: Partial<ChatSettings>,
): ChatSettings {
  const changed =
    current !== undefined &&
    (('agent' in patch && patch.agent !== current.agent) ||
      ('harnessId' in patch && patch.harnessId !== current.harnessId))
  // A harness/agent change also drops a stale spawn-time model (#814) so it
  // can't launch the next harness with the previous one's `--model` — unless
  // this same patch sets a model (e.g. opening a preset stamps harnessId + model
  // together), which must win.
  const clearModel = changed && !('model' in patch)
  return {
    ...DEFAULT,
    ...current,
    ...patch,
    ...(changed ? { turnPick: undefined } : {}),
    ...(clearModel ? { model: undefined } : {}),
  }
}

const KEY = 'rivethub.chatSettings'
const DEFAULT: ChatSettings = { agent: '', effort: 'medium' }

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

type Persisted = Pick<SettingsState, 'byKey'>

/**
 * The on-disk format predates the persist middleware and must keep working:
 * the raw `byKey` record, no `{ state, version }` envelope. Storage errors
 * (full / disabled) keep the in-memory value and lose persistence, as before.
 */
const storage: PersistStorage<Persisted> = {
  getItem: (name) => {
    try {
      const raw = localStorage.getItem(name)
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      return {
        state: {
          byKey:
            parsed && typeof parsed === 'object'
              ? (parsed as Record<string, ChatSettings | undefined>)
              : {},
        },
        version: 0,
      }
    } catch {
      return { state: { byKey: {} }, version: 0 }
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, JSON.stringify(value.state.byKey))
    } catch {
      /* storage full / disabled — keep the in-memory value */
    }
  },
  removeItem: (name) => {
    localStorage.removeItem(name)
  },
}

export const useChatSettings = create<SettingsState>()(
  persist(
    (set, getState) => ({
      byKey: {},
      get: (key) => getState().byKey[key] ?? DEFAULT,
      set: (key, patch) =>
        set((s) => {
          let next = { ...s.byKey, [key]: mergeChatSettings(s.byKey[key], patch) }
          // Cap growth: keep the most-recently-touched N (the updated key is
          // re-inserted last, so slicing the tail keeps it) — #310 review.
          const MAX = 200
          const keys = Object.keys(next)
          if (keys.length > MAX) {
            next = Object.fromEntries(keys.slice(-MAX).map((k) => [k, next[k]]))
          }
          return { byKey: next }
        }),

      clear: (key) =>
        set((s) => {
          if (!(key in s.byKey)) return s
          return {
            byKey: Object.fromEntries(Object.entries(s.byKey).filter(([k]) => k !== key)),
          }
        }),
    }),
    { name: KEY, storage, partialize: (s) => ({ byKey: s.byKey }) },
  ),
)
