/**
 * Custom conversation names, persisted (localStorage) and keyed per node +
 * session — the drawer shows a user-set name over the derived title (first
 * user message). Empty/cleared → falls back to the derived title.
 */

import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'

const KEY = 'rivethub.sessionNames'
const MAX = 500

interface SessionNamesState {
  /** values are `| undefined` because bare index access IS undefined for a
   *  missing key — keeps callers' fallback chains honest under
   *  no-unnecessary-condition */
  byKey: Record<string, string | undefined>
  /** Custom name for a node+session, or undefined. */
  get: (key: string) => string | undefined
  /** Set (trimmed) or clear (empty string clears the override). */
  set: (key: string, name: string) => void
}

type Persisted = Pick<SessionNamesState, 'byKey'>

/** The on-disk format predates the persist middleware and must keep working:
 *  the raw `byKey` record, no `{ state, version }` envelope. */
const storage: PersistStorage<Persisted> = {
  getItem: (name) => {
    try {
      const raw = localStorage.getItem(name)
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      return {
        state: {
          byKey:
            parsed && typeof parsed === 'object'
              ? (parsed as Record<string, string | undefined>)
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

export const useSessionNames = create<SessionNamesState>()(
  persist(
    (set, getState) => ({
      byKey: {},
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
          return { byKey: capped }
        }),
    }),
    { name: KEY, storage, partialize: (s) => ({ byKey: s.byKey }) },
  ),
)
