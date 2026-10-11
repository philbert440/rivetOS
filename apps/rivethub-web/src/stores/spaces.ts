/**
 * Spaces and which thread lives in which one. Client-only (plan decision 1):
 * nothing on the session record. A thread is in exactly one space or in
 * History (no membership entry).
 *
 * Membership keys are `${baseUrl}::${sessionKey}`, the same string
 * `storageKey` / the archive store use. Object key order is recency: placing
 * a thread moves its key to the end, and the cap drops the oldest.
 *
 * `defaults` pre-fill a new thread. There is no directory field: the den
 * derives cwd from the preset id, and `node` is only a den base URL.
 *
 * There is always at least one space: an empty list (first run, or the last
 * space removed) is seeded with a fresh "General", which is deletable like
 * any other. `defaultSpaceId` is where a thread started outside a space goes.
 */

import { HARNESS_IDS, type HarnessId, type ThinkingLevel } from '@rivetos/types'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { uuidv4 } from '../lib/uuid.js'
import { useArchived } from './archived.js'

const KEY = 'rivethub.spaces'
const MAX_MEMBERSHIP = 2000
export const DEFAULT_SPACE_NAME = 'General'
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh']

/** Optional starting point for threads minted inside this space. */
export interface SpaceDefaults {
  agentId?: string
  model?: string
  effort?: ThinkingLevel
  harnessId?: HarnessId
  /** Den base URL. Not a working directory. */
  node?: string
}

/**
 * Patch for `setSpaceDefaults`. A key that is present is written.
 * `undefined` or `''` clears that field.
 */
export type SpaceDefaultsPatch = {
  [K in keyof SpaceDefaults]?: SpaceDefaults[K] | undefined
}

export interface SpaceDef {
  id: string
  name: string
  order: number
  createdAt: number
  defaults?: SpaceDefaults
}

interface SpacesState {
  spaces: SpaceDef[]
  /** Row key → space id. Key order is oldest → newest. */
  membership: Record<string, string>
  addSpace: (name: string) => string
  renameSpace: (id: string, name: string) => void
  /** Drops the space. Its threads lose membership (they return to History).
   *  Removing the last space seeds a fresh General. */
  removeSpace: (id: string) => void
  reorderSpace: (id: string, order: number) => void
  /** `undefined` on a present key clears that default. Unknown id is a no-op. */
  setSpaceDefaults: (id: string, patch: SpaceDefaultsPatch) => void
  place: (rowKey: string, spaceId: string) => void
  unplace: (rowKey: string) => void
  /** Move a membership entry when a draft's chat key is adopted. No-op if `from` is absent. */
  rekey: (from: string, to: string) => void
  spaceOf: (rowKey: string) => string | undefined
  /** First space in order — where threads started outside a space land. */
  defaultSpaceId: () => string
}

type Persisted = Pick<SpacesState, 'spaces' | 'membership'>

/** Present key, or undefined. Index access is `string` without `noUncheckedIndexedAccess`. */
function readMembership(
  membership: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(membership, key)) return undefined
  return membership[key]
}

function capMembership(membership: Record<string, string>): Record<string, string> {
  const keys = Object.keys(membership)
  if (keys.length <= MAX_MEMBERSHIP) return membership
  const next: Record<string, string> = {}
  for (const key of keys.slice(keys.length - MAX_MEMBERSHIP)) {
    const spaceId = readMembership(membership, key)
    if (spaceId === undefined) continue
    next[key] = spaceId
  }
  return next
}

