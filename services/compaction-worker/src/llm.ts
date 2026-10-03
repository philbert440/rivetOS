/**
 * Hardened LLM call — undici dispatcher with explicit timeouts, retries on
 * 5xx + transient errors (plus each endpoint's listed transient 4xx), no
 * retries on other 4xx, and ordered failover to RIVETOS_COMPACTOR_FALLBACKS.
 *
 * On success returns the response content. On terminal failure throws
 * `LlmCallError` with the *real* last failure reason (network, HTTP status,
 * truncated, empty/short). Callers that previously treated every null as
 * "empty LLM response" were poisoning graphile `last_error` — live extract-wiki
 * dead piles said "empty" while the journal logged "fetch failed".
 *
 * Ported from plugins/memory/postgres/workers/compaction/index.js#callLlm.
 */

import { Agent, fetch as undiciFetch } from 'undici'
import {
  LLM_TIMEOUT_MS,
  LLM_TEMPERATURE,
  LLM_RETRIES,
  LLM_RETRY_BACKOFF_MS,
} from '@rivetos/memory-postgres'
import { config, type LlmEndpoint } from './config.js'

const httpDispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connect: { timeout: 30_000 },
  pipelining: 0,
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Exponential backoff with ±20% jitter, so concurrent calls do not retry in step. */
function backoffMs(attempt: number): number {
  const base = LLM_RETRY_BACKOFF_MS * Math.pow(2, attempt)
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

/** Terminal LLM failure after retries — message is safe for graphile last_error. */
export class LlmCallError extends Error {
  readonly attempts: number
  /**
   * False for a permanent 4xx (not 408/429 or a listed transient code). After
   * a failover cascade, true if any endpoint's failure was. Callers must not
   * circuit-break+retry forever.
   */
  readonly retryable: boolean
  readonly status: number | undefined
  /** The prompt outgrew max_tokens — a smaller batch helps, another endpoint does not. */
  readonly truncated: boolean

  constructor(
    message: string,
    attempts: number,
    opts: { retryable?: boolean; status?: number; truncated?: boolean } = {},
  ) {
    super(message)
    this.name = 'LlmCallError'
    this.attempts = attempts
    this.retryable = opts.retryable ?? true
    this.status = opts.status
    this.truncated = opts.truncated ?? false
  }
}

function formatAttemptError(err: unknown, url: string, timeoutMs: number): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Our own AbortController — the endpoint may be fine, just slow.
  if (err instanceof Error && err.name === 'AbortError') {
    return `LLM timed out after ${String(timeoutMs)}ms at ${url}`
  }
  // The endpoint answered but the body was not JSON — "unreachable" would
  // send ops chasing the wrong failure class.
  if (err instanceof SyntaxError) {
    return `LLM returned invalid JSON at ${url} (${msg})`
  }
  // undici uses "fetch failed" with the real cause on `error.cause`.
  const rawCause = err instanceof Error ? err.cause : undefined
  const cause =
    rawCause instanceof Error ? rawCause.message : typeof rawCause === 'string' ? rawCause : null
  const detail = cause && !msg.includes(cause) ? `${msg}: ${cause}` : msg
  return `LLM unreachable at ${url} (${detail})`
}

/** A response the caller can use, and the model that wrote it. */
export interface LlmResult {
  content: string
  model: string
}

export interface CallLlmOptions {
  minChars?: number
  /**
   * Checks a response before it is returned: null accepts it, a string is the
   * reason to reject it. A rejected response goes to the next fallback
   * endpoint; the last endpoint's response is returned regardless, so the
   * caller's own parser still reports it.
   */
  accept?: (content: string) => string | null
  /**
   * Call this one endpoint only (no primary, no fallbacks). The session tagger
   * uses it so a dedicated classifier host never fails over to the compactor
   * chain, and the compactor chain never receives the tagger's credential.
   */
  endpoint?: LlmEndpoint
  /**
   * Per-attempt timeout override (capped at LLM_TIMEOUT_MS). Best-effort
   * callers such as the tagger pass a short one so a stalled endpoint does not
   * hold a worker slot for the compaction timeout.
   */
  timeoutMs?: number
  /** In-call retries on a transient failure (default LLM_RETRIES). Best-effort callers pass fewer. */
  maxRetries?: number
}

/** Authorization header for an endpoint: minted token wins over the static key. */
export async function authHeadersFor(endpoint: LlmEndpoint): Promise<Record<string, string>> {
  if (endpoint.tokenSource) {
    return { Authorization: `Bearer ${await endpoint.tokenSource.getToken()}` }
  }
  return endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}
}

