/**
 * Chunking + mean-pooling helpers for oversized embedding content.
 *
 * The worker splits oversized content into chunks, embeds each chunk,
 * and mean-pools the vectors into a single vector per row. Long messages
 * also persist the chunks (with offsets) on ros_message_chunks.
 *
 * Offsets (charStart / charEnd) index the composed embed text, not
 * ros_messages.content.
 */

export interface TextChunk {
  text: string
  charStart: number
  charEnd: number
}

export function splitIntoChunksWithOffsets(text: string, maxChars: number): TextChunk[] {
  if (text.length <= maxChars) return [{ text, charStart: 0, charEnd: text.length }]

  const chunks: TextChunk[] = []
  let cursor = 0

  while (cursor < text.length) {
    const remaining = text.length - cursor
    if (remaining <= maxChars) {
      chunks.push({ text: text.slice(cursor), charStart: cursor, charEnd: text.length })
      break
    }

    const windowStart = cursor + Math.floor(maxChars * 0.85)
    // Surrogate-safe hard end (same back-off as safe-slice.ts) without copying
    // the tail each iteration. A persisted chunk that ends mid-pair is a
    // permanently dead embed job.
    let hardEnd = cursor + maxChars
    const cut = text.charCodeAt(hardEnd - 1)
    if (cut >= 0xd800 && cut <= 0xdbff) {
      hardEnd -= 1
    }
    if (hardEnd <= cursor) {
      const first = text.charCodeAt(cursor)
      const pair = first >= 0xd800 && first <= 0xdbff ? 2 : 1
      hardEnd = Math.min(cursor + pair, text.length)
    }

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
    chunks.push({ text: text.slice(cursor, end), charStart: cursor, charEnd: end })
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
