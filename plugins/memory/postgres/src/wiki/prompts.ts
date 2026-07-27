/**
 * Wiki extraction prompts + patch parsing (phase 3c / memory v6 / v7 articles).
 *
 * Mines leaf summaries into durable Wikipedia-style topic patches.
 * Design: memory-v6-durable-topics.md, memory-v7-wikipedia-articles.md
 */

import { normalizeSlug, type WikiArticlePatch, type WikiPatch } from '@rivetos/wiki-core'

/**
 * Bump to re-extract via backfill when the durable-topic contract changes.
 * v1 = phase 3c free-form topics
 * v2 = durable topics + hard identity
 * v3 = Wikipedia-style Summary/Article/See also + shrink-safe merges
 */
export const WIKI_PIPELINE_VERSION = 3

// 6000 not 2048: the local qwen-27b serves with thinking ON — reasoning
// alone can burn 2k tokens before the JSON starts (first live extraction
// died exactly this way). Mirrors LEAF_MAX_TOKENS headroom logic.
export const WIKI_EXTRACT_MAX_TOKENS = 6000

/** Summaries shorter than this carry too little signal to mine. */
export const WIKI_MIN_SUMMARY_CHARS = 200

export const WIKI_EXTRACT_SYSTEM_PROMPT = `You maintain Wikipedia-style durable topic pages distilled from an engineering assistant's conversation memory. Given one LEAF conversation summary (an episodic moment), update long-lived encyclopedia articles about real-world subjects.

A durable topic is a long-lived subject: a project, host/machine, service, model, domain, recurring workflow, or standing preference.
NOT a topic: one session's task, a transient debug step, a PR number alone, "this morning's AWQ run", small talk.

Page shape (think Wikipedia, not a status sticky note):
- **summary**: 2–5 sentence LEAD — what the subject is, why it matters, current standing status. Present-tense. Grows over time.
- **article_patches**: standing body under named ### sections (Role, Location, Configuration, Operations, Domains, Known issues, …). Integrate facts; do not thrash-replace the whole encyclopedia with one session's focus.
- **related** + \`[[kebab-slug]]\` links to peer durable subjects (hosts, services, projects, domains).
- **history_entry**: only what CHANGED in standing knowledge this leaf (short bullets).

Rules:
- Only extract facts worth remembering in a month. If none, return [].
- Prefer UPDATING an existing candidate page — reuse its slug EXACTLY. Never invent a session-shaped child slug (e.g. deckard-40b-awq-grid-search) when a parent exists (deckard-40b).
- One real subject → one slug. Session detail goes in history_entry, not a new page.
- Prefer **summary_delta** (new sentences to fold into the lead) over full **summary** rewrite. Full **summary** only when creating a page or the standing lead is wrong/stale.
- Prefer **article_patches** over full **article**. Never shrink a rich lead into a narrow session blurb.
- Crosslink peers with [[slug]] using candidate slugs when possible (e.g. [[pve3]], [[rivetos-dev]]).
- entities: stable kind:name ids (host:pve3, model:deckard-40b, project:rivetos, domain:rivetos.dev).
- Keep identifiers verbatim (hostnames, ports, versions, paths, domains).
- 0-3 patches per summary. Less is more. action "create" only when no candidate matches the subject.

Respond with ONLY a JSON array (no fence, no prose):
[
  {
    "action": "update" | "create",
    "slug": "kebab-case-topic-slug",
    "title": "Human Title",
    "aliases": ["optional", "alternate", "names"],
    "tags": ["optional-tags"],
    "entities": ["kind:name identifiers"],
    "related": ["peer-slug", "another-slug"],
    "summary_delta": "optional 1-3 sentences to fold into the lead",
    "summary": "optional FULL lead rewrite — only when create or lead is wrong",
    "article_patches": [
      { "heading": "Configuration", "mode": "merge", "body": "markdown under ### Configuration" }
    ],
    "article": null,
    "history_entry": { "date": "YYYY-MM-DD", "title": "what changed", "body": "- markdown bullets" }
  }
]

Legacy alias: "current_state" is accepted as "summary". Prefer summary_delta + article_patches.`

/** System prompt for one-shot article recompile from buried history. */
export const WIKI_RECOMPILE_SYSTEM_PROMPT = `You recompile a RivetOS durable topic into a Wikipedia-style article.

You are given: title/slug, current lead (may be thin/stale), article body (may be empty), history excerpts (often "Superseded current state" dumps that hold the real facts), and known peer slugs for linking.

Produce ONE JSON object (not an array, no fence):
{
  "title": "Human Title",
  "aliases": ["…"],
  "tags": ["…"],
  "entities": ["kind:name"],
  "related": ["peer-slug"],
  "summary": "2–6 sentence present-tense lead. What it is, why it matters, standing status. Use [[slug]] for peers.",
  "article": "Full encyclopedia body with ### subsections (Role, Architecture, Configuration, Domains, Operations, Known issues, … as appropriate). Dense standing facts only — not session diaries. Use [[slug]] links.",
  "history_entry": {
    "date": "YYYY-MM-DD",
    "title": "Article recompile (v7)",
    "body": "- Recompiled standing Summary + Article from history corpus\\n- …"
  }
}

Hard rules:
- Do NOT invent hosts, IPs, ports, or versions not supported by the source material.
- Prefer denser older superseded states over thin recent session blurbs when they conflict on richness (keep both facts if compatible).
- summary must NOT be a single session status line.
- Crosslink every durable peer you mention with [[kebab-slug]] from the known peer list when possible.
- Keep identifiers verbatim.`

