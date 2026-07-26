/**
 * Pure topic-identity helpers (memory v6).
 *
 * Used by WikiIndex.resolveTopic and the consolidation job so slug/entity
 * merge rules stay unit-testable without Postgres.
 */

import { normalizeSlug } from './model.js'

/** True when one slug is a hyphen-boundary prefix of the other (session shard of a parent). */
export function isSlugVariant(a: string, b: string): boolean {
  const x = normalizeSlug(a)
  const y = normalizeSlug(b)
  if (x === '' || y === '' || x === y) return x === y && x !== ''
  return y.startsWith(`${x}-`) || x.startsWith(`${y}-`)
}

/** Prefer the shorter slug when one is a variant of the other (canonical parent). */
export function preferCanonicalSlug(a: string, b: string): string {
  const x = normalizeSlug(a)
  const y = normalizeSlug(b)
  if (x === y) return x
  if (isSlugVariant(x, y)) return x.length <= y.length ? x : y
  return x
}

/** First N hyphen tokens (default 2) — cluster key for deckard-40b-*, rivetos-memory-*, etc. */
export function slugTokenPrefix(slug: string, n = 2): string {
  const parts = normalizeSlug(slug).split('-').filter(Boolean)
  if (parts.length === 0) return ''
  return parts.slice(0, Math.min(n, parts.length)).join('-')
}

/**
 * Among existing slugs, pick the best stem parent for `proposed`:
 * - exact match
 * - proposed is a child of an existing shorter slug (hyphen prefix)
 * - existing is a child of proposed (prefer existing shortest among variants)
 * Returns undefined when nothing is a variant.
 */
export function findStemMatch(proposed: string, existingSlugs: string[]): string | undefined {
  const p = normalizeSlug(proposed)
  if (p === '') return undefined
  const variants = existingSlugs
    .map(normalizeSlug)
    .filter((s) => s !== '' && (s === p || isSlugVariant(s, p)))
  if (variants.length === 0) return undefined
  // Shortest wins (canonical parent); ties break lexicographically for stability.
  variants.sort((a, b) => a.length - b.length || a.localeCompare(b))
  return variants[0]
}

/**
 * Cluster slugs for consolidation: group by 2-token prefix when the slug has
 * 3+ tokens; otherwise the full slug is its own cluster key.
 * Returns Map<clusterKey, slugs[]>.
 */
export function clusterSlugsByStem(slugs: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const raw of slugs) {
    const s = normalizeSlug(raw)
    if (s === '') continue
    const parts = s.split('-').filter(Boolean)
    const key = parts.length >= 3 ? parts.slice(0, 2).join('-') : s
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }
  return groups
}

/** Entity list overlap (any shared entity id). */
export function entitiesOverlap(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a?.length || !b?.length) return false
  const set = new Set(a)
  return b.some((e) => set.has(e))
}
