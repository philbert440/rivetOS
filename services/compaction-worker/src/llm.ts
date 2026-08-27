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
import { config } from './config.js'

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

  constructor(
    message: string,
    attempts: number,
    opts: { retryable?: boolean; status?: number } = {},
  ) {
    super(message)
    this.name = 'LlmCallError'
    this.attempts = attempts
    this.retryable = opts.retryable ?? true
    this.status = opts.status
  }
}

function formatAttemptError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Our own AbortController — the endpoint may be fine, just slow.
  if (err instanceof Error && err.name === 'AbortError') {
    return `LLM timed out after ${String(LLM_TIMEOUT_MS)}ms at ${config.llmUrl}`
  }
  // The endpoint answered but the body was not JSON — "unreachable" would
  // send ops chasing the wrong failure class.
  if (err instanceof SyntaxError) {
    return `LLM returned invalid JSON at ${config.llmUrl} (${msg})`
  }
  // undici uses "fetch failed" with the real cause on `error.cause`.
  const rawCause = err instanceof Error ? err.cause : undefined
  const cause =
    rawCause instanceof Error ? rawCause.message : typeof rawCause === 'string' ? rawCause : null
  const detail = cause && !msg.includes(cause) ? `${msg}: ${cause}` : msg
  return `LLM unreachable at ${config.llmUrl} (${detail})`
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
export async function callLlm(
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  opts: { minChars?: number } = {},
): Promise<string> {
  const minChars = opts.minChars ?? 20
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.llmApiKey) {
    headers['Authorization'] = `Bearer ${config.llmApiKey}`
  }

  const body = JSON.stringify({
    model: config.llmModel,
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
      const response = await undiciFetch(`${config.llmUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
        dispatcher: httpDispatcher,
      })

      if (!response.ok && response.status < 500) {
        // 4xx — do not retry inside this call. 408/429 are transient at the
        // job layer; every other 4xx is permanent (bad prompt, auth, missing
        // model) and must not be circuit-broken into an hourly hammer.
        const retryable = response.status === 408 || response.status === 429
        throw new LlmCallError(
          `LLM HTTP ${response.status}: ${response.statusText || 'client error'} (not retrying)`,
          attempt + 1,
          { retryable, status: response.status },
        )
      }

      if (!response.ok) {
        lastError = new Error(
          `LLM HTTP ${response.status}: ${response.statusText || 'server error'}`,
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
      // answer is unusable, and it is a distinct failure from a short answer —
      // log it as its own thing so the next one of these is diagnosable.
      const truncated = choice?.finish_reason === 'length'
      if (truncated || !content || content.trim().length < minChars) {
        lastError = new Error(
          truncated
            ? `LLM response truncated at max_tokens=${String(maxTokens)}`
            : `Empty or too-short LLM response (minChars=${String(minChars)}, got ${content ? content.trim().length : 0})`,
        )
        if (attempt < LLM_RETRIES) {
          const delay = LLM_RETRY_BACKOFF_MS * Math.pow(2, attempt)
          console.error(
            `[CompactWorker] ${truncated ? `LLM truncated at max_tokens=${String(maxTokens)}` : 'LLM empty/short'}, retry ${attempt + 1}/${LLM_RETRIES} in ${delay / 1000}s`,
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

      lastError = new Error(formatAttemptError(err))
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
