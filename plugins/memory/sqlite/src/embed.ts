/**
 * Embedding client for the SQLite backend. Same endpoint contract as the
 * Postgres embedding worker and its query-time embed: an OpenAI-compatible or
 * provider-native endpoint, a static key or a token command, and the same
 * text composition, chunking and pooling (from @rivetos/memory-core).
 */

import {
  DEFAULT_EMBED_QUERY_INSTRUCTION,
  DEFAULT_EMBED_TIMEOUT_MS,
  applyEmbedQueryInstruction,
  classifyUnembeddable,
  composeMessageEmbedText,
  delayForRetry,
  isRetryableHttpStatus,
  meanPool,
  normalizeQueryText,
  splitIntoChunksWithOffsets,
} from '@rivetos/memory-core'
import {
  buildEmbedRequest,
  normalizeEmbedVector,
  parseEmbedResponse,
  type EmbedWireShape,
  type TokenSource,
} from '@rivetos/token-command'

export interface EmbedConfig {
  endpoint: string
  model: string
  apiKey?: string
  /** Wins over `apiKey`. A rejected token (401) is re-minted once. */
  tokenSource?: TokenSource
  wireShape?: EmbedWireShape
  /** Require exactly this width; a different one is treated as a failure. */
  expectedDims?: number
  /** Keep the first N dimensions of a longer vector. Default 1024. */
  truncateDims?: number
  timeoutMs?: number
  /** Characters per chunk for long text. Default 6000. */
  charsPerChunk?: number
  /**
   * Prefix for search queries. Default: the same instruction the Postgres
   * backend uses, so both embed a query identically. Empty string disables.
   */
  queryInstruction?: string
  /** In-call retries on 408/425/429/5xx. Default 2. */
  maxRetries?: number
  /** For tests: replaces the wait between retries. */
  sleep?: (ms: number) => Promise<void>
  /** For tests. */
  fetch?: typeof globalThis.fetch
}

export { DEFAULT_EMBED_TIMEOUT_MS }
export const DEFAULT_TRUNCATE_DIMS = 1024
export const DEFAULT_CHARS_PER_CHUNK = 6_000
const QUERY_CACHE_MAX = 256
const QUERY_CACHE_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_RETRIES = 2
/** In-call waits are short: the job queue owns the long backoff. */
const RETRY_WAIT_MAX_MS = 10_000

export type EmbedOutcome =
  | { kind: 'vector'; vector: number[] }
  /** Nothing worth embedding (empty, base64 blob, …). Permanent. */
  | { kind: 'unembeddable'; reason: string }

export class EmbedClient {
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly cache = new Map<string, { at: number; vector: number[] }>()

  constructor(
    private readonly config: EmbedConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.fetchImpl = config.fetch ?? globalThis.fetch
  }

  get model(): string {
    return this.config.model
  }

  /** One vector per input, in order. Throws when any is missing or malformed. */
  async embed(texts: string[]): Promise<number[][]> {
    const vectors = await this.embedLenient(texts)
    return vectors.map((vec, i) => {
      if (!vec) throw new Error(`embedding ${String(i)} missing or of an unexpected width`)
      return vec
    })
  }

  /**
   * One slot per input, `null` where the endpoint returned nothing usable for
   * that item. Throws only when the request itself fails after its retries.
   */
  async embedLenient(texts: string[]): Promise<Array<number[] | null>> {
    if (texts.length === 0) return []
    const { url, body } = buildEmbedRequest({
      endpoint: this.config.endpoint,
      wireShape: this.config.wireShape ?? 'openai',
      model: this.config.model,
      input: texts,
    })
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES
    const sleep =
      this.config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    let reminted = false
    let lastError = 'embed request failed'
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      const token = this.config.tokenSource
        ? await this.config.tokenSource.getToken()
        : (this.config.apiKey ?? '')
      if (token) headers.authorization = `Bearer ${token}`
      const ctrl = new AbortController()
      const timer = setTimeout(() => {
        ctrl.abort()
      }, this.config.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS)
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
        if (res.status === 401 && this.config.tokenSource && !reminted) {
          // An expired or revoked token: drop it and retry this attempt once.
          reminted = true
          this.config.tokenSource.invalidate(token)
          await res.body?.cancel().catch(() => {})
          attempt -= 1
          continue
        }
        if (!res.ok) {
          lastError = `embed HTTP ${String(res.status)}`
          await res.body?.cancel().catch(() => {})
          if (isRetryableHttpStatus(res.status) && attempt < maxRetries) {
            await sleep(Math.min(delayForRetry(attempt, res), RETRY_WAIT_MAX_MS))
            continue
          }
          throw new Error(lastError)
        }
        const parsed = parseEmbedResponse(await res.json(), texts.length)
        return parsed.vectors.map((raw) =>
          normalizeEmbedVector(raw, {
            expectedDims: this.config.expectedDims,
            truncateDims: this.config.truncateDims ?? DEFAULT_TRUNCATE_DIMS,
          }),
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // A timeout or connection error is retried like a 5xx.
        const transport = !msg.startsWith('embed HTTP ')
        if (transport && attempt < maxRetries) {
          lastError = msg
          await sleep(Math.min(delayForRetry(attempt), RETRY_WAIT_MAX_MS))
          continue
        }
        throw err instanceof Error ? err : new Error(msg)
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error(lastError)
  }

  /**
   * Embed a search query: normalized, prefixed with the instruction, and
   * cached — the same preparation the Postgres backend applies.
   */
  async embedQuery(query: string): Promise<number[]> {
    const instruction = this.config.queryInstruction ?? DEFAULT_EMBED_QUERY_INSTRUCTION
    const text = applyEmbedQueryInstruction(instruction, normalizeQueryText(query))
    const hit = this.cache.get(text)
    if (hit && this.now() - hit.at < QUERY_CACHE_TTL_MS) {
      // Refresh recency.
      this.cache.delete(text)
      this.cache.set(text, hit)
      return hit.vector
    }
    const [vector] = await this.embed([text])
    this.cache.set(text, { at: this.now(), vector })
    if (this.cache.size > QUERY_CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    return vector
  }

  /**
   * Embed one message the way the Postgres worker does: content plus a capped
   * tool result, long text split into chunks and mean-pooled into one vector.
   * A chunk the endpoint could not embed is left out of the pool; only when
   * no chunk came back does the message fail.
   */
  async embedMessage(content: string | null, toolResult: string | null): Promise<EmbedOutcome> {
    const text = composeMessageEmbedText(content, toolResult)
    if (!text) return { kind: 'unembeddable', reason: 'empty' }
    const reason = classifyUnembeddable(text)
    if (reason) return { kind: 'unembeddable', reason }
    const chunks = splitIntoChunksWithOffsets(
      text,
      this.config.charsPerChunk ?? DEFAULT_CHARS_PER_CHUNK,
    )
    const vectors = await this.embedLenient(chunks.map((c) => c.text))
    const pooled = meanPool(vectors)
    if (!pooled) throw new Error('embedding returned no usable vector')
    return { kind: 'vector', vector: pooled }
  }
}
