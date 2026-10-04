/**
 * Vector storage and search for the SQLite backend.
 *
 * An embedding is stored on its row as a BLOB of little-endian float32,
 * L2-normalized at write time, so cosine similarity is a dot product. Search
 * goes through the `VectorIndex` interface; the implementation here is an
 * exact scan over an in-memory matrix. At single-machine scale (hundreds of
 * thousands of rows) that is a few tens of milliseconds, needs no native
 * extension, and is exact. An approximate index can replace it behind the
 * same interface if a store outgrows it.
 */

import type { DatabaseSync } from 'node:sqlite'

/** L2-normalize and encode. Returns null for an empty or zero vector. */
export function encodeVector(vector: readonly number[] | Float32Array): Uint8Array | null {
  const n = vector.length
  if (n === 0) return null
  let norm = 0
  for (let i = 0; i < n; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (!Number.isFinite(norm) || norm === 0) return null
  const buf = new ArrayBuffer(n * 4)
  const view = new DataView(buf)
  for (let i = 0; i < n; i += 1) view.setFloat32(i * 4, vector[i] / norm, true)
  return new Uint8Array(buf)
}

export function decodeVector(blob: Uint8Array): Float32Array {
  const n = Math.floor(blob.byteLength / 4)
  const out = new Float32Array(n)
  const view = new DataView(blob.buffer, blob.byteOffset, n * 4)
  for (let i = 0; i < n; i += 1) out[i] = view.getFloat32(i * 4, true)
  return out
}

export interface VectorHit {
  id: string
  /** Cosine similarity, -1..1. */
  score: number
}

export interface VectorFilter {
  agent?: string
}

export interface VectorIndex {
  /** The `k` nearest stored vectors to `query`, best first. */
  search(query: readonly number[] | Float32Array, k: number, filter?: VectorFilter): VectorHit[]
  /** Call after embeddings were written or removed. */
  invalidate(): void
  /** Stored vectors, for stats. */
  size(): number
}

interface Loaded {
  ids: string[]
  agents: string[]
  dims: number
  matrix: Float32Array
}

/**
 * Exact cosine scan over the embeddings of one table. The matrix is loaded
 * once and kept until `invalidate()`; rows whose width differs from the first
 * row's (a model change mid-store) are skipped rather than compared.
 */
export class ExactScanIndex implements VectorIndex {
  private loaded: Loaded | undefined

  constructor(
    private readonly db: DatabaseSync,
    /** Table with `id`, `agent`, `embedding` columns. */
    private readonly table: 'ros_messages' = 'ros_messages',
    /** Extra SQL predicate over alias `m` choosing which rows are searchable. */
    private readonly where = '1 = 1',
  ) {}

  invalidate(): void {
    this.loaded = undefined
  }

  size(): number {
    return this.load().ids.length
  }

  search(
    query: readonly number[] | Float32Array,
    k: number,
    filter: VectorFilter = {},
  ): VectorHit[] {
    const data = this.load()
    if (data.ids.length === 0 || k <= 0) return []
    const encoded = encodeVector(query)
    if (!encoded) return []
    const q = decodeVector(encoded)
    if (q.length !== data.dims) return []
    const { matrix, dims, ids, agents } = data
    const scored: Array<{ i: number; s: number }> = []
    for (let row = 0; row < ids.length; row += 1) {
      if (filter.agent !== undefined && agents[row] !== filter.agent) continue
      let dot = 0
      const base = row * dims
      for (let d = 0; d < dims; d += 1) dot += matrix[base + d] * q[d]
      scored.push({ i: row, s: dot })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, k).map(({ i, s }) => ({ id: ids[i], score: s }))
  }

  private load(): Loaded {
    if (this.loaded) return this.loaded
    const rows = this.db
      .prepare(
        `SELECT m.id, m.agent, m.embedding FROM ${this.table} m
          WHERE m.embedding IS NOT NULL AND (${this.where})`,
      )
      .all() as unknown as Array<{ id: string; agent: string; embedding: Uint8Array }>
    const dims = rows.length > 0 ? Math.floor(rows[0].embedding.byteLength / 4) : 0
    const usable = rows.filter((r) => r.embedding.byteLength === dims * 4)
    const matrix = new Float32Array(usable.length * dims)
    usable.forEach((r, row) => {
      matrix.set(decodeVector(r.embedding), row * dims)
    })
    this.loaded = {
      ids: usable.map((r) => r.id),
      agents: usable.map((r) => r.agent),
      dims,
      matrix,
    }
    return this.loaded
  }
}
