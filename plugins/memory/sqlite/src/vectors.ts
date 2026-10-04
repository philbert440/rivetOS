/**
 * Vector storage and search for the SQLite backend.
 *
 * An embedding is stored on its row as a BLOB of little-endian float32,
 * L2-normalized at write time, so cosine similarity is a dot product. Search
 * goes through the `VectorIndex` interface; the implementation here is an
 * exact scan over vectors held in memory. It needs no native extension and is
 * exact. Cost is linear: one dot product per stored vector per search, and
 * `rows × dims × 4` bytes resident (100k rows at 1024 dims is about 400 MB
 * and a scan in the hundreds of milliseconds), so it suits a single-machine
 * store; the index warns once past `LARGE_INDEX_ROWS`. An approximate index
 * can replace it behind the same interface if a store outgrows it.
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
  /** Add or replace one stored vector without a reload. */
  add(id: string, agent: string, vector: Uint8Array): void
}

/** Past this many vectors the exact scan is no longer cheap: say so once. */
export const LARGE_INDEX_ROWS = 200_000

interface Loaded {
  ids: string[]
  agents: string[]
  dims: number
  rows: Float32Array[]
  position: Map<string, number>
}

/**
 * Exact cosine scan over the embeddings of one table. Vectors are loaded once
 * and then maintained in place: `add()` appends or replaces a row, so storing
 * an embedding does not force a reload. Rows whose width differs from the
 * index's (a width change mid-store) are skipped and counted.
 */
export class ExactScanIndex implements VectorIndex {
  private loaded: Loaded | undefined
  private warnedLarge = false

  constructor(
    private readonly db: DatabaseSync,
    /** Table with `id`, `agent`, `embedding` columns. */
    private readonly table: 'ros_messages' = 'ros_messages',
    /** Extra SQL predicate over alias `m` choosing which rows are searchable. */
    private readonly where = '1 = 1',
    private readonly log: (line: string) => void = () => {},
  ) {}

  invalidate(): void {
    this.loaded = undefined
  }

  /** Stored vectors, without loading them. */
  size(): number {
    if (this.loaded) return this.loaded.ids.length
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM ${this.table} m WHERE m.embedding IS NOT NULL AND (${this.where})`,
      )
      .get() as unknown as { n: number }
    return row.n
  }

  /**
   * Add or replace one vector without reloading. A no-op until the index has
   * been loaded (the next search loads everything, this row included).
   */
  add(id: string, agent: string, vector: Uint8Array): void {
    const data = this.loaded
    if (!data) return
    const decoded = decodeVector(vector)
    if (data.ids.length === 0) data.dims = decoded.length
    if (decoded.length !== data.dims) {
      // A different width: only a full reload can decide which width wins.
      this.loaded = undefined
      return
    }
    const at = data.position.get(id)
    if (at !== undefined) {
      data.rows[at] = decoded
      data.agents[at] = agent
      return
    }
    data.position.set(id, data.ids.length)
    data.ids.push(id)
    data.agents.push(agent)
    data.rows.push(decoded)
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
    const { rows, dims, ids, agents } = data
    const scored: Array<{ i: number; s: number }> = []
    for (let row = 0; row < ids.length; row += 1) {
      if (filter.agent !== undefined && agents[row] !== filter.agent) continue
      const v = rows[row]
      let dot = 0
      for (let d = 0; d < dims; d += 1) dot += v[d] * q[d]
      scored.push({ i: row, s: dot })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, k).map(({ i, s }) => ({ id: ids[i], score: s }))
  }

  private load(): Loaded {
    if (this.loaded) return this.loaded
    const found = this.db
      .prepare(
        `SELECT m.id, m.agent, m.embedding FROM ${this.table} m
          WHERE m.embedding IS NOT NULL AND (${this.where})`,
      )
      .all() as unknown as Array<{ id: string; agent: string; embedding: Uint8Array }>
    // The most common width is the index's; a stray row of another width
    // must not decide it.
    const widths = new Map<number, number>()
    for (const r of found) {
      const w = Math.floor(r.embedding.byteLength / 4)
      widths.set(w, (widths.get(w) ?? 0) + 1)
    }
    let dims = 0
    let best = 0
    for (const [w, n] of widths) {
      if (n > best) {
        dims = w
        best = n
      }
    }
    const usable = found.filter((r) => r.embedding.byteLength === dims * 4)
    if (usable.length < found.length) {
      this.log(
        `[memory.sqlite] ${String(found.length - usable.length)} stored vector(s) are not ${String(dims)} wide and are left out of vector search`,
      )
    }
    if (usable.length > LARGE_INDEX_ROWS && !this.warnedLarge) {
      this.warnedLarge = true
      this.log(
        `[memory.sqlite] ${String(usable.length)} vectors in the exact-scan index (~${String(Math.round((usable.length * dims * 4) / 1_048_576))} MB); searches scan all of them`,
      )
    }
    const position = new Map<string, number>()
    usable.forEach((r, i) => position.set(r.id, i))
    this.loaded = {
      ids: usable.map((r) => r.id),
      agents: usable.map((r) => r.agent),
      dims,
      rows: usable.map((r) => decodeVector(r.embedding)),
      position,
    }
    return this.loaded
  }
}
