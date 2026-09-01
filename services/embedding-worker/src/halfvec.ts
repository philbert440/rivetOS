/**
 * Shared pgvector halfvec helpers. Used by embed-target and chunk upsert so
 * literal formatting and dim truncation cannot drift.
 */

export function formatHalfvec(vec: number[]): string {
  return `[${vec.join(',')}]`
}

export function truncateVec(vec: number[], dims: number): number[] {
  return vec.length > dims ? vec.slice(0, dims) : vec
}
