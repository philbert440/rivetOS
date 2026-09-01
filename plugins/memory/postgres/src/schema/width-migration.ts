/**
 * Pure decision helper for the #624 embedding-width migration (0015).
 *
 * pgvector stores the dimension in `pg_attribute.atttypmod` (not typmod+4).
 * The SQL in `0015_embedding_width.sql` implements the same rules:
 *   skip   — column missing, or already `halfvec(target)`
 *   alter  — width differs AND zero non-null rows (safe to recast)
 *   refuse — width differs AND non-null rows exist (never silently drop data)
 *
 * Chunks DDL lives in `0014_chunks.sql` so a refuse here cannot block it.
 * Operator signal for a refused DB: `rivetos doctor` `checkEmbeddingWidth`.
 */

export type WidthMigrationDecision = 'skip' | 'alter' | 'refuse'

export function decideWidthMigration(input: {
  typmod: number | null
  nonNullCount: number
  target: number
}): WidthMigrationDecision {
  const { typmod, nonNullCount, target } = input
  if (typmod === null || typmod === target) return 'skip'
  if (nonNullCount > 0) return 'refuse'
  return 'alter'
}