function primaryEndpoint(): LlmEndpoint {
  return {
    url: config.llmUrl,
    model: config.llmModel,
    apiKey: config.llmApiKey,
    transientStatuses: config.llmTransientStatuses,
  }
}

/**
 * Statuses that are about this request, not the endpoint: a prompt too long
 * for the model's context, a body the server refuses to process. The next
 * endpoint may take it, but later calls should not leave a healthy endpoint.
 */
const REQUEST_SCOPED_STATUSES = new Set([400, 413, 422])

/**
 * Whether a failure says the endpoint itself is unusable right now (network,
 * timeout, 5xx, empty answers, rate limit, auth/billing, missing model, and
 * other non-request-scoped 4xx such as 405/409/415/426) as opposed to this one
 * request being unacceptable to it (400/413/422 only).
 */
function isEndpointFailure(err: unknown): boolean {
  if (!(err instanceof LlmCallError) || err.status === undefined) return true
  return !REQUEST_SCOPED_STATUSES.has(err.status)
}

/**
 * Which endpoint new calls start at; set on an outage failover, cleared after
 * the cooldown. Shared by concurrent calls (compaction, tool-synth, wiki), so
 * a call only moves it forward and only clears the value it saw itself.
 */
let failover: { index: number; until: number } | null = null

/** Test hook: forget any failover so each case starts at the primary. */
export function resetLlmFailover(): void {
  failover = null
}

/**
 * Calls the primary endpoint, then each RIVETOS_COMPACTOR_FALLBACKS endpoint
 * in order until one answers. Truncation is thrown straight back (the caller
 * shrinks the batch); every other failure moves to the next endpoint. Later
 * calls start past the primary only when an endpoint failed as an endpoint
 * (isEndpointFailure): a request-scoped 4xx or a rejected answer moves this
 * call on, not the worker. If a sticky start fails through the rest of the
 * chain, the skipped prefix (including the primary) is tried before giving
 * up. If all fail, the error covers the whole cascade (see cascadeError).
 */
export async function callLlmDetailed(
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  opts: CallLlmOptions = {},
): Promise<LlmResult> {
  const endpoints = opts.endpoint ? [opts.endpoint] : [primaryEndpoint(), ...config.llmFallbacks]
  if (endpoints.length === 1) {
    const content = await callEndpoint(endpoints[0], systemPrompt, userContent, maxTokens, opts)
    return { content, model: endpoints[0].model }
  }

  let start = 0
  // The failover value this call read or wrote; it only clears that one.
  let seen = failover
  if (seen) {
    if (Date.now() < seen.until) {
      start = Math.min(seen.index, endpoints.length - 1)
    } else {
      console.log(`[CompactWorker] failover cooldown over, trying ${endpoints[0].model} again`)
      if (failover === seen) failover = null
      seen = null
    }
  }

  const failures: Array<{ model: string; err: unknown }> = []
  // True while every endpoint tried in this call failed as an endpoint.
  let outage = true

  const tryRange = async (
    from: number,
    toExclusive: number,
    /** When false (skipped-prefix wrap), do not move the sticky index. */
    advanceSticky: boolean,
  ): Promise<LlmResult | null> => {
    for (let i = from; i < toExclusive; i++) {
      const endpoint = endpoints[i]
      // Last in the full chain keeps the long timeout; so does the primary.
      // Middle fallbacks use the shorter attempt timeout so a hang hands over.
      const isChainLast = i === endpoints.length - 1
      const isPrimary = i === 0
      const hasNextInRange = i + 1 < toExclusive
      let content: string
      try {
        content = await callEndpoint(
          endpoint,
          systemPrompt,
          userContent,
          maxTokens,
          opts,
          isPrimary || isChainLast,
        )
      } catch (err) {
        if (err instanceof LlmCallError && err.truncated) throw err
        failures.push({ model: endpoint.model, err })
        const endpointDown = isEndpointFailure(err)
        outage &&= endpointDown
        if (hasNextInRange) {
          const reason = err instanceof Error ? err.message : String(err)
          console.error(
            `[CompactWorker] ${endpoint.model} failed (${reason}); ` +
              `${endpointDown ? 'failing over' : 'trying this request'} on ${endpoints[i + 1].model}`,
          )
          // Advance sticky index on any endpoint-class failure, even when an
          // earlier request-scoped failure already cleared `outage`. A
          // request-scoped failure on this endpoint itself does not advance.
          const current = failover
          const live = current !== null && Date.now() < current.until
          if (advanceSticky && endpointDown && (!live || current.index < i + 1)) {
            failover = { index: i + 1, until: Date.now() + config.llmFallbackCooldownMs }
            seen = failover
          }
        }
        continue
      }

      const rejection = opts.accept?.(content) ?? null
      if (rejection && hasNextInRange) {
        // A bad answer is not an outage: try the next endpoint for this call
        // only, without moving later calls off this one.
        outage = false
        failures.push({ model: endpoint.model, err: new Error(`response rejected: ${rejection}`) })
        console.warn(
          `[CompactWorker] ${endpoint.model} response rejected (${rejection}); trying ${endpoints[i + 1].model}`,
        )
        continue
      }
      return { content, model: endpoint.model }
    }
    return null
  }

  const fromSticky = await tryRange(start, endpoints.length, true)
  if (fromSticky) return fromSticky

  // Sticky start skipped the primary (and any earlier fallbacks). Try them
  // before concluding so a rotated key / exhausted credits on the sticky
  // endpoint cannot mark the level terminal while the primary may be up.
  if (start > 0) {
    console.error(
      `[CompactWorker] sticky endpoints failed; trying skipped prefix starting at ${endpoints[0].model}`,
    )
    const fromPrefix = await tryRange(0, start, false)
    if (fromPrefix) {
      // An earlier endpoint answered: drop the sticky so the next call starts there.
      if (failover === seen) failover = null
      return fromPrefix
    }
  }

  // Everything failed as an endpoint outage: the next call should start at
  // the primary. A request-scoped failure on the last endpoint must not clear
  // an active failover — that would send the next call back to a wedged
  // primary. Another call may have moved the failover meanwhile; leave its
  // value alone.
  if (outage && failover === seen) failover = null
  throw cascadeError(failures)
}

