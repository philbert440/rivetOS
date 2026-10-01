/**
 * Environment-driven configuration for the compaction worker.
 */

import { sharedPath } from '@rivetos/types'

function fail(message: string): never {
  console.error(`[CompactWorker] ${message}`)
  process.exit(1)
}

function requireEnv(name: string, detail?: string): string {
  const value = process.env[name]
  if (!value) fail(`${name} is required${detail ? `. ${detail}` : ''}`)
  return value
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * A list of 4xx status codes, e.g. "403,404". Anything that is not a 4xx is
 * an error rather than silently dropped: 5xx already retry, and a typo here
 * would otherwise leave the overload codes terminal without a word.
 */
function parseStatusList(raw: string, separator: string, where: string): number[] {
  return raw
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const code = Number(part)
      if (!Number.isInteger(code) || code < 400 || code > 499) {
        fail(`${where}: "${part}" is not a 4xx status code`)
      }
      return code
    })
}

function statusListEnv(name: string): number[] {
  const raw = process.env[name]
  return raw ? parseStatusList(raw, ',', name) : []
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0)
    fail(`${name} must be a positive integer, got "${raw}"`)
  return parsed
}

function httpUrl(raw: string, where: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail(`${where}: "${raw}" is not a URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`${where}: "${raw}" must be http:// or https://`)
  }
  return raw.replace(/\/+$/, '')
}

/** One OpenAI-compatible chat endpoint the compactor can call. */
export interface LlmEndpoint {
  url: string
  model: string
  apiKey: string
  /** 4xx codes this endpoint returns while overloaded; retried like a 5xx. */
  transientStatuses: number[]
}

/**
 * Ordered fallback endpoints: comma-separated `url|model|KEY_ENV|STATUSES`
 * entries. KEY_ENV names the env var holding that endpoint's API key (leave
 * it empty for a keyless endpoint); naming the variable keeps keys out of
 * this list. STATUSES is that endpoint's own `;`-separated transient 4xx
 * list (e.g. `403;404`), since the same code can mean overload on one
 * provider and a permanent refusal on another. A malformed entry or a named
 * key that is unset exits, like requireEnv.
 */
function fallbackEndpointsEnv(name: string): LlmEndpoint[] {
  const raw = process.env[name]
  if (!raw) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parts = entry.split('|').map((part) => part.trim())
      const [url, model, keyEnv, statuses] = parts
      if (!url || !model || parts.length > 4) {
        fail(`${name}: expected url|model|KEY_ENV|STATUSES, got "${entry}"`)
      }
      const apiKey = keyEnv ? process.env[keyEnv] : ''
      if (apiKey === undefined || (keyEnv && !apiKey)) {
        fail(`${name}: ${keyEnv} (key for ${model}) is not set`)
      }
      return {
        url: httpUrl(url, `${name} (${model})`),
        model,
        apiKey,
        transientStatuses: statuses ? parseStatusList(statuses, ';', `${name} (${model})`) : [],
      }
    })
}

const llmUrl = httpUrl(requireEnv('RIVETOS_COMPACTOR_URL'), 'RIVETOS_COMPACTOR_URL')
const llmModel = requireEnv(
  'RIVETOS_COMPACTOR_MODEL',
  'OpenAI-compatible chat model id for compaction (example: gpt-4o-mini)',
)

