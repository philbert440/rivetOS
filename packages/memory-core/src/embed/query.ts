/**
 * How a search query is prepared for embedding, and how an embed call is
 * retried — shared so every backend embeds the same query text and treats a
 * struggling endpoint the same way.
 */

/** Qwen3-Embedding query prefix. Documents get nothing. Empty string disables. */
export const DEFAULT_EMBED_QUERY_INSTRUCTION =
  'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: '

/** Longest text sent for one query embedding, instruction included. */
export const EMBED_QUERY_INPUT_MAX = 8_000

export const DEFAULT_EMBED_TIMEOUT_MS = 8_000
export const MIN_EMBED_TIMEOUT_MS = 500
export const MAX_EMBED_TIMEOUT_MS = 60_000

/** Trim and collapse whitespace, so variants of one query share a vector. */
export function normalizeQueryText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

export function applyEmbedQueryInstruction(instruction: string, text: string): string {
  const budget = Math.max(0, EMBED_QUERY_INPUT_MAX - instruction.length)
  const sliced = safeSlice(text, budget)
  if (!instruction) return sliced
  return `${instruction}${sliced}`
}

export function clampEmbedTimeoutMs(raw: unknown): number {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN
  if (!Number.isFinite(n)) return DEFAULT_EMBED_TIMEOUT_MS
  return Math.min(MAX_EMBED_TIMEOUT_MS, Math.max(MIN_EMBED_TIMEOUT_MS, Math.trunc(n)))
}

/**
 * Truncate to at most `maxLen` UTF-16 code units without leaving a lone high
 * surrogate at the end: that serializes to invalid JSON, which some embedding
 * servers reject with HTTP 500.
 */
export function safeSlice(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  let end = maxLen
  const code = s.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1
  }
  return s.slice(0, end)
}

/**
 * HTTP statuses the embed endpoint can recover from if we wait: rate limits
 * and timeouts as well as 5xx.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/** Cap so a huge or far-future Retry-After cannot stall the caller. */
const RETRY_AFTER_MAX_MS = 60_000

/**
 * Backoff before the next attempt. 429 honors Retry-After (delta-seconds or
 * HTTP-date) when present and well-formed; anything else falls back to
 * exponential `2^attempt` seconds.
 */
export function delayForRetry(
  attempt: number,
  response?: { status: number; headers: { get(name: string): string | null } },
): number {
  if (response && response.status === 429) {
    const header = response.headers.get('Retry-After')
    if (header) {
      const seconds = Number(header)
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS)
      }
      const when = Date.parse(header)
      if (Number.isFinite(when)) {
        return Math.min(Math.max(0, when - Date.now()), RETRY_AFTER_MAX_MS)
      }
    }
  }
  return Math.pow(2, attempt) * 1000
}