/**
 * One error for a cascade where every endpoint failed. Always aggregates —
 * even a single failure — so a lone sticky-fallback permanent 4xx cannot
 * escape as a raw error that marks the level terminal. Retryable if any
 * endpoint's failure was (including a rejected `accept` answer, which is a
 * plain Error and counts as retryable evidence: the endpoint was up and a
 * retry may parse). The message names each endpoint's failure so
 * `last_error` shows all of them.
 */
function cascadeError(failures: Array<{ model: string; err: unknown }>): unknown {
  const reasons = failures.map(({ model, err }) => {
    const reason = err instanceof Error ? err.message : String(err)
    return `${model}: ${reason}`
  })
  const asLlm = failures.map(({ err }) => (err instanceof LlmCallError ? err : null))
  // Plain Error (e.g. accept rejection) is not an LlmCallError → null →
  // counts as retryable evidence; the serving endpoint was reachable.
  const retryable = asLlm.some((e) => e === null || e.retryable)
  const statuses = new Set(asLlm.map((e) => e?.status))
  const attempts = asLlm.reduce((n, e) => n + (e?.attempts ?? 1), 0)
  return new LlmCallError(
    `all ${String(failures.length)} LLM endpoints failed — ${reasons.join('; ')}`,
    attempts,
    { retryable, status: statuses.size === 1 ? [...statuses][0] : undefined },
  )
}

/** callLlmDetailed without the model name, for callers that do not record it. */
export async function callLlm(
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  opts: CallLlmOptions = {},
): Promise<string> {
  return (await callLlmDetailed(systemPrompt, userContent, maxTokens, opts)).content
}

/**
 * `minChars` guards against thinking-mode models that burn the whole budget on
 * reasoning and return nothing usable. It defaults to 20, which is right for
 * compaction (a 5-char "summary" is garbage) but WRONG for structured-JSON
 * callers: wiki extraction's documented "no durable facts here" answer is the
 * 2-char `[]`, and the default floor scored that valid answer as an empty
 * response — retried 4x, then killed the job. That one constant accounted for
 * ~84% of 23k dead extract-wiki jobs. Structured callers pass minChars: 2.
 */
