/**
 * Session tags as wiki-extraction input: the shape a tag takes in the
 * prompt, and the pure rules for using them (which entities a rule tag may
 * not add, which topics a tag makes a candidate). Backend-neutral: each
 * backend loads the tags its own way.
 */

/** Tags offered to one extraction, at most. */
export const WIKI_TAGS_MAX = 20
const LITERAL_MAX = 80
/** Rows read per source before dedupe, sort and cap. */

export interface WikiTag {
  /** Normalized `key:value` (the canonical entity form), single line, bounded. */
  literal: string
  key: string
  value: string
  /** False for the automatic cwd rule tag. */
  reviewed: boolean
}

/**
 * The literal shown to the model: `key:value` from the NORMALIZED value, not
 * the display casing. Wiki entity ids are compared case-sensitively, so a tag
 * the model copies into `entities` must be the canonical form
 * (`project:acmeapp`, not `project:AcmeApp`). One line, no markdown structure,
 * bounded by code point.
 */
export function safeLiteral(tag: { key: string; value: string }): string {
  const text = `${tag.key}:${tag.value}`.replace(/[\s#`]+/g, ' ').trim()
  return Array.from(text).slice(0, LITERAL_MAX).join('')
}

/**
 * True when the tag's value (or its de-dashed form) occurs in the summary as
 * a whole token: a checkout named `os` is not "mentioned" by `postgres`.
 */
export function mentionedIn(summary: string, value: string): boolean {
  const hay = summary.toLowerCase()
  // Tag values are stored lowercase; lowercase here too so this does not depend on it.
  const needle = value.toLowerCase()
  const esc = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [needle, needle.replace(/-/g, ' ')].some(
    (v) => v !== '' && new RegExp(`(^|[^a-z0-9])${esc(v)}([^a-z0-9]|$)`).test(hay),
  )
}

/** `key:value` ids of the automatic rule tags: never allowed into a patch's entities. */
export function ruleEntityIds(tags: readonly WikiTag[]): Set<string> {
  return new Set(tags.filter((t) => !t.reviewed).map((t) => `${t.key}:${t.value}`))
}

/**
 * Drop entities that are only the automatic cwd rule tag. The prompt says
 * not to add them; this makes it structural, because an entity overlap can
 * redirect a new page onto an existing topic.
 */
export function withoutRuleEntities(
  entities: readonly string[] | undefined,
  tags: readonly WikiTag[],
): string[] | undefined {
  if (!entities) return undefined
  const banned = ruleEntityIds(tags)
  return banned.size === 0 ? [...entities] : entities.filter((e) => !banned.has(e.toLowerCase()))
}

/**
 * Search text for extra candidate topics, from `project` then `topic` tags.
 * A reviewed tag always contributes. The automatic cwd rule tag contributes
 * only when the summary itself mentions it — otherwise a session that merely
 * ran inside a checkout would pull that project's page in as an update
 * target. Values are emitted verbatim (identifiers like `deckard-40b` must
 * stay searchable) plus the de-dashed form when it differs.
 */
export function tagCandidateQuery(tags: readonly WikiTag[], summary: string): string | null {
  const terms: string[] = []
  for (const key of ['project', 'topic']) {
    for (const t of tags) {
      if (t.key !== key || t.value === '') continue
      if (!t.reviewed && !mentionedIn(summary, t.value)) continue
      terms.push(t.value)
      const spaced = t.value.replace(/-/g, ' ')
      if (spaced !== t.value) terms.push(spaced)
    }
  }
  const text = [...new Set(terms)].join(' ').trim()
  return text === '' ? null : text
}

/**
 * Append tag-derived topic hits to the content-search hits: no duplicates,
 * at most `cap` extra, each marked so the prompt can label it. Pure; the
 * input arrays are not mutated.
 */
export function mergeTagCandidates<T extends { slug: string }>(
  hits: readonly T[],
  tagHits: readonly T[],
  cap: number,
): Array<T & { fromTag?: true }> {
  const out: Array<T & { fromTag?: true }> = [...hits]
  const seen = new Set(hits.map((h) => h.slug))
  let added = 0
  for (const h of tagHits) {
    if (added >= cap) break
    if (seen.has(h.slug)) continue
    seen.add(h.slug)
    out.push({ ...h, fromTag: true })
    added += 1
  }
  return out
}
