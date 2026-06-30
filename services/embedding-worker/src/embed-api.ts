/**
 * Hardened embedding API client — calls Nemotron's OpenAI-compatible
 * /v1/embeddings endpoint with retry on transient failures, and falls back
 * to per-row isolation when a batch fails so one bad row can't poison the
 * whole batch.
 */

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>
}

async function embedOnce(texts: string[]): Promise<Array<number[] | null> | 'transient'> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(`${config.embedUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts, model: config.embedModel }),
        signal: AbortSignal.timeout(config.apiTimeoutMs),
      })

      if (!response.ok && response.status < 500) {
        console.error(`[EmbedWorker] API ${response.status}: ${response.statusText} (not retrying)`)
        return texts.map(() => null)
      }

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`)
        if (attempt < config.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000
          console.error(
            `[EmbedWorker] API ${response.status}, retry ${attempt + 1}/${config.maxRetries} in ${delay}ms`,
          )
          await sleep(delay)
          continue
        }
        break
      }

      const data = (await response.json()) as EmbeddingResponse
      if (!data.data) return texts.map(() => null)

      const results: Array<number[] | null> = texts.map(() => null)
      for (const item of data.data) {
        const idx = item.index ?? 0
        if (idx >= 0 && idx < results.length && item.embedding) {
          results[idx] = item.embedding
        }
      }
      return results
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
