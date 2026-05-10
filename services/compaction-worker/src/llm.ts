/**
 * Hardened LLM call — undici dispatcher with explicit timeouts, retries on
 * 5xx + transient errors, no retries on 4xx.
 *
 * Returns the LLM response content, or null if the call failed after retries.
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

export async function callLlm(
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<string | null> {
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
        console.error(
          `[CompactWorker] LLM ${response.status}: ${response.statusText} (not retrying)`,
        )
        return null
      }

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`)
        if (attempt < LLM_RETRIES) {
          const delay = LLM_RETRY_BACKOFF_MS * Math.pow(2, attempt)
          console.error(
            `[CompactWorker] LLM ${response.status}, retry ${attempt + 1}/${LLM_RETRIES} in ${delay / 1000}s`,
          )
          await sleep(delay)
          continue
        }
        break
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
      }
      const message = data.choices?.[0]?.message
      const content = message?.content ?? message?.reasoning_content ?? null

      if (!content || content.trim().length < 20) {
        lastError = new Error('Empty or too-short LLM response')
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
      lastError = err as Error
      if (attempt < LLM_RETRIES) {
        const delay = LLM_RETRY_BACKOFF_MS * Math.pow(2, attempt)
        console.error(
          `[CompactWorker] LLM error: ${(err as Error).message}, retry ${attempt + 1}/${LLM_RETRIES} in ${delay / 1000}s`,
        )
        await sleep(delay)
        continue
      }
      break
    } finally {
      clearTimeout(timeout)
    }
  }

  console.error(
    `[CompactWorker] LLM call failed after ${LLM_RETRIES + 1} attempts: ${lastError?.message}`,
  )
  return null
}
