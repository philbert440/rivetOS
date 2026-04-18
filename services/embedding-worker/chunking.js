/**
 * Chunking + mean-pooling helpers for oversized embedding content.
 *
 * Ported from plugins/memory/postgres/src/embedder.ts so the worker can
 * handle rows whose content exceeds a single embedding call's ceiling.
 * The worker splits oversized content into chunks, embeds each chunk,
 * and mean-pools the vectors into a single vector per row.
 */

/**
 * Split text into approximately equal-sized chunks no larger than maxChars.
 * Prefers paragraph/line/sentence boundaries near the target size to keep
 * chunks semantically coherent. Falls back to a hard character split when
 * no boundary is close enough.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
export function splitIntoChunks(text, maxChars) {
  if (text.length <= maxChars) return [text]

  const chunks = []
  let cursor = 0

  while (cursor < text.length) {
    const remaining = text.length - cursor
    if (remaining <= maxChars) {
      chunks.push(text.slice(cursor))
      break
    }

    // Search window: last 15% of the chunk. Look for a good break point
    // (paragraph break > line break > sentence end) working backward.
    const windowStart = cursor + Math.floor(maxChars * 0.85)
    const hardEnd = cursor + maxChars

    const candidates = [
      text.lastIndexOf('\n\n', hardEnd),
      text.lastIndexOf('\n', hardEnd),
      text.lastIndexOf('. ', hardEnd),
    ]

    let breakAt = -1
    for (const c of candidates) {
      if (c >= windowStart && c < hardEnd) {
        breakAt = c
        break
      }
    }

    const end = breakAt === -1 ? hardEnd : breakAt
    chunks.push(text.slice(cursor, end))
    cursor = end
  }

  return chunks
}

/**
 * Mean-pool a batch of embedding vectors into a single vector.
 * Returns null if no vectors succeeded. Nulls in the input are skipped,
 * so a partial batch failure still produces a usable pooled vector.
 * Defensively skips vectors with a different dimension than the first valid one.
 *
 * @param {(number[] | null)[]} vectors
 * @returns {number[] | null}
 */
export function meanPool(vectors) {
  const valid = vectors.filter((v) => v !== null && v !== undefined)
  if (valid.length === 0) return null

  const dim = valid[0].length
  const sum = new Array(dim).fill(0)
  let n = 0

  for (const vec of valid) {
    if (vec.length !== dim) continue // defensive: skip mis-sized
    for (let i = 0; i < dim; i++) sum[i] += vec[i]
    n++
  }

  if (n === 0) return null
  for (let i = 0; i < dim; i++) sum[i] /= n
  return sum
}
