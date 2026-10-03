/**
 * Accepted tags as wiki input. The extract-wiki task lists them in the
 * prompt and uses them to find candidate topics.
 *
 * Two kinds of accepted tag reach an extraction, and they are not equal:
 *
 *   reviewed — a tag a person added, or a model suggestion a person accepted.
 *              A real statement about what the session is.
 *   rule     — the `project:` tag minted automatically from the session's
 *              working directory. It says where the work ran, not what it was
 *              about, and nobody reviewed it.
 *
 * What is present at extraction time: the rule tag, plus whatever was
 * reviewed BEFORE this leaf was mined. suggest-tags runs alongside
 * extract-wiki, so a leaf's own model suggestions are normally still
 * `suggested` and not included (a delayed or re-mined leaf can see them once
 * accepted); a session tag accepted later informs the later leaves of
 * that session (session tags are inherited), but already-mined leaves are not
 * re-mined.
 *
 * Tags are optional enrichment: any lookup failure degrades to "no tags".
 * This runs whether or not SESSION_TAGGING is on — that switch controls the
 * model tagger, not the use of tags that already exist.
 */

import type pg from 'pg'
import type { Tag } from '@rivetos/types'
import { listTags, tagsForConversations } from '@rivetos/memory-postgres'

/** Sources whose accepted tags a person stands behind. */
const REVIEWED_SOURCES: ReadonlySet<string> = new Set(['user', 'model', 'import'])

/** Tags offered to one extraction, at most. */
export const WIKI_TAGS_MAX = 20
const LITERAL_MAX = 80

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
 * (`project:tenpal`, not `project:TenPAL`). One line, no markdown structure,
 * bounded by code point.
 */
export function safeLiteral(tag: Pick<Tag, 'key' | 'value'>): string {
  const text = `${tag.key}:${tag.value}`.replace(/[\s#`]+/g, ' ').trim()
  return Array.from(text).slice(0, LITERAL_MAX).join('')
}

let warnedMissingSchema = false

/** Session tags first, then the summary's own; deduped; reviewed before rule; capped. */
export async function acceptedTagsForSummary(
  pool: pg.Pool,
  summaryId: string,
  conversationId: string | null | undefined,
  log: (line: string) => void = (line) => {
    console.warn(line)
  },
): Promise<WikiTag[]> {
  let own: Tag[]
  let inherited: Tag[]
  try {
    ;[own, inherited] = await Promise.all([
      listTags(pool, { entityType: 'summary', entityId: summaryId, states: ['accepted'] }),
      conversationId
        ? tagsForConversations(pool, [conversationId]).then((m) => m.get(conversationId) ?? [])
        : Promise.resolve([] as Tag[]),
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/relation "?ros_tag[a-z_]*"? does not exist/i.test(msg)) {
      if (!warnedMissingSchema) {
        warnedMissingSchema = true
        log('[wiki-tags] tag tables missing (migration 0019 not applied) — extracting without tags')
      }
    } else {
      log(`[wiki-tags] tag lookup failed, extracting without tags: ${msg}`)
    }
    return []
  }
  const byId = new Map<string, WikiTag>()
  for (const t of [...inherited, ...own]) {
    const id = `${t.key}:${t.value}`
    // Reviewed = a person was involved: they added it, accepted a model
    // suggestion, or imported it. Any other source (the cwd rule, or a tagger
    // added later) is treated as unreviewed until it is listed here.
    const reviewed = REVIEWED_SOURCES.has(t.source)
    const prior = byId.get(id)
    // The same tag from the rule and from a person is a reviewed tag.
    if (prior) prior.reviewed ||= reviewed
    else byId.set(id, { literal: safeLiteral(t), key: t.key, value: t.value, reviewed })
  }
  // Reviewed first, then capped. If the cap drops the rule tag, the prompt
  // has no rule section and the entity guard has nothing to strip.
  const out = [...byId.values()]
  out.sort((a, b) => Number(b.reviewed) - Number(a.reviewed))
  return out.slice(0, WIKI_TAGS_MAX)
}

/** Test hook. */
export function resetWikiTagsWarnings(): void {
  warnedMissingSchema = false
}

/**
 * True when the tag's value (or its de-dashed form) occurs in the summary as
 * a whole token: a checkout named `os` is not "mentioned" by `postgres`.
 */
export function mentionedIn(summary: string, value: string): boolean {
  const hay = summary.toLowerCase()
  const esc = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [value, value.replace(/-/g, ' ')].some(
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