export const config = {
  pgUrl: requireEnv('RIVETOS_PG_URL'),
  llmUrl,
  llmModel,
  llmApiKey: process.env.RIVETOS_COMPACTOR_API_KEY ?? '',
  // Extra 4xx codes the *primary* returns while overloaded (free tiers answer
  // 403/404 for a few seconds under load). Retried like a 5xx instead of being
  // recorded as a terminal failure that stalls the level until restart. Each
  // fallback lists its own in RIVETOS_COMPACTOR_FALLBACKS.
  llmTransientStatuses: statusListEnv('RIVETOS_COMPACTOR_TRANSIENT_STATUSES'),
  // Tried in order when the primary fails after its retries (or returns a
  // response the caller rejects, e.g. unparseable wiki JSON). After an outage
  // failover the worker stays on the endpoint that answered for the cooldown,
  // then tries the primary again.
  llmFallbacks: fallbackEndpointsEnv('RIVETOS_COMPACTOR_FALLBACKS'),
  llmFallbackCooldownMs: positiveIntEnv('RIVETOS_COMPACTOR_FALLBACK_COOLDOWN_MINUTES', 15) * 60_000,
  // Per-attempt timeout on an endpoint that has a fallback after it, so a
  // hung endpoint hands over in minutes instead of LLM_TIMEOUT_MS × retries.
  // The last endpoint keeps the full LLM_TIMEOUT_MS.
  llmFallbackAttemptTimeoutMs:
    positiveIntEnv('RIVETOS_COMPACTOR_FALLBACK_ATTEMPT_TIMEOUT_SECONDS', 300) * 1000,

  // Worker-local concurrency
  compactConcurrency: intEnv('COMPACT_CONCURRENCY', 1),

  // Raw WORKER_ROLE. Parsed in main() via parseWorkerRole so an invalid
  // value logs `[CompactWorker] Fatal:` instead of throwing at import
  // (which bypasses main().catch). Default `all` when unset.
  workerRoleEnv: process.env.WORKER_ROLE,

  // Wiki extraction (phase 3c) — dark by default; single writer per design.
  wikiExtraction: process.env.WIKI_EXTRACTION === '1',
  // wikiDir is snapshotted at module load: this worker's env is fixed at process start.
  wikiDir: process.env.WIKI_DIR ?? sharedPath('wiki'),
  wikiBackfillBatch: intEnv('WIKI_BACKFILL_BATCH', 25),

  // Batch sizes (worker-local — library exports only absolute budgets)
  leafBatchSize: intEnv('COMPACT_LEAF_BATCH', 10),
  branchBatchSize: intEnv('COMPACT_BRANCH_BATCH', 8),
  rootBatchSize: intEnv('COMPACT_ROOT_BATCH', 5),

  // Idle session detection
  idleMinutes: intEnv('COMPACT_IDLE_MINUTES', 15),
  minLeavesForBranch: intEnv('COMPACT_MIN_LEAFS', 5),
  minBranchesForRoot: intEnv('COMPACT_MIN_BRANCHES', 3),

  // Stale-partial flush: once a conversation has been idle this long it is
  // treated as final, so its leftover below-floor tail (1..MIN_BATCH_SIZE-1
  // unsummarized messages, which the normal idle sweep skips by design) is
  // flushed into a leaf summary anyway. Default 4 days. staleMinBatch is the
  // floor for that flush — 2, not 1, so lone singleton conversations (already
  // optimally represented as their own embedded message row) don't spawn a
  // near-redundant summary per ping.
  staleMinutes: intEnv('COMPACT_STALE_MINUTES', 4 * 24 * 60),
  staleMinBatch: intEnv('COMPACT_STALE_MIN_BATCH', 2),

  // Tool-synth — optional overrides; otherwise the required compactor URL/model.
  toolSynthEndpoint: process.env.TOOL_SYNTH_ENDPOINT ?? llmUrl,
  toolSynthModel: process.env.TOOL_SYNTH_MODEL ?? llmModel,

  // Backstop sweeps (enqueue-stale-wiki / enqueue-stale-compaction).
  // graphile 0.17 add_jobs already releases the key on a dead conflict, so
  // these ticks mostly re-add *missing* jobs (compaction) and revive the rare
  // still-keyed dead wiki row. Default 20 / 15 min — not 200 / 30 min — so
  // a pile cannot 20× enqueue-idle's 10/5 min rate against the local LLM.
  wikiSweepLimit: intEnv('WIKI_SWEEP_LIMIT', 20),
  compactionSweepLimit: intEnv('COMPACTION_SWEEP_LIMIT', 20),
  // Keyless dead corpses (add_jobs set key=null) older than 7 days. DELETE is
  // cheap; 200/hour drains the 510-row pile without touching keyed identities.
  reapDeadLimit: intEnv('REAP_DEAD_LIMIT', 200),
} as const
