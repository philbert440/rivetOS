/**
 * Wiki extraction prompts + patch parsing (phase 3c / memory v6).
 *
 * Mines leaf summaries into durable topic patches. Episodic leaf/branch/root
 * summarization is unchanged — this is a separate consumer with its own
 * pipeline version. Design: memory-v6-durable-topics.md
 */

import { normalizeSlug, type WikiPatch } from '@rivetos/wiki-core'

/**
 * Bump to re-extract via backfill when the durable-topic contract changes.
 * v1 = phase 3c free-form topics; v2 = durable topics + hard identity.
 */
export const WIKI_PIPELINE_VERSION = 2

// 6000 not 2048: the local qwen-27b serves with thinking ON — reasoning
// alone can burn 2k tokens before the JSON starts (first live extraction
// died exactly this way). Mirrors LEAF_MAX_TOKENS headroom logic.
export const WIKI_EXTRACT_MAX_TOKENS = 6000

/** Summaries shorter than this carry too little signal to mine. */
export const WIKI_MIN_SUMMARY_CHARS = 200

export const WIKI_EXTRACT_SYSTEM_PROMPT = `You maintain durable topic pages distilled from an engineering assistant's conversation memory. Given one LEAF conversation summary (an episodic moment), update long-lived topic pages about real-world subjects.

A durable topic is a long-lived subject: a project, host/machine, service, model, recurring workflow, or standing preference.
NOT a topic: one session's task, a transient debug step, a PR number alone, "this morning's AWQ run", small talk.

Rules:
- Only extract facts worth remembering in a month. If none, return [].
- Prefer UPDATING an existing candidate page — reuse its slug EXACTLY. Never invent a session-shaped child slug (e.g. deckard-40b-awq-grid-search) when a parent exists (deckard-40b).
- One real subject → one slug. Session detail goes in history_entry, not a new page.
- current_state: neutral, dense, PRESENT-TENSE "what is true now" markdown (no heading). Rewrite the WHOLE section — it replaces the old one; carry forward still-true facts from the candidate page text.
- history_entry: what CHANGED in standing knowledge, dated, short markdown bullets (not a full session diary).
- entities: stable kind:name ids (host:pve3, model:deckard-40b, project:rivetos, service:vllm).
- Keep identifiers verbatim (hostnames, ports, versions, paths).
- 0-3 patches per summary. Less is more. action "create" only when no candidate matches the subject.

Respond with ONLY a JSON array (no fence, no prose):
[
  {
    "action": "update" | "create",
    "slug": "kebab-case-topic-slug",
    "title": "Human Title",
    "aliases": ["optional", "alternate", "names"],
    "tags": ["optional-tags"],
    "entities": ["kind:name identifiers, e.g. host:pve3, project:rivetos"],
    "current_state": "full replacement markdown for the Current state section",
    "history_entry": { "date": "YYYY-MM-DD", "title": "what changed", "body": "- markdown bullets" }
  }
]`

export interface ExtractionCandidate {
  slug: string
  title: string
  aliases: string[]
  entities?: string[]
  currentState: string
}

export function formatExtractionPrompt(input: {
  summary: string
  summaryDate: string
  agent?: string
  candidates: ExtractionCandidate[]
}): string {
  const candidates =
    input.candidates.length > 0
      ? input.candidates
          .map((c) => {
            const ent =
              c.entities && c.entities.length > 0 ? ` entities: ${c.entities.join(', ')}` : ''
            const al = c.aliases.length > 0 ? ` aliases: ${c.aliases.join(', ')}` : ''
            return `### ${c.slug} — ${c.title}${al}${ent}\n${c.currentState.slice(0, 1200)}`
          })
          .join('\n\n')
      : '(none — the wiki has no matching durable topics yet; create only for long-lived subjects)'
  return [
    `## Conversation leaf summary (${input.summaryDate}${input.agent ? `, agent: ${input.agent}` : ''})`,
    input.summary,
    '',
    '## Existing durable topic candidates (UPDATE these slugs when the subject matches — do not invent child slugs)',
    candidates,
  ].join('\n')
}

/**
 * Parse the LLM's JSON patch array into validated WikiPatch objects.
 * Tolerates a fenced block despite instructions. Invalid entries are dropped
 * (returned in `rejected` for logging), never thrown — one bad patch must
 * not sink the extraction.
 */
export function parseWikiPatches(
  raw: string,
  verifiedAt: string,
): { patches: WikiPatch[]; rejected: string[] } {
  const rejected: string[] = []
  let text = raw.trim()
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)
  if (fence) text = fence[1].trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { patches: [], rejected: [`unparseable JSON: ${text.slice(0, 200)}`] }
  }
  if (!Array.isArray(parsed)) return { patches: [], rejected: ['not a JSON array'] }

  const patches: WikiPatch[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      rejected.push('non-object entry')
      continue
    }
    const e = entry as Record<string, unknown>
    const slug = typeof e.slug === 'string' ? normalizeSlug(e.slug) : ''
    if (slug === '' || (e.action !== 'update' && e.action !== 'create')) {
      rejected.push(`bad slug/action: ${JSON.stringify(e).slice(0, 120)}`)
      continue
    }
    const strList = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
    const he = e.history_entry as Record<string, unknown> | undefined
    const historyEntry =
      he &&
      typeof he.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(he.date) &&
      typeof he.body === 'string'
        ? { date: he.date, title: typeof he.title === 'string' ? he.title : '', body: he.body }
        : undefined
    patches.push({
      action: e.action,
      slug,
      title: typeof e.title === 'string' ? e.title : undefined,
      addAliases: strList(e.aliases),
      addTags: strList(e.tags),
      addEntities: strList(e.entities),
      currentState: typeof e.current_state === 'string' ? e.current_state : undefined,
      historyEntry,
      verifiedAt,
    })
  }
  // Hard cap mirrors the prompt's 0-3 contract — a prompt-injected summary
  // can't fan out into mass page vandalism (#287 review).
  if (patches.length > 3) {
    rejected.push(`patch cap: dropped ${patches.length - 3} beyond the first 3`)
    patches.length = 3
  }
  return { patches, rejected }
}
