import type { AgentPreset } from '@rivetos/types'
import { findPresetByHandle, type AgentPresetStore } from './store.js'

const DEFAULT_TTL_MS = 30_000

export interface CachedPresetResolverOptions {
  /** How long a cached list stays fresh. Default 30s. */
  ttlMs?: number
  now?: () => number
  log?: (msg: string) => void
}

/** Observable cache state. A down store is `hasValue: false` plus `lastError`. */
export interface CachedPresetResolverStatus {
  /** True once a refresh has published. False means no successful read yet. */
  hasValue: boolean
  /** Message from the latest failed refresh of the current generation. */
  lastError?: string
  /** `now()` when the cache last published, or 0 if it never has. */
  fetchedAt: number
}

export interface CachedPresetResolver {
  list(): Promise<AgentPreset[]>
  /** Handle priority against the cached list — no `findByHandle` round-trip. */
  find(handle: string): Promise<AgentPreset | undefined>
  lastKnown(): AgentPreset[]
  invalidate(): void
  status(): CachedPresetResolverStatus
}

/**
 * First `list` awaits the store. A fresh cache returns immediately. Past the
 * TTL, a still-current cache returns immediately and refreshes in the
 * background. `invalidate` bumps a generation so a refresh that started
 * earlier cannot publish. `list` captures the generation, awaits at most one
 * refresh for it, and returns the rows that refresh read even when a newer
 * generation exists — they are at least as fresh as the request. Those rows
 * publish only when the generation is still current.
 *
 * A failed refresh never publishes. After a value exists, further lists of
 * that failed generation serve the stale rows until `ttlMs` (`failedGeneration`
 * / `failedAt`) and then retry. A cold failure does not back off.
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
  /** Generation of the latest failed refresh that had a value to serve. -1 if none. */
  let failedGeneration = -1
  let failedAt = 0
  let lastError: string | undefined
  let inflight: { gen: number; promise: Promise<AgentPreset[]> } | null = null

  function startRefresh(gen: number): Promise<AgentPreset[]> {
    if (inflight && inflight.gen === gen) return inflight.promise
    const promise = Promise.resolve()
      .then(() => store.list())
      .then((rows) => {
        // A refresh that started before `invalidate` must not publish.
        if (generation === gen) {
          known = rows
          hasValue = true
          publishedGeneration = gen
          fetchedAt = now()
          failedGeneration = -1
          lastError = undefined
        }
        return rows
      })
      .catch((err: unknown) => {
        // Failures do not publish and do not move `fetchedAt`. With a value
        // already cached, remember this generation so the TTL can serve it
        // stale. A cold failure leaves the backoff unset and the next list
        // tries again. An older generation must not touch the cache.
        const message = err instanceof Error ? err.message : 'unknown error'
        if (generation === gen) {
          lastError = message
          if (hasValue) {
            failedGeneration = gen
            failedAt = now()
          }
        }
        try {
          log?.(`agent preset refresh failed: ${message}`)
        } catch {
          // A throwing logger must not reject the refresh. The stale path is
          // `void startRefresh()`, so a rejection would be unhandled.
        }
        return known.slice()
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null
      })
    inflight = { gen, promise }
    return promise
  }

  async function list(): Promise<AgentPreset[]> {
    const gen = generation
    if (hasValue && failedGeneration === gen && now() - failedAt < ttlMs) {
      return known.slice()
    }
    if (publishedGeneration === gen && hasValue) {
      if (now() - fetchedAt >= ttlMs) void startRefresh(gen)
      return known.slice()
    }
    const rows = await startRefresh(gen)
    return rows.slice()
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
    status(): CachedPresetResolverStatus {
      const snapshot: CachedPresetResolverStatus = { hasValue, fetchedAt }
      if (lastError !== undefined) snapshot.lastError = lastError
      return snapshot
    },
  }
}