export interface ExtractionCandidate {
  slug: string
  title: string
  aliases: string[]
  entities?: string[]
  currentState: string
  article?: string
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
            const art =
              c.article && c.article.trim() !== ''
                ? `\nArticle (excerpt):\n${c.article.slice(0, 800)}`
                : ''
            return `### ${c.slug} — ${c.title}${al}${ent}\nSummary:\n${c.currentState.slice(0, 1200)}${art}`
          })
          .join('\n\n')
      : '(none — the wiki has no matching durable topics yet; create only for long-lived subjects)'
  return [
    `## Conversation leaf summary (${input.summaryDate}${input.agent ? `, agent: ${input.agent}` : ''})`,
    input.summary,
    '',
    '## Existing durable topic candidates (UPDATE these slugs when the subject matches — do not invent child slugs)',
    candidates,
    '',
    'Update the encyclopedia entry: fold new standing facts into summary_delta / article_patches. Do not replace a rich lead with a narrow session note.',
  ].join('\n')
}

export function formatRecompilePrompt(input: {
  slug: string
  title: string
  aliases: string[]
  entities: string[]
  currentState: string
  article: string
  historyExcerpts: string
  peerSlugs: string[]
  today: string
}): string {
  return [
    `## Topic`,
    `slug: ${input.slug}`,
    `title: ${input.title}`,
    `aliases: ${input.aliases.join(', ') || '(none)'}`,
    `entities: ${input.entities.join(', ') || '(none)'}`,
    '',
    '## Current Summary (may be thin/stale)',
    input.currentState || '(empty)',
    '',
    '## Current Article',
    input.article || '(empty)',
    '',
    '## History / superseded material (source of buried facts)',
    input.historyExcerpts.slice(0, 48_000),
    '',
    '## Known peer slugs for [[links]]',
    input.peerSlugs.length > 0 ? input.peerSlugs.map((s) => `- ${s}`).join('\n') : '(none)',
    '',
    `history_entry.date must be ${input.today}.`,
    'Return ONE JSON object with summary + article as specified.',
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

    // summary / current_state alias
    const fullSummary =
      typeof e.summary === 'string'
        ? e.summary
        : typeof e.current_state === 'string'
          ? e.current_state
          : undefined
    const summaryDelta = typeof e.summary_delta === 'string' ? e.summary_delta : undefined
    const article = typeof e.article === 'string' ? e.article : undefined
    const articlePatches = parseArticlePatches(e.article_patches)

    patches.push({
      action: e.action,
      slug,
      title: typeof e.title === 'string' ? e.title : undefined,
      addAliases: strList(e.aliases),
      addTags: strList(e.tags),
      addEntities: strList(e.entities),
      addRelated: strList(e.related)?.map(normalizeSlug).filter(Boolean),
      currentState: fullSummary,
      summaryDelta,
      article,
      articlePatches: articlePatches.length > 0 ? articlePatches : undefined,
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

/** Parse recompile LLM JSON object into a single WikiPatch (update). */
export function parseRecompileResult(
  raw: string,
  slug: string,
  verifiedAt: string,
): { patch?: WikiPatch; rejected?: string } {
  let text = raw.trim()
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)
  if (fence) text = fence[1].trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { rejected: `unparseable JSON: ${text.slice(0, 200)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { rejected: 'expected a JSON object' }
  }
  const e = parsed as Record<string, unknown>
  const summary =
    typeof e.summary === 'string'
      ? e.summary
      : typeof e.current_state === 'string'
        ? e.current_state
        : undefined
  if (!summary || summary.trim() === '') return { rejected: 'missing summary' }
  const article = typeof e.article === 'string' ? e.article : undefined
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  const he = e.history_entry as Record<string, unknown> | undefined
  const historyEntry =
    he &&
    typeof he.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(he.date) &&
    typeof he.body === 'string'
      ? { date: he.date, title: typeof he.title === 'string' ? he.title : 'Article recompile (v7)', body: he.body }
      : {
          date: verifiedAt.slice(0, 10),
          title: 'Article recompile (v7)',
          body: '- Recompiled Summary + Article from history corpus',
        }

  return {
    patch: {
      action: 'update',
      slug: normalizeSlug(typeof e.slug === 'string' ? e.slug : slug),
      title: typeof e.title === 'string' ? e.title : undefined,
      addAliases: strList(e.aliases),
      addTags: strList(e.tags),
      addEntities: strList(e.entities),
      addRelated: strList(e.related)?.map(normalizeSlug).filter(Boolean),
      currentState: summary.trim(),
      article: article?.trim(),
      historyEntry,
      verifiedAt,
      // Recompile is allowed to replace a thin lead with a richer one, and
      // may intentionally rewrite even if shorter after contradiction cleanup.
      allowShrink: true,
    },
  }
}

function parseArticlePatches(raw: unknown): WikiArticlePatch[] {
  if (!Array.isArray(raw)) return []
  const out: WikiArticlePatch[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if (typeof o.heading !== 'string' || typeof o.body !== 'string') continue
    const mode = o.mode === 'replace' ? 'replace' : 'merge'
    out.push({ heading: o.heading.trim(), mode, body: o.body })
  }
  return out
}
