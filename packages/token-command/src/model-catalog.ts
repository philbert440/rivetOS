/**
 * Provider model catalog: endpoint listing with a static floor.
 *
 * Sync readers always see the floor (and last-known discovery). Refresh runs
 * in the background with its own deadline — same shape as den-server's
 * backgroundDiscovery, kept here so provider plugins need no den dependency.
 *
 * Building block: vllm / llama-server expose `listModels()` and feed this
 * catalog from `isAvailable()` probes, but no runtime UI/harness consumer
 * reads the merged list yet (den-server `model-sheets` left alone). Wire a
 * reader before treating endpoint discovery as user-visible.
 */

export interface ModelCatalogOptions {
  /** Static ids that are always present (floor). */
  floor: string[]
  /** Fetch discovered ids from the provider endpoint. */
  fetchIds: () => Promise<string[]>
  ttlMs?: number
  timeoutMs?: number
  now?: () => number
  log?: (msg: string) => void
  /** Cache key label for log lines. */
  label?: string
}

export interface ModelCatalog {
  /** Floor + discovered (floor first, then new ids). */
  list(): string[]
  /** Kick a refresh when TTL expired; returns current list immediately. */
  refresh(): string[]
  /** Test helper — last discovery error message, if any. */
  lastError(): string | undefined
}

interface Entry {
  discovered: string[]
  at: number
  failing: boolean
  lastError?: string
  inflight?: Promise<void>
}

const DEFAULT_TTL_MS = 60_000
const DEFAULT_TIMEOUT_MS = 5_000

export function createModelCatalog(opts: ModelCatalogOptions): ModelCatalog {
  const floor = dedupe(opts.floor.filter((id) => id.length > 0))
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const label = opts.label ?? 'models'
  const entry: Entry = {
    discovered: [],
    at: Number.NEGATIVE_INFINITY,
    failing: false,
  }

  function merged(): string[] {
    return dedupe([...floor, ...entry.discovered])
  }

  function refresh(): string[] {
    const t = now()
    if (!entry.inflight && t - entry.at >= ttlMs) {
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${String(timeoutMs)} ms`)),
          timeoutMs,
        )
        timer.unref()
      })
      const attempt = Promise.resolve().then(opts.fetchIds)
      entry.inflight = Promise.race([attempt, deadline])
        .then((ids) => {
          entry.discovered = dedupe(ids.filter((id) => typeof id === 'string' && id.length > 0))
          entry.failing = false
          entry.lastError = undefined
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          entry.lastError = msg
          if (opts.log && !entry.failing) {
            const kept = entry.discovered.length === 0 ? 'static floor' : 'last-known list'
            opts.log(`[token-command] model catalog ${label}: ${msg} — serving the ${kept}`)
          }
          entry.failing = true
        })
        .finally(() => {
          if (timer) clearTimeout(timer)
          entry.at = now()
          entry.inflight = undefined
        })
    }
    return merged()
  }

  return {
    list: () => merged(),
    refresh,
    lastError: () => entry.lastError,
  }
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
