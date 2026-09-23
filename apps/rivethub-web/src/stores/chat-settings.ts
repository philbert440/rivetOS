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
  /**
   * Launch model for this thread — preset-stamped or picked from this
   * conversation's harness sheet before the first spawn — sent to `POST /term`.
   * Empty or omitted = harness default.
   */
  model?: string
  /**
   * True once `POST /term` has succeeded for this thread. Latches the pre-spawn
   * model picker shut across PTY loss and remount: a legacy row never flips
   * `bound`, and an inject-409 respawn clears the pty id, so neither can be
   * the lock. Persisted here because chat settings are already the
   * per-conversation record that survives a reload. The latch lives in this
   * capped map, so it holds for the most recent 200 conversations.
   */
  launched?: boolean
  /** Effort id passed to POST /term when it is not a ThinkingLevel (e.g. max). */
  harnessEffort?: string
  /** Agent-preset system prompt for this thread; '' / omitted = none. */
  systemPrompt?: string
}

/**
 * An agent or harness change drops per-turn overrides even when the same
 * patch supplies them. It also drops the launch model — unless this patch
 * itself sets `model`, which always wins over that implicit clear (#821) —
 * and clears `launched`, so the new harness gets its own pre-launch picker.
 * A patch cannot carry `launched: true` across that change.
 * Re-selecting the same agent or harness is not a change.
 */
export function mergeChatSettings(
  current: ChatSettings | undefined,
  patch: Partial<ChatSettings>,
): ChatSettings {
  const changed =
    current !== undefined &&
    (('agent' in patch && patch.agent !== current.agent) ||
      ('harnessId' in patch && patch.harnessId !== current.harnessId))
  const clearModel = changed && !('model' in patch)
  return {
    ...DEFAULT,
    ...current,
    ...patch,
    ...(changed ? { turnPick: undefined, launched: undefined } : {}),
    ...(clearModel ? { model: undefined } : {}),
  }
}

/**
 * Patch for a launch-state write (latch, pre-spawn model pick, stale clear).
 * When the canonical key has no record but the read-fallback settings do,
 * merge them so the write migrates the record instead of shadowing it with
 * defaults. A canonical record, or no record at all, takes the patch alone.
 */
export function launchStateWrite<T extends object>(
  canonical: T | undefined,
  effective: T | undefined,
  patch: Partial<T>,
): Partial<T> {
  if (canonical === undefined && effective !== undefined) return { ...effective, ...patch }
  return patch
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
          const merged = mergeChatSettings(s.byKey[key], patch)
          // Cap growth: keep the most-recently-touched N. Rebuild so the
          // touched key is last — object spread keeps an existing key in
          // place (#310 review).
          const next: Record<string, ChatSettings | undefined> = {}
          for (const existing of Object.keys(s.byKey)) {
            if (existing !== key) next[existing] = s.byKey[existing]
          }
          next[key] = merged
          const MAX = 200
          const keys = Object.keys(next)
          return {
            byKey:
              keys.length > MAX
                ? Object.fromEntries(keys.slice(-MAX).map((k) => [k, next[k]]))
                : next,
          }
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
