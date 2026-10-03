/**
 * Session + summary tags — `key:value` labels on memory entities.
 *
 * Shared wire/domain shape for the memory backends (postgres `ros_tags`,
 * sqlite mirror), the den tag routes, the MCP memory tools and the hub.
 * Core never knows which backend holds them.
 *
 * Lifecycle: a tagger (a cwd rule, a model, an import) inserts a tag as
 * `suggested`; a user flips it to `accepted` or `rejected`. Rejected tags are
 * kept so the same (entity, key, value) is never proposed twice. Rule-derived
 * facts (`project:` from the git root) and user-entered tags are born
 * `accepted`.
 */

/** What a tag row is attached to. */
export type TagEntityType = 'conversation' | 'summary'

/** Who produced the tag. Open set — new taggers add values, not migrations. */
export type TagSource = 'rule' | 'model' | 'user' | 'import' | (string & {})

/** Review state. */
export type TagState = 'suggested' | 'accepted' | 'rejected'

/** Well-known keys. Keys are free-form text; these are the seeded conventions. */
export const TAG_KEY_PROJECT = 'project'
export const TAG_KEY_TOPIC = 'topic'
/** Shared with the wiki entity vocabulary (`agent:grok`). */
export const TAG_KEY_AGENT = 'agent'

/** Storage bounds (CHECKed in 0019 / the sqlite mirror). Normalization truncates to them. */
export const TAG_KEY_MAX = 64
export const TAG_VALUE_MAX = 128

export interface Tag {
  id: string
  entityType: TagEntityType
  entityId: string
  key: string
  /** Normalized value (lowercased slug). Equality is on this. */
  value: string
  /**
   * First-seen casing for the UI. Empty means "same as value". Display only,
   * never a lookup key; `formatTag` uses it only when it normalizes back to
   * `value`, so a rendered literal always parses to the same tag.
   */
  display: string
  source: TagSource
  state: TagState
  /** Model suggestions only, 0..1. */
  confidence?: number
  /** Model id or rule name that proposed the tag. */
  proposedBy: string
  /** One-line justification from the proposer. */
  reason: string
  decidedBy?: string
  decidedAt?: Date
  createdAt: Date
  updatedAt: Date
}

/** A `key:value` pair without row bookkeeping — what taggers propose. */
export interface TagProposal {
  key: string
  value: string
  display?: string
  confidence?: number
  reason?: string
}

/** One vocabulary entry. `parentValue` nests under the same key (a tree). */
export interface TagTaxonomyEntry {
  key: string
  value: string
  display: string
  parentValue?: string
  /** Values merged into this one; lookups of an alias resolve here. */
  aliases: string[]
  state: TagState
  source: TagSource
  reason: string
  decidedAt?: Date
  createdAt: Date
  updatedAt: Date
}

/**
 * Normalize a raw tag value to its canonical slug: NFKC (so composed and
 * decomposed forms, full-width and compatibility characters are one value),
 * zero-width characters removed, control characters treated as spaces, trimmed, lowercased, whitespace and `/`
 * runs collapsed to `-`, outer `-` stripped, truncated to TAG_VALUE_MAX.
 * `TenPAL`, `tenpal`, ` TenPAL ` and `ＴｅｎＰＡＬ` are the same tag.
 * Returns `''` when the input has no slug characters; callers must treat
 * that as "no tag" (parseTagLiteral does).
 */
export function normalizeTagValue(raw: string): string {
  return slug(raw, TAG_VALUE_MAX)
}

/**
 * Normalize a key the same way, with `:` also treated as a separator. Keys
 * are a flat namespace (`project`, `topic`).
 */
export function normalizeTagKey(raw: string): string {
  // `:` separates key from value in a literal, so a key can never contain one.
  // NFKC first: compatibility colons (U+FF1A, U+FE13, U+2236, …) become ':'
  // and must be caught too. Idempotent: the result contains no colon.
  return slug(raw.normalize('NFKC').replace(/:/g, '-'), TAG_KEY_MAX)
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function slug(raw: string, max: number): string {
  // Lone surrogates are dropped: one would be stored as U+FFFD and never
  // equal the value it was normalized from.
  const s = raw
    .replace(LONE_SURROGATE, '')
    .normalize('NFKC')
    // Invisible format characters (zero-width, soft hyphen, bidi marks, BOM).
    .replace(/\p{Cf}/gu, '')
    // Control characters (newline, tab, bell, C1) act as separators.
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  // Truncate by code point so a surrogate pair is never split, then re-trim
  // a dash the cut may have exposed.
  return Array.from(s).slice(0, max).join('').replace(/-+$/, '')
}

/** Parse `key:value` (first colon splits). Returns null when either side is empty after normalization. */
export function parseTagLiteral(literal: string): { key: string; value: string } | null {
  const idx = literal.indexOf(':')
  if (idx <= 0) return null
  const key = normalizeTagKey(literal.slice(0, idx))
  const value = normalizeTagValue(literal.slice(idx + 1))
  if (!key || !value) return null
  return { key, value }
}

/**
 * Render as `key:value`. Uses the display casing only when it normalizes
 * back to `value`; otherwise the value itself, so the literal round-trips
 * through `parseTagLiteral` to the same tag.
 */
export function formatTag(tag: Pick<Tag, 'key' | 'value' | 'display'>): string {
  const display = tag.display.trim()
  const shown = display !== '' && normalizeTagValue(display) === tag.value ? display : tag.value
  return `${normalizeTagKey(tag.key)}:${shown}`
}
