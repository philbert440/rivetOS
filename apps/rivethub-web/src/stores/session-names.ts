/**
 * Custom conversation names, persisted (localStorage) and keyed per node +
 * session — the drawer shows a user-set name over the derived title (first
 * user message). Empty/cleared → falls back to the derived title.
 */

import { create } from 'zustand'

const KEY = 'rivethub.sessionNames'
const MAX = 500

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

interface SessionNamesState {
  byKey: Record<string, string>
  /** Custom name for a node+session, or undefined. */
  get: (key: string) => string | undefined
  /** Set (trimmed) or clear (empty string clears the override). */
  set: (key: string, name: string) => void
}

export const useSessionNames = create<SessionNamesState>((set, getState) => ({
  byKey: load(),
  get: (key) => getState().byKey[key],
  set: (key, name) =>
    set((s) => {
      const trimmed = name.trim()
      const next = trimmed
        ? { ...s.byKey, [key]: trimmed }
        : Object.fromEntries(Object.entries(s.byKey).filter(([k]) => k !== key))
      // cap growth: keep the most-recently-touched entries
      const keys = Object.keys(next)
      const capped =
        keys.length > MAX ? Object.fromEntries(keys.slice(-MAX).map((k) => [k, next[k]])) : next
      try {
        localStorage.setItem(KEY, JSON.stringify(capped))
      } catch {
        /* storage full/disabled — keep in-memory */
      }
      return { byKey: capped }
    }),
}))
