/**
 * Archived conversations, persisted per node+session key (same
 * `${baseUrl}::${key}` scheme as names/settings). Archiving only hides the
 * row — the on-disk harness store is untouched, so unarchive always restores.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const KEY = 'rivethub.archivedSessions'
const MAX = 1000

interface ArchivedState {
  keys: string[]
  isArchived: (key: string) => boolean
  archive: (key: string) => void
  unarchive: (key: string) => void
}

export const useArchived = create<ArchivedState>()(
  persist(
    (set, get) => ({
      keys: [],
      isArchived: (key) => get().keys.includes(key),
      archive: (key) =>
        set((s) => {
          if (s.keys.includes(key)) return s
          const next = [...s.keys, key]
          return { keys: next.length > MAX ? next.slice(-MAX) : next }
        }),
      unarchive: (key) => set((s) => ({ keys: s.keys.filter((k) => k !== key) })),
    }),
    { name: KEY, partialize: (s) => ({ keys: s.keys }) },
  ),
)
