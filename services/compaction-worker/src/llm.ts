/**
 * Hardened LLM call — undici dispatcher with explicit timeouts, retries on
 * 5xx + transient errors, no retries on 4xx.
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

/** Terminal LLM failure after retries — message is safe for graphile last_error. */
export class LlmCallError extends Error {
  readonly attempts: number
  /** False for permanent 4xx (except 408/429). Callers must not circuit-break+retry forever. */
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

function formatAttemptError(err: unknown, url: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Our own AbortController — the endpoint may be fine, just slow.
  if (err instanceof Error && err.name === 'AbortError') {
    return `LLM timed out after ${String(LLM_TIMEOUT_MS)}ms at ${url}`
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
}

function primaryEndpoint(): LlmEndpoint {
  return { url: config.llmUrl, model: config.llmModel, apiKey: config.llmApiKey }
}

/** Which endpoint new calls start at; set on failover, cleared after the cooldown. */
let failover: { index: number; until: number } | null = null

/** Test hook: forget any failover so each case starts at the primary. */
export function resetLlmFailover(): void {
  failover = null
}

/**
 * Calls the primary endpoint, then each RIVETOS_COMPACTOR_FALLBACKS endpoint
 * in order until one answers. Truncation is thrown straight back (the caller
 * shrinks the batch); every other failure moves to the next endpoint. If all
 * fail, the error covers the whole cascade (see cascadeError).
 */
export async function callLlmDetailed(
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  opts: CallLlmOptions = {},
): Promise<LlmResult> {
  const endpoints = [primaryEndpoint(), ...config.llmFallbacks]
  if (endpoints.length === 1) {
    const content = await callEndpoint(endpoints[0], systemPrompt, userContent, maxTokens, opts)
    return { content, model: endpoints[0].model }
  }

  let start = 0
  if (failover) {
    if (Date.now() < failover.until) {
      start = failover.index
    } else {
      console.log(`[CompactWorker] failover cooldown over, trying ${endpoints[0].model} again`)
      failover = null
    }
  }

  const failures: Array<{ model: string; err: unknown }> = []
  for (let i = start; i < endpoints.length; i++) {
    const endpoint = endpoints[i]
    const isLast = i === endpoints.length - 1
    let content: string
    try {
      content = await callEndpoint(endpoint, systemPrompt, userContent, maxTokens, opts)
    } catch (err) {
      if (err instanceof LlmCallError && err.truncated) throw err
      failures.push({ model: endpoint.model, err })
      if (!isLast) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(
          `[CompactWorker] ${endpoint.model} failed (${reason}); failing over to ${endpoints[i + 1].model}`,
        )
        failover = { index: i + 1, until: Date.now() + config.llmFallbackCooldownMs }
      }
      continue
    }

    const rejection = opts.accept?.(content) ?? null
    if (rejection && !isLast) {
      // A bad answer is not an outage: try the next endpoint for this call
      // only, without moving later calls off this one.
      console.warn(
        `[CompactWorker] ${endpoint.model} response rejected (${rejection}); trying ${endpoints[i + 1].model}`,
      )
      continue
    }
    return { content, model: endpoint.model }
  }
  // Everything failed: the next call should start at the primary, not stay
  // parked on the last fallback for the whole cooldown.
  failover = null
  throw cascadeError(failures)
}

/**
 * One error for a cascade where every endpoint failed. It is retryable if any
 * endpoint's failure was: a primary outage followed by a revoked key on the
 * last fallback is still an outage, and must not mark the level terminal.
 * The message names each endpoint's failure so `last_error` shows all of
 * them. A single failure is thrown as it was.
 */
function cascadeError(failures: Array<{ model: string; err: unknown }>): unknown {
  if (failures.length === 1) return failures[0].err
  const reasons = failures.map(({ model, err }) => {
    const reason = err instanceof Error ? err.message : String(err)
    return `${model}: ${reason}`
  })
  const asLlm = failures.map(({ err }) => (err instanceof LlmCallError ? err : null))
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
): Promise<string> {
  const minChars = opts.minChars ?? 20
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (endpoint.apiKey) {
    headers['Authorization'] = `Bearer ${endpoint.apiKey}`
  }

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
  const totalAttempts = LLM_RETRIES + 1

  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS)

    try {
      const response = await undiciFetch(`${endpoint.url}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
        dispatcher: httpDispatcher,
      })

      const transient4xx = config.llmTransientStatuses.includes(response.status)
      if (!response.ok && response.status < 500 && !transient4xx) {
        // 4xx — do not retry inside this call. 408/429 are transient at the
        // job layer; every other 4xx is permanent (bad prompt, auth, missing
        // model) and must not be circuit-broken into an hourly hammer, unless
        // RIVETOS_COMPACTOR_TRANSIENT_STATUSES lists it (handled as a 5xx below).
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
        if (attempt < LLM_RETRIES) {
          const delay = LLM_RETRY_BACKOFF_MS * Math.pow(2, attempt)
          console.error(
            `[CompactWorker] ${lastError.message}, retry ${attempt + 1}/${LLM_RETRIES} in ${delay / 1000}s`,
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
        if (attempt < LLM_RETRIES) {
          const delay = LLM_RETRY_BACKOFF_MS * Math.pow(2, attempt)
          console.error(
            `[CompactWorker] LLM empty/short, retry ${attempt + 1}/${LLM_RETRIES} in ${delay / 1000}s`,
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

      lastError = new Error(formatAttemptError(err, endpoint.url))
      if (attempt < LLM_RETRIES) {
        const delay = LLM_RETRY_BACKOFF_MS * Math.pow(2, attempt)
        console.error(
          `[CompactWorker] LLM error: ${lastError.message}, retry ${attempt + 1}/${LLM_RETRIES} in ${delay / 1000}s`,
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
