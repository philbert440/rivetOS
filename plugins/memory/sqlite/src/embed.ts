/**
 * Embedding client for the SQLite backend. Same endpoint contract as the
 * Postgres embedding worker and its query-time embed: an OpenAI-compatible or
 * provider-native endpoint, a static key or a token command, and the same
 * text composition, chunking and pooling (from @rivetos/memory-core).
 */

import {
  classifyUnembeddable,
  composeMessageEmbedText,
  meanPool,
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
  /** Prefix for search queries, for models that want an instruction. */
  queryInstruction?: string
  /** For tests. */
  fetch?: typeof globalThis.fetch
}

export const DEFAULT_EMBED_TIMEOUT_MS = 8_000
export const DEFAULT_TRUNCATE_DIMS = 1024
export const DEFAULT_CHARS_PER_CHUNK = 6_000
const QUERY_CACHE_MAX = 256
const QUERY_CACHE_TTL_MS = 10 * 60 * 1000
const QUERY_INPUT_MAX = 8_000

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

  /** One vector per input, in order. Throws on a transport or shape failure. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const { url, body } = buildEmbedRequest({
      endpoint: this.config.endpoint,
      wireShape: this.config.wireShape ?? 'openai',
      model: this.config.model,
      input: texts,
    })
    let lastStatus = 0
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
        lastStatus = res.status
        if (res.status === 401 && this.config.tokenSource && attempt === 0) {
          this.config.tokenSource.invalidate(token)
          await res.body?.cancel().catch(() => {})
          continue
        }
        if (!res.ok) throw new Error(`embed HTTP ${String(res.status)}`)
        const parsed = parseEmbedResponse(await res.json(), texts.length)
        return parsed.vectors.map((raw, i) => {
          const vec = normalizeEmbedVector(raw, {
            expectedDims: this.config.expectedDims,
            truncateDims: this.config.truncateDims ?? DEFAULT_TRUNCATE_DIMS,
          })
          if (!vec) {
            throw new Error(
              raw
                ? `embedding ${String(i)} has ${String(raw.length)} dimensions, expected ${String(this.config.expectedDims)}`
                : `embedding ${String(i)} missing from the response`,
            )
          }
          return vec
        })
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error(`embed HTTP ${String(lastStatus)}`)
  }

  /** Embed a search query, with the configured instruction and a small cache. */
  async embedQuery(query: string): Promise<number[]> {
    const text = `${this.config.queryInstruction ?? ''}${query}`.slice(0, QUERY_INPUT_MAX)
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
    const vectors = await this.embed(chunks.map((c) => c.text))
    const pooled = vectors.length === 1 ? vectors[0] : meanPool(vectors)
    if (!pooled) throw new Error('embedding returned no vector')
    return { kind: 'vector', vector: pooled }
  }
}
