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
 * per generation). Store errors are logged and the last-known list is kept.
 * `invalidate` bumps a generation so a refresh that started earlier cannot
 * publish, and the next `list` awaits a refresh started at the new generation.
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
  let generation = 0
  /** Generation `known` was published under. -1 until the first success. */
  let publishedGeneration = -1
  let inflight: { gen: number; promise: Promise<void> } | null = null

  function startRefresh(gen: number): Promise<void> {
    if (inflight && inflight.gen === gen) return inflight.promise
    const promise = Promise.resolve()
      .then(() => store.list())
      .then((rows) => {
        if (generation !== gen) return
        known = rows
        hasValue = true
        publishedGeneration = gen
        fetchedAt = now()
      })
      .catch((err: unknown) => {
        // A failed refresh of the current generation stamps `fetchedAt` so a
        // dead store is not retried on every list until the TTL passes. A cold
        // failure does not: the next list tries again. An older generation
        // must not touch the cache.
        if (generation === gen && hasValue) fetchedAt = now()
        try {
          const message = err instanceof Error ? err.message : 'unknown error'
          log?.(`agent preset refresh failed: ${message}`)
        } catch {
          // A throwing logger must not reject the refresh. The stale path is
          // `void startRefresh()`, so a rejection would be unhandled.
        }
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null
      })
    inflight = { gen, promise }
    return promise
  }

  async function list(): Promise<AgentPreset[]> {
    let gen = generation
    while (publishedGeneration !== gen || !hasValue) {
      await startRefresh(gen)
      if (generation === gen) return known.slice()
      gen = generation
    }
    if (now() - fetchedAt >= ttlMs) void startRefresh(gen)
    return known.slice()
  }

  async function find(handle: string): Promise<AgentPreset | undefined> {
    const rows = await list()
    return findPresetByHandle(rows, handle)
  }

  return {
    list,
    find,
    lastKnown(): AgentPreset[] {
      return known.slice()
    },
    invalidate(): void {
      generation += 1
    },
  }
}
