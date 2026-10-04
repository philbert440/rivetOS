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
import { delayForRetry, isRetryableHttpStatus } from '@rivetos/memory-core'

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

// Retry classification and backoff are shared with the SQLite backend.
export { isRetryableHttpStatus, delayForRetry }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function authHeaders(): Promise<{ headers: Record<string, string>; sentToken?: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.tokenSource) {
    const token = await config.tokenSource.getToken()
    headers.Authorization = `Bearer ${token}`
    return { headers, sentToken: token }
  }
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`
  }
  return { headers }
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
      const { headers, sentToken } = await authHeaders()
      let response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.apiTimeoutMs),
      })

      // Remint once on 401 when using token_command. Pass the token actually
      // sent — getCachedToken() can already be a newer mint from another caller.
      if (response.status === 401 && config.tokenSource && sentToken !== undefined) {
        config.tokenSource.invalidate(sentToken)
        const retry = await authHeaders()
        response = await fetch(url, {
          method: 'POST',
          headers: retry.headers,
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
