/**
 * Spaces and which thread lives in which one. Client-only (plan decision 1):
 * nothing on the session record. A thread is in exactly one space or in
 * History (no membership entry).
 *
 * Membership keys are `${baseUrl}::${sessionKey}`, the same string
 * `storageKey` / the archive store use. Object key order is recency: placing
 * a thread moves its key to the end, and the cap drops the oldest.
 *
 * `defaults` is reserved for a later slice (starting directory and the like).
 * This slice never reads it.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { uuidv4 } from '../lib/uuid.js'

const KEY = 'rivethub.spaces'
const MAX_MEMBERSHIP = 2000

export interface SpaceDef {
  id: string
  name: string
  order: number
  createdAt: number
  defaults?: Record<string, unknown>
}

interface SpacesState {
  spaces: SpaceDef[]
  /** Row key → space id. Key order is oldest → newest. */
  membership: Record<string, string>
  addSpace: (name: string) => string
  renameSpace: (id: string, name: string) => void
  /** Drops the space. Its threads lose membership (they return to History). */
  removeSpace: (id: string) => void
  reorderSpace: (id: string, order: number) => void
  place: (rowKey: string, spaceId: string) => void
  unplace: (rowKey: string) => void
  /** Move a membership entry when a draft's chat key is adopted. No-op if `from` is absent. */
  rekey: (from: string, to: string) => void
  spaceOf: (rowKey: string) => string | undefined
  /** Rows whose `.key` is the membership key (`${baseUrl}::${session}`). */
  rowsIn: <T extends { key: string }>(spaceId: string, rows: readonly T[]) => T[]
}

type Persisted = Pick<SpacesState, 'spaces' | 'membership'>

function capMembership(membership: Record<string, string>): Record<string, string> {
  const keys = Object.keys(membership)
  if (keys.length <= MAX_MEMBERSHIP) return membership
  const next: Record<string, string> = {}
  for (const key of keys.slice(keys.length - MAX_MEMBERSHIP)) {
    const spaceId = membership[key]
    if (spaceId !== undefined) next[key] = spaceId
  }
  return next
}

function withMembership(
  membership: Record<string, string>,
  rowKey: string,
  spaceId: string,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(membership)) {
    if (key !== rowKey) next[key] = value
  }
  next[rowKey] = spaceId
  return capMembership(next)
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
}

export function normalizeSpaces(raw: unknown): SpaceDef[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const spaces: SpaceDef[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    if (typeof item.id !== 'string' || item.id.length === 0) continue
    if (typeof item.name !== 'string') continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const order =
      typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : spaces.length
    const createdAt =
      typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0
    const space: SpaceDef = { id: item.id, name: item.name, order, createdAt }
    if (isPlainObject(item.defaults)) space.defaults = item.defaults
    spaces.push(space)
  }
  return spaces
}

export function normalizeMembership(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {}
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && key.length > 0) next[key] = value
  }
  return capMembership(next)
}

export const useSpaces = create<SpacesState>()(
  persist(
    (set, get) => ({
      spaces: [],
      membership: {},
      addSpace: (name) => {
        const trimmed = name.trim()
        if (!trimmed) return ''
        const id = uuidv4()
        set((s) => {
          const order = s.spaces.reduce((max, space) => Math.max(max, space.order), -1) + 1
          return {
            spaces: [...s.spaces, { id, name: trimmed, order, createdAt: Date.now() }],
          }
        })
        return id
      },
      renameSpace: (id, name) => {
        const trimmed = name.trim()
        if (!trimmed) return
        set((s) => {
          if (!s.spaces.some((space) => space.id === id)) return s
          return {
            spaces: s.spaces.map((space) =>
              space.id === id ? { ...space, name: trimmed } : space,
            ),
          }
        })
      },
      removeSpace: (id) => {
        set((s) => {
          if (!s.spaces.some((space) => space.id === id)) return s
          const membership: Record<string, string> = {}
          for (const [key, spaceId] of Object.entries(s.membership)) {
            if (spaceId !== id) membership[key] = spaceId
          }
          return { spaces: s.spaces.filter((space) => space.id !== id), membership }
        })
      },
      reorderSpace: (id, order) => {
        if (!Number.isFinite(order)) return
        set((s) => {
          if (!s.spaces.some((space) => space.id === id)) return s
          return {
            spaces: s.spaces.map((space) => (space.id === id ? { ...space, order } : space)),
          }
        })
      },
      place: (rowKey, spaceId) => {
        if (!rowKey || !get().spaces.some((space) => space.id === spaceId)) return
        set((s) => ({ membership: withMembership(s.membership, rowKey, spaceId) }))
      },
      unplace: (rowKey) => {
        set((s) => {
          if (s.membership[rowKey] === undefined) return s
          const membership: Record<string, string> = {}
          for (const [key, spaceId] of Object.entries(s.membership)) {
            if (key !== rowKey) membership[key] = spaceId
          }
          return { membership }
        })
      },
      rekey: (from, to) => {
        if (!from || !to || from === to) return
        set((s) => {
          const spaceId = s.membership[from]
          if (spaceId === undefined) return s
          const membership: Record<string, string> = {}
          for (const [key, value] of Object.entries(s.membership)) {
            if (key === from) {
              if (membership[to] === undefined) membership[to] = spaceId
            } else if (key !== to) {
              membership[key] = value
            }
          }
          return { membership }
        })
      },
      spaceOf: (rowKey) => {
        const id = get().membership[rowKey]
        if (id === undefined) return undefined
        return get().spaces.some((space) => space.id === id) ? id : undefined
      },
      rowsIn: (spaceId, rows) => rows.filter((row) => get().membership[row.key] === spaceId),
    }),
    {
      name: KEY,
      // Resolved per call, and failures ignored: storage may be disabled
      // (private window) or not there yet. The canvas must still open.
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          try {
            return globalThis.localStorage.getItem(name)
          } catch {
            return null
          }
        },
        setItem: (name, value) => {
          try {
            globalThis.localStorage.setItem(name, value)
          } catch {
            /* not persisted */
          }
        },
        removeItem: (name) => {
          try {
            globalThis.localStorage.removeItem(name)
          } catch {
            /* not persisted */
          }
        },
      })),
      partialize: (s): Persisted => ({ spaces: s.spaces, membership: s.membership }),
      merge: (persisted, current) => {
        const blob = persisted as Partial<Persisted> | undefined
        return {
          ...current,
          spaces: normalizeSpaces(blob?.spaces),
          membership: normalizeMembership(blob?.membership),
        }
      },
    },
  ),
)

export const SPACES_STORAGE_KEY = KEY
export const SPACES_MEMBERSHIP_CAP = MAX_MEMBERSHIP
