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
 * that session (session tags are inherited), but a leaf already mined at the
 * current WIKI_PIPELINE_VERSION is not re-mined. (The bump to v4 re-mined
 * everything older once, so history saw the tags accepted by then.)
 *
 * Tags are optional enrichment: any lookup failure degrades to "no tags".
 * This runs whether or not SESSION_TAGGING is on — that switch controls the
 * model tagger, not the use of tags that already exist.
 */

import type pg from 'pg'
import type { Tag } from '@rivetos/types'
import {
  REVIEWED_TAG_SOURCES,
  WIKI_TAGS_MAX,
  listTags,
  safeLiteral,
  tagsForConversations,
  type WikiTag,
} from '@rivetos/memory-postgres'

/** Sources whose accepted tags a person stands behind. */
const REVIEWED_SOURCES: ReadonlySet<string> = new Set(REVIEWED_TAG_SOURCES)

const WIKI_TAGS_LOOKUP_MAX = 100

export {
  WIKI_TAGS_MAX,
  safeLiteral,
  mentionedIn,
  ruleEntityIds,
  withoutRuleEntities,
  tagCandidateQuery,
  mergeTagCandidates,
} from '@rivetos/memory-postgres'
export type { WikiTag } from '@rivetos/memory-postgres'

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
      listTags(pool, {
        entityType: 'summary',
        entityId: summaryId,
        states: ['accepted'],
        // Dedupe and the reviewed-first sort need more than the cap, not everything.
        limit: WIKI_TAGS_LOOKUP_MAX,
      }),
      conversationId
        ? tagsForConversations(pool, [conversationId], ['accepted'], {
            limit: WIKI_TAGS_LOOKUP_MAX,
          }).then((m) => m.get(conversationId) ?? [])
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
    // added later) is unreviewed until it is listed above. Re-adding the rule
    // tag promotes its source to `user` in the store, so the source alone
    // decides — `decided_by` is caller-supplied and proves nothing.
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

/** Test-only: reset the warn-once latch. */
export function resetWikiTagsWarnings(): void {
  warnedMissingSchema = false
}
