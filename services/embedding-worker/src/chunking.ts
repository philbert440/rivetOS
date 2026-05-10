/**
 * Chunking + mean-pooling helpers for oversized embedding content.
 *
 * The worker splits oversized content into chunks, embeds each chunk,
 * and mean-pools the vectors into a single vector per row.
 */

export function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]

  const chunks: string[] = []
  let cursor = 0

  while (cursor < text.length) {
    const remaining = text.length - cursor
    if (remaining <= maxChars) {
      chunks.push(text.slice(cursor))
      break
    }

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
 */
export function meanPool(vectors: Array<number[] | null>): number[] | null {
  const valid = vectors.filter((v): v is number[] => v !== null && v !== undefined)
  if (valid.length === 0) return null

  const dim = valid[0].length
  const sum = new Array<number>(dim).fill(0)
  let n = 0

  for (const vec of valid) {
    if (vec.length !== dim) continue
    for (let i = 0; i < dim; i++) sum[i] += vec[i]
    n++
  }

  if (n === 0) return null
  for (let i = 0; i < dim; i++) sum[i] /= n
  return sum
}
