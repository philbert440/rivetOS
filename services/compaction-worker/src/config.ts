/**
 * Environment-driven configuration for the compaction worker.
 */

import { sharedPath } from '@rivetos/types'
import { createTokenSource, parseTokenCommandArgv, type TokenSource } from '@rivetos/token-command'

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
 * Statuses that are request-scoped or otherwise permanent for failover
 * purposes. Listing them as "transient" retries them like a 5xx and, once
 * exhausted, treats the undefined-status failure as an endpoint outage that
 * can park the worker on a fallback — the opposite of the request-scoped
 * contract. Warn so operators notice.
 */
const TRANSIENT_WARN_STATUSES = new Set([400, 401, 413, 422])

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
      if (TRANSIENT_WARN_STATUSES.has(code)) {
        console.warn(
          `[CompactWorker] ${where}: ${String(code)} is request-scoped or auth/billing; ` +
            `listing it as transient retries it like a 5xx and can sticky-failover after exhaustion`,
        )
      }
      return code
    })
}

function statusListEnv(name: string, env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env[name]
  return raw ? parseStatusList(raw, ',', name) : []
}

function positiveIntEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name]
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
  /** Static bearer. Ignored when `tokenSource` is set. */
  apiKey: string
  /** Minted bearer (token_command), re-read per call so a refresh is picked up. */
  tokenSource?: TokenSource
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

/**
 * Session tagger (suggest-tags task). Same shape as the embed service:
 * endpoint + model + static key or token_command + wire shape. Unset, the
 * compactor model tags with the built-in prompt, so every node that
 * summarizes also tags. The static key falls back to the compactor's only
 * when the URL did too — never send the compactor credential to a different
 * host. SESSION_TAGGING=0 turns the task into a no-op.
 */
function resolveTaggerTokenSource(env: NodeJS.ProcessEnv): TokenSource | undefined {
  const raw = env.RIVETOS_TAGGER_TOKEN_COMMAND
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('RIVETOS_TAGGER_TOKEN_COMMAND must be a JSON argv array (no shell string)')
  }
  const argv = parseTokenCommandArgv(parsed)
  if (argv === null) return undefined
  if (typeof argv === 'string') fail(argv)
  const ttlMs = intEnv('RIVETOS_TAGGER_TOKEN_TTL_MS', 0)
  const timeoutMs = intEnv('RIVETOS_TAGGER_TOKEN_COMMAND_TIMEOUT_MS', 0)
  return createTokenSource({
    argv,
    ttlMs: ttlMs > 0 ? ttlMs : undefined,
    timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
  })
}

function resolveTaggerWireShape(raw: string | undefined): 'openai' | 'native' {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === '' || v === 'openai') return 'openai'
  if (v === 'native') return 'native'
  return fail(`RIVETOS_TAGGER_WIRE_SHAPE must be "openai" or "native" (got ${JSON.stringify(raw)})`)
}

const taggingEnabled = !/^(0|false|no|off)$/i.test((process.env.SESSION_TAGGING ?? '').trim())
// A disabled tagger reads none of its settings: leftovers in a template
// (a malformed token command, native wire shape without a URL) must not stop
// the worker from starting. It resolves to the compactor defaults, unused.
const taggerEnv: NodeJS.ProcessEnv = taggingEnabled ? process.env : {}
const taggerUrlRaw = taggerEnv.RIVETOS_TAGGER_URL?.trim() ?? ''
const taggerUsesCompactor = taggerUrlRaw === ''
const taggerUrl = taggerUsesCompactor ? llmUrl : httpUrl(taggerUrlRaw, 'RIVETOS_TAGGER_URL')
const taggerModel = taggerEnv.RIVETOS_TAGGER_MODEL?.trim() || llmModel
// A set-but-empty key (the shape .env.example shows) counts as unset.
const taggerKeyRaw = taggerEnv.RIVETOS_TAGGER_API_KEY?.trim() ?? ''
const taggerApiKey =
  taggerKeyRaw !== ''
    ? taggerKeyRaw
    : taggerUsesCompactor
      ? (process.env.RIVETOS_COMPACTOR_API_KEY ?? '')
      : ''
const taggerTokenSource = resolveTaggerTokenSource(taggerEnv)
const taggerWireShape = resolveTaggerWireShape(taggerEnv.RIVETOS_TAGGER_WIRE_SHAPE)
// Isolation runs both ways: a tagger credential without a tagger URL would be
// sent to the compactor endpoint. Refuse it instead of defaulting silently.
if (taggerUsesCompactor && (taggerKeyRaw !== '' || taggerTokenSource !== undefined)) {
  fail('RIVETOS_TAGGER_API_KEY / RIVETOS_TAGGER_TOKEN_COMMAND require RIVETOS_TAGGER_URL')
}
if (taggerWireShape === 'native' && taggerUsesCompactor) {
  fail('RIVETOS_TAGGER_WIRE_SHAPE=native requires RIVETOS_TAGGER_URL')
}

export const config = {
  pgUrl: requireEnv('RIVETOS_PG_URL'),
  /**
   * When true, suggest-tags may propose removing a tag a person added or
   * accepted. Default off. Does not turn capture on or off.
   */
  taggerAllowProtectedRemovals: /^(1|true|yes|on)$/i.test(
    (taggerEnv.RIVETOS_TAGGER_ALLOW_PROTECTED_REMOVALS ?? '').trim(),
  ),
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
  // Per-attempt timeout on a *middle* fallback (not the primary, not the last
  // endpoint), so a hung paid fallback hands over in minutes instead of
  // LLM_TIMEOUT_MS × retries. The primary and the last endpoint keep the full
  // LLM_TIMEOUT_MS — configuring fallbacks must not cut a slow local primary.
  llmFallbackAttemptTimeoutMs:
    positiveIntEnv('RIVETOS_COMPACTOR_FALLBACK_ATTEMPT_TIMEOUT_SECONDS', 300) * 1000,

  // Session tagger — see resolveTagger* above. An LlmEndpoint so the same
  // callEndpoint path (retries, transient statuses, auth) serves it.
  taggingEnabled,
  // Per-attempt timeout for a tagger call. Deliberately short: tagging is
  // best-effort and shares the worker's slots with compaction, so a stalled
  // tagger must hand the slot back in a minute, not after LLM_TIMEOUT_MS.
  taggerTimeoutMs: positiveIntEnv('RIVETOS_TAGGER_TIMEOUT_SECONDS', 60, taggerEnv) * 1000,
  tagger: {
    url: taggerUrl,
    model: taggerModel,
    apiKey: taggerApiKey,
    transientStatuses: statusListEnv('RIVETOS_TAGGER_TRANSIENT_STATUSES', taggerEnv),
    ...(taggerTokenSource ? { tokenSource: taggerTokenSource } : {}),
  } satisfies LlmEndpoint,
  taggerWireShape,
  /** True when no RIVETOS_TAGGER_URL was given and the compactor is doing the tagging. */
  taggerUsesCompactor,

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