async function callEndpoint(
  endpoint: LlmEndpoint,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  opts: CallLlmOptions,
  /** True for the primary and for the last endpoint in the chain — both keep LLM_TIMEOUT_MS. */
  fullTimeout = true,
): Promise<string> {
  const minChars = opts.minChars ?? 20
  // Middle fallbacks hand over sooner when they hang. The primary always keeps
  // LLM_TIMEOUT_MS so a slow local model on a large batch is not cut to the
  // fallback attempt timeout just because fallbacks are configured.
  const timeoutMs =
    opts.timeoutMs !== undefined
      ? Math.min(LLM_TIMEOUT_MS, opts.timeoutMs)
      : fullTimeout
        ? LLM_TIMEOUT_MS
        : Math.min(LLM_TIMEOUT_MS, config.llmFallbackAttemptTimeoutMs)
  // A minted token rejected with 401 is invalidated and re-minted once.
  let reminted = false

  const body = JSON.stringify({
    model: endpoint.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: maxTokens,
    temperature: LLM_TEMPERATURE,
  })

  let lastError: Error | null = null
  const retries = Math.max(0, opts.maxRetries ?? LLM_RETRIES)
  const totalAttempts = retries + 1

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs)

    try {
      // Resolved per attempt so a refreshed token is picked up.
      const token = endpoint.tokenSource ? await endpoint.tokenSource.getToken() : endpoint.apiKey
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }
      const response = await undiciFetch(`${endpoint.url}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
        dispatcher: httpDispatcher,
      })

      if (response.status === 401 && endpoint.tokenSource && !reminted) {
        // Short-lived token expired or was revoked: drop it and retry this
        // attempt with a fresh mint, once.
        reminted = true
        endpoint.tokenSource.invalidate(token)
        attempt -= 1
        continue
      }

      const transient4xx = endpoint.transientStatuses.includes(response.status)
      if (!response.ok && response.status < 500 && !transient4xx) {
        // 4xx — do not retry inside this call. 408/429 are transient at the
        // job layer; every other 4xx is permanent (bad prompt, auth, missing
        // model) and must not be circuit-broken into an hourly hammer, unless
        // the endpoint lists it as transient (handled as a 5xx below).
        const retryable = response.status === 408 || response.status === 429
        throw new LlmCallError(
          `LLM HTTP ${response.status}: ${response.statusText || 'client error'} (not retrying)`,
          attempt + 1,
          { retryable, status: response.status },
        )
      }

      if (!response.ok) {
        lastError = new Error(
          `LLM HTTP ${response.status}: ${response.statusText || (transient4xx ? 'client error' : 'server error')}`,
        )
        if (attempt < retries) {
          const delay = backoffMs(attempt)
          console.error(
            `[CompactWorker] ${lastError.message}, retry ${attempt + 1}/${String(retries)} in ${delay / 1000}s`,
          )
          await sleep(delay)
          continue
        }
        break
      }

      const data = (await response.json()) as {
        choices?: Array<{
          finish_reason?: string
          message?: { content?: string; reasoning_content?: string }
        }>
      }
      const choice = data.choices?.[0]
      const message = choice?.message
      const content = message?.content ?? message?.reasoning_content ?? null

      // finish_reason 'length' means the model never got to a stop token: with
      // thinking ON it hits the cap mid-reasoning and content comes back EMPTY,
      // and even when there is content it is truncated mid-JSON. Either way the
      // answer is unusable. The same prompt + same max_tokens will truncate
      // again — do not burn LLM_RETRIES on it. compactLeaf shrinks the batch.
      if (choice?.finish_reason === 'length') {
        throw new LlmCallError(
          `LLM response truncated at max_tokens=${String(maxTokens)}`,
          attempt + 1,
          { truncated: true },
        )
      }
      if (!content || content.trim().length < minChars) {
        lastError = new Error(
          `Empty or too-short LLM response (minChars=${String(minChars)}, got ${content ? content.trim().length : 0})`,
        )
        if (attempt < retries) {
          const delay = backoffMs(attempt)
          console.error(
            `[CompactWorker] LLM empty/short, retry ${attempt + 1}/${String(retries)} in ${delay / 1000}s`,
          )
          await sleep(delay)
          continue
        }
        break
      }

      return content
    } catch (err) {
      // LlmCallError from the 4xx path — rethrow as-is (no further retries).
      if (err instanceof LlmCallError) throw err

      lastError = new Error(formatAttemptError(err, endpoint.url, timeoutMs))
      if (attempt < retries) {
        const delay = backoffMs(attempt)
        console.error(
          `[CompactWorker] LLM error: ${lastError.message}, retry ${attempt + 1}/${String(retries)} in ${delay / 1000}s`,
        )
        await sleep(delay)
        continue
      }
      break
    } finally {
      clearTimeout(timeout)
    }
  }

  const message = lastError?.message ?? 'LLM call failed'
  console.error(`[CompactWorker] LLM call failed after ${totalAttempts} attempts: ${message}`)
  throw new LlmCallError(message, totalAttempts)
}