/** Drop entries whose space was rejected by `normalizeSpaces`. */
export function pruneMembership(
  membership: Record<string, string>,
  spaces: readonly SpaceDef[],
): Record<string, string> {
  const ids = new Set(spaces.map((space) => space.id))
  const next: Record<string, string> = {}
  for (const [key, spaceId] of Object.entries(membership)) {
    if (ids.has(spaceId)) next[key] = spaceId
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

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined
}

function asHarnessId(value: unknown): HarnessId | undefined {
  const id = nonEmpty(value)
  return id !== undefined && (HARNESS_IDS as readonly string[]).includes(id)
    ? (id as HarnessId)
    : undefined
}

/** Keep known fields. Anything else (including a raw cwd) is dropped. */
export function normalizeSpaceDefaults(raw: unknown): SpaceDefaults | undefined {
  if (!isPlainObject(raw)) return undefined
  const next: SpaceDefaults = {}
  const agentId = nonEmpty(raw.agentId)
  if (agentId) next.agentId = agentId
  const model = nonEmpty(raw.model)
  if (model) next.model = model
  const effort = asThinkingLevel(raw.effort)
  if (effort) next.effort = effort
  const harnessId = asHarnessId(raw.harnessId)
  if (harnessId) next.harnessId = harnessId
  const node = nonEmpty(raw.node)
  if (node) next.node = node
  return Object.keys(next).length > 0 ? next : undefined
}

function applyDefaultsPatch(
  current: SpaceDefaults | undefined,
  patch: SpaceDefaultsPatch,
): SpaceDefaults | undefined {
  const base: SpaceDefaults = { ...current }
  const read = <K extends keyof SpaceDefaults>(key: K): SpaceDefaults[K] | undefined => {
    if (!Object.hasOwn(patch, key)) return base[key]
    const value = patch[key]
    if (value === undefined || value === '') return undefined
    return value
  }
  const next: SpaceDefaults = {}
  const agentId = read('agentId')
  if (agentId) next.agentId = agentId
  const model = read('model')
  if (model) next.model = model
  const effort = read('effort')
  if (effort) next.effort = effort
  const harnessId = read('harnessId')
  if (harnessId) next.harnessId = harnessId
  const node = read('node')
  if (node) next.node = node
  return Object.keys(next).length > 0 ? next : undefined
}

function spaceWithDefaults(space: SpaceDef, defaults: SpaceDefaults | undefined): SpaceDef {
  if (!defaults) {
    if (!space.defaults) return space
    const { defaults: _gone, ...rest } = space
    return rest
  }
  return { ...space, defaults }
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
    const defaults = normalizeSpaceDefaults(item.defaults)
    if (defaults) space.defaults = defaults
    spaces.push(space)
  }
  return spaces
}

function generalSpace(): SpaceDef {
  return { id: uuidv4(), name: DEFAULT_SPACE_NAME, order: 0, createdAt: Date.now() }
}

/** Never empty: no spaces means a fresh General. */
export function withDefaultSpace(spaces: SpaceDef[]): SpaceDef[] {
  return spaces.length > 0 ? spaces : [generalSpace()]
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
      spaces: [generalSpace()],
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
          return {
            spaces: withDefaultSpace(s.spaces.filter((space) => space.id !== id)),
            membership,
          }
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
      setSpaceDefaults: (id, patch) => {
        set((s) => {
          if (!s.spaces.some((space) => space.id === id)) return s
          return {
            spaces: s.spaces.map((space) =>
              space.id === id
                ? spaceWithDefaults(space, applyDefaultsPatch(space.defaults, patch))
                : space,
            ),
          }
        })
      },
      place: (rowKey, spaceId) => {
        if (!rowKey || !get().spaces.some((space) => space.id === spaceId)) return
        // A placed row is on the canvas, not in History's archive.
        useArchived.getState().unarchive(rowKey)
        set((s) => ({ membership: withMembership(s.membership, rowKey, spaceId) }))
      },
      unplace: (rowKey) => {
        set((s) => {
          if (!Object.hasOwn(s.membership, rowKey)) return s
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
          const spaceId = readMembership(s.membership, from)
          if (spaceId === undefined) return s
          // Destination already placed: keep it. Drop the retired key either way.
          const destinationPlaced = Object.hasOwn(s.membership, to)
          const membership: Record<string, string> = {}
          for (const [key, value] of Object.entries(s.membership)) {
            if (key === from) continue
            membership[key] = value
          }
          if (!destinationPlaced) membership[to] = spaceId
          return { membership }
        })
      },
      spaceOf: (rowKey) => {
        const id = readMembership(get().membership, rowKey)
        if (id === undefined) return undefined
        return get().spaces.some((space) => space.id === id) ? id : undefined
      },
      defaultSpaceId: () => {
        const spaces = withDefaultSpace(get().spaces)
        if (spaces !== get().spaces) set({ spaces })
        return [...spaces].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)[0].id
      },
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
        const stored = normalizeSpaces(blob?.spaces)
        return {
          ...current,
          spaces: withDefaultSpace(stored),
          membership: pruneMembership(normalizeMembership(blob?.membership), stored),
        }
      },
    },
  ),
)

export const SPACES_STORAGE_KEY = KEY
export const SPACES_MEMBERSHIP_CAP = MAX_MEMBERSHIP
