/**
 * Chat-completions client for the SQLite backend's background work
 * (summaries today; wiki extraction and tagging later). One OpenAI-compatible
 * endpoint, the same request the Postgres compaction worker sends, and the
 * same failure classes: a truncated answer is its own error (the caller
 * shrinks the batch), a permanent 4xx is not retried, anything else retries a
 * few times inside the call and then fails the job, which backs off.
 */

import { LLM_TEMPERATURE, delayForRetry } from '@rivetos/memory-core'
import type { TokenSource } from '@rivetos/token-command'

export interface LlmConfig {
  /** Base URL of an OpenAI-compatible API (`…/v1`). */
  endpoint: string
  model: string
  apiKey?: string
  /** Wins over `apiKey`. A rejected token (401) is re-minted once. */
  tokenSource?: TokenSource
  /** Per-request timeout. Default 10 minutes: local models summarizing a batch are slow. */
  timeoutMs?: number
  /** In-call retries on 408/429/5xx, transport errors and empty answers. Default 2. */
  maxRetries?: number
  /** For tests. */
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_LLM_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_RETRIES = 2
const RETRY_WAIT_MAX_MS = 30_000

/** The answer hit the output budget. Message matches `isLlmTruncationError`. */
export class LlmTruncatedError extends Error {
  constructor(maxTokens: number) {
    super(`LLM response truncated at max_tokens=${String(maxTokens)}`)
    this.name = 'LlmTruncatedError'
  }
}

/** A request the endpoint will keep refusing (bad prompt, auth, unknown model). */
export class LlmPermanentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'LlmPermanentError'
  }
}

export interface LlmAnswer {
  content: string
  model: string
}

export class LlmClient {
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(private readonly config: LlmConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch
  }

  get model(): string {
    return this.config.model
  }

  /**
   * One system + user exchange. `minChars` guards against a thinking model
   * that spends its budget reasoning and returns nothing usable; structured
   * callers whose valid answer can be `[]` pass 2.
   */
  async chat(
    systemPrompt: string,
    userContent: string,
    maxTokens: number,
    opts: { minChars?: number } = {},
  ): Promise<LlmAnswer> {
    const minChars = opts.minChars ?? 20
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES
    const sleep =
      this.config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const url = `${this.config.endpoint.replace(/\/+$/, '')}/chat/completions`
    const body = JSON.stringify({
      model: this.config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: LLM_TEMPERATURE,
    })
    let reminted = false
    let lastError = 'LLM call failed'
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      const token = this.config.tokenSource
        ? await this.config.tokenSource.getToken()
        : (this.config.apiKey ?? '')
      if (token) headers.authorization = `Bearer ${token}`
      const ctrl = new AbortController()
      const timer = setTimeout(() => {
        ctrl.abort()
      }, this.config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS)
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          signal: ctrl.signal,
        })
        if (res.status === 401 && this.config.tokenSource && !reminted) {
          reminted = true
          this.config.tokenSource.invalidate(token)
          await res.body?.cancel().catch(() => {})
          attempt -= 1
          continue
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {})
          const transient = res.status === 408 || res.status === 429 || res.status >= 500
          if (!transient) {
            throw new LlmPermanentError(`LLM HTTP ${String(res.status)} (not retrying)`, res.status)
          }
          lastError = `LLM HTTP ${String(res.status)}`
          if (attempt < maxRetries) {
            await sleep(Math.min(delayForRetry(attempt, res), RETRY_WAIT_MAX_MS))
            continue
          }
          break
        }
        const data = (await res.json()) as {
          choices?: Array<{
            finish_reason?: string
            message?: { content?: string | null; reasoning_content?: string | null }
          }>
        }
        const choice = data.choices?.[0]
        const content = choice?.message?.content ?? choice?.message?.reasoning_content ?? null
        // Same prompt, same budget: it would truncate again. Not retried here.
        if (choice?.finish_reason === 'length') throw new LlmTruncatedError(maxTokens)
        if (!content || content.trim().length < minChars) {
          lastError = `Empty or too-short LLM response (minChars=${String(minChars)}, got ${String(content ? content.trim().length : 0)})`
          if (attempt < maxRetries) {
            await sleep(Math.min(delayForRetry(attempt), RETRY_WAIT_MAX_MS))
            continue
          }
          break
        }
        return { content, model: this.config.model }
      } catch (err) {
        if (err instanceof LlmTruncatedError || err instanceof LlmPermanentError) throw err
        lastError = err instanceof Error ? err.message : String(err)
        if (attempt < maxRetries) {
          await sleep(Math.min(delayForRetry(attempt), RETRY_WAIT_MAX_MS))
          continue
        }
        break
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error(lastError)
  }
}
