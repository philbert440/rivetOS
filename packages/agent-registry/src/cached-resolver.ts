import type { AgentPreset } from '@rivetos/types'
import { findPresetByHandle, type AgentPresetStore } from './store.js'

const DEFAULT_TTL_MS = 30_000

export interface CachedPresetResolverOptions {
  /** How long a cached list stays fresh. Default 30s. */
  ttlMs?: number
  now?: () => number
  log?: (msg: string) => void
}

export interface CachedPresetResolver {
  list(): Promise<AgentPreset[]>
  /** Handle priority against the cached list — no `findByHandle` round-trip. */
  find(handle: string): Promise<AgentPreset | undefined>
  lastKnown(): AgentPreset[]
  invalidate(): void
}

/**
 * First `list` awaits the store. After that, a stale cache returns the
 * last-known list immediately and refreshes in the background (one refresh
 * in flight). Store errors are logged and the last-known list is kept.
 * `invalidate` makes the next `list` await a fresh read.
 */
export function createCachedPresetResolver(
  store: AgentPresetStore,
  opts?: CachedPresetResolverOptions,
): CachedPresetResolver {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
  const now = opts?.now ?? Date.now
  const log = opts?.log

  let known: AgentPreset[] = []
  let hasValue = false
  let fetchedAt = 0
  let invalidated = false
  let inflight: Promise<void> | null = null

  function refresh(): Promise<void> {
    if (inflight) return inflight
    inflight = Promise.resolve()
      .then(() => store.list())
      .then((rows) => {
        known = rows
        hasValue = true
        fetchedAt = now()
      })
      .catch((err: unknown) => {
        if (hasValue) fetchedAt = now()
        const message = err instanceof Error ? err.message : 'unknown error'
        log?.(`agent preset refresh failed: ${message}`)
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  return {
    async list(): Promise<AgentPreset[]> {
      if (!hasValue || invalidated) {
        invalidated = false
        await refresh()
        return known.slice()
      }
      if (now() - fetchedAt >= ttlMs) void refresh()
      return known.slice()
    },

    async find(handle: string): Promise<AgentPreset | undefined> {
      const rows = await this.list()
      return findPresetByHandle(rows, handle)
    },

    lastKnown(): AgentPreset[] {
      return known.slice()
    },

    invalidate(): void {
      invalidated = true
    },
  }
}
