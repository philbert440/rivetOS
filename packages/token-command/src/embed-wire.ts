/**
 * Embeddings wire-shape adapter — OpenAI `/v1/embeddings` or provider-native
 * passthrough. Shared by the embedding worker and memory query-time embed.
 */

export type EmbedWireShape = 'openai' | 'native'

export interface EmbedRequestParts {
  url: string
  body: Record<string, unknown>
}

export interface BuildEmbedRequestOptions {
  /** Endpoint base (may already include a path for native). */
  endpoint: string
  wireShape: EmbedWireShape
  model: string
  /** One or more texts to embed. */
  input: string[]
}

/**
 * Build URL + JSON body for an embed call.
 * - `openai`: `POST <endpoint>/v1/embeddings` with `{ model, input }`
 * - `native`: `POST <endpoint>` with `{ model, texts }` (also accepts servers
 *   that read `input` — we send both `texts` and `input` for native).
 */
export function buildEmbedRequest(opts: BuildEmbedRequestOptions): EmbedRequestParts {
  const base = opts.endpoint.replace(/\/+$/, '')
  if (opts.wireShape === 'native') {
    return {
      url: base,
      body: {
        model: opts.model,
        texts: opts.input,
        input: opts.input,
      },
    }
  }
  return {
    url: `${base}/v1/embeddings`,
    body: {
      model: opts.model,
      input: opts.input,
    },
  }
}

export interface ParsedEmbedResponse {
  /** Parallel to request input; null slots are missing/invalid. */
  vectors: Array<number[] | null>
}

/**
 * Accept OpenAI `{ data: [{ index?, embedding }] }` or native
 * `{ embeddings: number[][] }` / `{ vectors: number[][] }`.
 */
export function parseEmbedResponse(data: unknown, expectedCount: number): ParsedEmbedResponse {
  const vectors: Array<number[] | null> = Array.from({ length: expectedCount }, () => null)
  if (!data || typeof data !== 'object') return { vectors }

  const obj = data as Record<string, unknown>

  if (Array.isArray(obj.data)) {
    for (const item of obj.data) {
      if (!item || typeof item !== 'object') continue
      const row = item as { index?: number; embedding?: unknown }
      const idx = typeof row.index === 'number' ? row.index : 0
      if (idx < 0 || idx >= vectors.length) continue
      if (isFiniteNumberArray(row.embedding)) vectors[idx] = row.embedding
    }
    return { vectors }
  }

  const native = obj.embeddings ?? obj.vectors
  if (Array.isArray(native)) {
    for (let i = 0; i < Math.min(native.length, vectors.length); i++) {
      if (isFiniteNumberArray(native[i])) vectors[i] = native[i] as number[]
    }
  }
  return { vectors }
}

function isFiniteNumberArray(v: unknown): v is number[] {
  return (
    Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

/**
 * Truncate or reject by expected dimension. When `expectedDims` is set and the
 * vector length differs (and is not longer-than-expected for truncate), return
 * null. When longer than expectedDims, slice. When expectedDims unset, optional
 * `truncateDims` still slices long vectors.
 */
export function normalizeEmbedVector(
  vec: number[] | null,
  opts: { expectedDims?: number; truncateDims?: number } = {},
): number[] | null {
  if (!vec) return null
  const { expectedDims, truncateDims } = opts
  if (expectedDims !== undefined) {
    if (vec.length === expectedDims) return vec
    if (vec.length > expectedDims) return vec.slice(0, expectedDims)
    return null
  }
  if (truncateDims !== undefined && vec.length > truncateDims) {
    return vec.slice(0, truncateDims)
  }
  return vec
}

/**
 * Parse a wire-shape config value. Returns the shape when valid (or unset →
 * openai). Returns `{ error }` when the value is present but not recognized.
 */
export function parseEmbedWireShape(raw: unknown): EmbedWireShape | { error: string } {
  if (raw === undefined || raw === null || raw === '') return 'openai'
  if (raw === 'openai' || raw === 'native') return raw
  return { error: 'embed_wire_shape must be "openai" or "native"' }
}
