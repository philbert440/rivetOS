/**
 * Hardened embedding API client — calls the configured embed endpoint with
 * retry on transient failures, and falls back to per-row isolation when a
 * batch fails so one bad row can't poison the whole batch.
 *
 * Auth: optional static api key or token_command (TTL cache, remint on 401).
 * Wire shape: openai `/v1/embeddings` (default) or native passthrough.
 */

import { buildEmbedRequest, normalizeEmbedVector, parseEmbedResponse } from '@rivetos/token-command'
import { config } from './config.js'

function isTransientError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  if (err instanceof Error && err.name === 'AbortError') return true
  if (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    err.name === 'AbortError'
  )
    return true
  return false
}

/**
 * HTTP statuses the embed endpoint can recover from if we wait.
 *
 * 4xx used to be treated as "not retrying → null vector", which turned
 * rate-limits (429) and timeouts (408) into permanent `Embedding returned
 * null` deaths. 5xx was already retried.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Cap so a huge or far-future Retry-After cannot stall the worker. */
const RETRY_AFTER_MAX_MS = 60_000

/**
 * Backoff before the next attempt. 429 honors Retry-After (delta-seconds or
 * HTTP-date) when present and well-formed; anything else falls back to
 * exponential `2^attempt` seconds.
 */
export function delayForRetry(attempt: number, response?: Response): number {
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

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.tokenSource) {
    const token = await config.tokenSource.getToken()
    headers.Authorization = `Bearer ${token}`
    return headers
  }
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`
  }
  return headers
}

function normalizeBatch(vectors: Array<number[] | null>): Array<number[] | null> {
  return vectors.map((v) =>
    normalizeEmbedVector(v, {
      expectedDims: config.expectedDims,
      truncateDims: config.truncateDims,
    }),
  )
}

async function embedOnce(texts: string[]): Promise<Array<number[] | null> | 'transient'> {
  let lastError: Error | null = null
  const { url, body } = buildEmbedRequest({
    endpoint: config.embedUrl,
    wireShape: config.wireShape,
    model: config.embedModel,
    input: texts,
  })

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const headers = await authHeaders()
      let response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.apiTimeoutMs),
      })

      // Remint once on 401 when using token_command.
      if (response.status === 401 && config.tokenSource) {
        config.tokenSource.invalidate(config.tokenSource.getCachedToken())
        const retryHeaders = await authHeaders()
        response = await fetch(url, {
          method: 'POST',
          headers: retryHeaders,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.apiTimeoutMs),
        })
      }

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`)
        if (isRetryableHttpStatus(response.status) && attempt < config.maxRetries) {
          const delay = delayForRetry(attempt, response)
          console.error(
            `[EmbedWorker] API ${response.status}, retry ${attempt + 1}/${config.maxRetries} in ${delay}ms`,
          )
          await sleep(delay)
          continue
        }
        if (!isRetryableHttpStatus(response.status)) {
          console.error(
            `[EmbedWorker] API ${response.status}: ${response.statusText} (not retrying)`,
          )
          return texts.map(() => null)
        }
        break
      }

      const data: unknown = await response.json()
      const { vectors } = parseEmbedResponse(data, texts.length)
      return normalizeBatch(vectors)
    } catch (err) {
      lastError = err as Error
      if (isTransientError(err) && attempt < config.maxRetries) {
        const delay = Math.pow(2, attempt) * 1000
        console.error(
          `[EmbedWorker] Transient error: ${(err as Error).message}, retry ${attempt + 1}/${config.maxRetries} in ${delay}ms`,
        )
        await sleep(delay)
        continue
      }
      break
    }
  }

  console.error(
    `[EmbedWorker] Batch embed failed after ${config.maxRetries} retries: ${lastError?.message}`,
  )
  return 'transient'
}

/**
 * Embed a batch of texts. Falls back to per-row isolation if the batch
 * call fails after retries — keeps a single bad row from poisoning the rest.
 */
export async function embedBatch(texts: string[]): Promise<Array<number[] | null>> {
  const batchResult = await embedOnce(texts)
  if (batchResult !== 'transient') return batchResult

  console.error('[EmbedWorker] Isolating batch to per-row requests')
  const results: Array<number[] | null> = []
  for (const text of texts) {
    const single = await embedOnce([text])
    if (single === 'transient') {
      results.push(null)
    } else {
      results.push(single[0] ?? null)
    }
  }
  return results
}
