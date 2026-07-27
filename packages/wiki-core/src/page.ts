/**
 * parse / serialize / applyPatch — pure functions over the page model.
 * Round-trip guarantee: serialize(parse(x)) is stable for well-formed pages;
 * unknown sections are preserved verbatim (forward compatibility).
 *
 * v7: ## Summary (alias ## Current state), ## Article, ## See also;
 * summary shrink guard; section-aware article merge.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  extractWikiLinks,
  normalizeSlug,
  type WikiArticlePatch,
  type WikiArticleSection,
  type WikiCitation,
  type WikiFrontmatter,
  type WikiHistoryEntry,
  type WikiPage,
  type WikiPatch,
} from './model.js'

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/
// Accept em-dash, en-dash, or ASCII hyphen between date and title.
const HISTORY_HEADING_RE = /^### (\d{4}-\d{2}-\d{2})(?:\s+[—–-]\s+(.*))?$/

/** Core H2 headings (case-insensitive). Legacy "current state" ≡ Summary. */
const CORE_HEADINGS = new Set([
  'current state',
  'summary',
  'article',
  'see also',
  'history',
  'citations',
])

/** Refuse full Summary rewrite shorter than this fraction of the prior. */
export const SUMMARY_SHRINK_FLOOR = 0.6

/**
 * Hard ceiling on Summary lead length. Overflow spills to History so injection
 * (front-truncated) and embeddings stay dense.
 */
export const SUMMARY_MAX_CHARS = 2400

/** Article excerpt kept in search_text for FTS/embed (not full body). */
export const SEARCH_ARTICLE_EXCERPT_CHARS = 1200

export class WikiParseError extends Error {
  constructor(detail: string) {
    super(`invalid wiki page: ${detail}`)
    this.name = 'WikiParseError'
  }
}

export function parseWikiPage(input: string): WikiPage {
  const markdown = input.replace(/\r\n/g, '\n')
  const fm = FRONTMATTER_RE.exec(markdown)
  if (!fm) throw new WikiParseError('missing YAML frontmatter')
  const rawMeta = parseYaml(fm[1]) as Record<string, unknown> | null
  if (!rawMeta || typeof rawMeta !== 'object') throw new WikiParseError('frontmatter not a map')
  const meta = normalizeMeta(rawMeta)

  const body = markdown.slice(fm[0].length)
  const { preamble, sections } = splitSections(body)

  const summarySec =
    sections.find((s) => s.heading.toLowerCase() === 'summary') ??
    sections.find((s) => s.heading.toLowerCase() === 'current state')
  const articleSec = sections.find((s) => s.heading.toLowerCase() === 'article')
  const seeAlsoSec = sections.find((s) => s.heading.toLowerCase() === 'see also')
  const history = sections.find((s) => s.heading.toLowerCase() === 'history')
  const citationsSec = sections.find((s) => s.heading.toLowerCase() === 'citations')
  const extras = sections.filter((s) => !CORE_HEADINGS.has(s.heading.toLowerCase()))

  const currentState = (summarySec?.body ?? '').trim()
  const article = (articleSec?.body ?? '').trim()
  const seeAlsoFromSec = seeAlsoSec ? parseSeeAlso(seeAlsoSec.body) : []
  const seeAlso = union(meta.related, seeAlsoFromSec)
  // Promote outbound links into related graph without losing frontmatter order.
  meta.related = union(meta.related, seeAlso)

  return {
    meta,
    currentState,
    article,
    history: history ? parseHistory(history.body) : [],
    citations: citationsSec ? parseCitations(citationsSec.body) : [],
    seeAlso,
    ...(preamble.trim() !== '' ? { preamble: preamble.trim() } : {}),
    ...(extras.length > 0
      ? { extraSections: extras.map((s) => ({ heading: s.heading, body: s.body.trim() })) }
      : {}),
  }
}

export function serializeWikiPage(page: WikiPage): string {
  const related = union(page.meta.related || [], page.seeAlso || []).filter(
    (s) => s !== page.meta.slug,
  )
  const meta: Record<string, unknown> = {
    ...(page.meta.extra ?? {}),
    title: page.meta.title,
    slug: page.meta.slug,
    aliases: page.meta.aliases,
    tags: page.meta.tags,
    entities: page.meta.entities,
    related,
    ...(page.meta.lastVerified ? { last_verified: page.meta.lastVerified } : {}),
    sources: page.meta.sources,
  }
  const history = page.history
    .map((h) => `### ${h.date}${h.title ? ` — ${h.title}` : ''}\n\n${h.body.trim()}\n`)
    .join('\n')
  const citations = page.citations || []
  const citationBlock =
    citations.length === 0
      ? ''
      : [
          '',
          '## Citations',
          '',
          '| Date | Kind | Summary | Note |',
          '|------|------|---------|------|',
          ...citations.map((c) => {
            const date = c.date ?? ''
            const kind = c.kind ?? 'leaf'
            const note = (c.note ?? '').replace(/\|/g, '\\|')
            return `| ${date} | ${kind} | \`${c.summaryId}\` | ${note} |`
          }),
          '',
        ].join('\n')

  const article = (page.article || '').trim()
  const articleBlock = article === '' ? '' : ['', '## Article', '', article, ''].join('\n')

  const seeAlsoBlock =
    related.length === 0
      ? ''
      : ['', '## See also', '', ...related.map((s) => `- [[${s}]]`), ''].join('\n')

  return [
    `---\n${stringifyYaml(meta).trimEnd()}\n---`,
    ...(page.preamble ? ['', page.preamble] : []),
    '',
    '## Summary',
    '',
    page.currentState.trim(),
    articleBlock,
    seeAlsoBlock,
    '',
    '## History',
    '',
    history.trimEnd(),
    citationBlock,
    ...(page.extraSections ?? []).flatMap((s) => ['', `## ${s.heading}`, '', s.body]),
    '',
  ].join('\n')
}

/**
 * Apply a patch. Auto-merge everywhere: when the patch replaces a non-empty
 * Summary with different content and carries no explicit history entry
 * covering it, the PRIOR state is archived as a dated entry first —
 * human edits included, nothing is silently lost.
 *
 * v7 shrink guard: a full Summary rewrite shorter than SUMMARY_SHRINK_FLOOR
 * of the prior length is treated as a delta fold (unless allowShrink).
 */
export function applyPatch(existing: WikiPage | undefined, patch: WikiPatch): WikiPage {
  const slug = normalizeSlug(patch.slug)
  const page: WikiPage = existing
    ? structuredClone(existing)
    : {
        meta: {
          title: patch.title ?? slug,
          slug,
          aliases: [],
          tags: [],
          entities: [],
          related: [],
          sources: [],
        },
        currentState: '',
        article: '',
        history: [],
        citations: [],
        seeAlso: [],
      }

  if (patch.title) page.meta.title = patch.title
  page.meta.aliases = union(page.meta.aliases, patch.addAliases)
  page.meta.tags = union(page.meta.tags, patch.addTags)
  page.meta.entities = union(page.meta.entities, patch.addEntities)
  const relatedAdds = (patch.addRelated ?? []).map(normalizeSlug).filter(Boolean)
  page.meta.related = union(page.meta.related, relatedAdds)
  page.meta.lastVerified = patch.verifiedAt
  for (const src of patch.addSources ?? []) {
    const key = (x: { ids: string[] }): string => JSON.stringify([...x.ids].sort())
    const dup = page.meta.sources.find((s) => s.kind === src.kind && key(s) === key(src))
    if (!dup) page.meta.sources.push(src)
  }

  const day = patch.verifiedAt.slice(0, 10)

  // --- Summary (currentState) ---
  if (patch.summaryDelta !== undefined && patch.summaryDelta.trim() !== '') {
    page.currentState = mergeSummaryText(
      page.currentState,
      demoteH2Headings(patch.summaryDelta.trim()),
    )
  }

  if (patch.currentState !== undefined && patch.currentState.trim() !== page.currentState.trim()) {
    const next = demoteH2Headings(patch.currentState.trim())
    const prev = page.currentState.trim()
    const wouldShrink =
      prev !== '' &&
      next !== '' &&
      next.length < prev.length * SUMMARY_SHRINK_FLOOR &&
      !patch.allowShrink

    if (wouldShrink) {
      // Refuse thrash: fold only when under the hard ceiling; else archive the
      // rewrite so a real correction never vanishes without a trace.
      if (prev.length < SUMMARY_MAX_CHARS) {
        page.currentState = mergeSummaryText(prev, next)
      } else {
        page.history.unshift({
          date: day,
          title: 'Summary thrash refused (v7 cap)',
          body: next,
        })
      }
    } else if (next !== prev) {
      if (prev !== '') {
        page.history.unshift({
          date: day,
          title: 'Superseded current state',
          body: prev,
        })
      }
      page.currentState = next
    }
  }

  // Cap lead; spill overflow so injection/embed stay dense.
  {
    const capped = capSummary(page.currentState)
    page.currentState = capped.kept
    if (capped.overflow) {
      page.history.unshift({
        date: day,
        title: 'Summary overflow (v7 cap)',
        body: capped.overflow,
      })
    }
  }

  // --- Article ---
  if (
    patch.article !== undefined &&
    demoteH2Headings(patch.article.trim()) !== page.article.trim()
  ) {
    const next = demoteH2Headings(patch.article.trim())
    if (page.article.trim() !== '' && next !== page.article.trim()) {
      page.history.unshift({
        date: day,
        title: 'Superseded article',
        body: page.article.trim(),
      })
    }
    page.article = next
  }
  if (patch.articlePatches?.length) {
    const demoted = patch.articlePatches.map((p) => ({
      ...p,
      body: demoteH2Headings(p.body),
    }))
    page.article = applyArticlePatches(page.article, demoted)
  }

  if (patch.historyEntry) {
    const h = patch.historyEntry
    // Same H2-escape class as article: bare ## inside history body would be
    // re-parsed as a top-level section and truncate the entry.
    const body = demoteH2Headings(h.body.trim())
    const dup = page.history.find(
      (e) => e.date === h.date && e.title === h.title && e.body.trim() === body,
    )
    if (!dup) page.history.unshift({ ...h, body })
  }

  for (const c of patch.addCitations ?? []) {
    if (!c.summaryId) continue
    const dup = page.citations.find((x) => x.summaryId === c.summaryId)
    if (!dup) {
      page.citations.unshift({
        summaryId: c.summaryId,
        ...(c.date ? { date: c.date } : {}),
        ...(c.kind ? { kind: c.kind } : {}),
        ...(c.note ? { note: c.note } : {}),
      })
    }
  }

  // Harvest [[links]]; drop self-links.
  const links = extractWikiLinks(`${page.currentState}\n${page.article}`).filter((s) => s !== slug)
  page.meta.related = union(page.meta.related, links).filter((s) => s !== slug)
  page.seeAlso = union(page.seeAlso, page.meta.related).filter((s) => s !== slug)

  return page
}

/**
 * Merge loser pages into a canonical durable topic (consolidation).
 * Keeps canonical Summary if non-empty; prefers denser Summary when clearly
 * longer. Unions meta + article + seeAlso; prepends loser history + citations.
 */
export function mergePages(canonical: WikiPage, losers: WikiPage[]): WikiPage {
  const out: WikiPage = structuredClone(canonical)
  // Normalize fields on pages that predate v7 (or partial clones in tests).
  out.article = out.article || ''
  out.seeAlso = out.seeAlso || []
  out.citations = out.citations || []
  out.meta.related = out.meta.related || []

  for (const loser of losers) {
    if (loser.meta.slug === out.meta.slug) continue
    out.meta.aliases = union(out.meta.aliases, [
      loser.meta.slug,
      ...loser.meta.aliases,
      loser.meta.title,
    ])
    out.meta.tags = union(out.meta.tags, loser.meta.tags)
    out.meta.entities = union(out.meta.entities, loser.meta.entities)
    out.meta.related = union(out.meta.related, loser.meta.related, loser.seeAlso)
    for (const src of loser.meta.sources) {
      const key = (x: { ids: string[] }): string => JSON.stringify([...x.ids].sort())
      const dup = out.meta.sources.find((s) => s.kind === src.kind && key(s) === key(src))
      if (!dup) out.meta.sources.push(src)
    }

    // Summary merge
    if (out.currentState.trim() === '' && loser.currentState.trim() !== '') {
      out.currentState = loser.currentState.trim()
    } else if (
      loser.currentState.trim() !== '' &&
      loser.currentState.trim() !== out.currentState.trim() &&
      loser.currentState.length > out.currentState.length * 1.25
    ) {
      out.history.unshift({
        date: (out.meta.lastVerified ?? new Date().toISOString()).slice(0, 10),
        title: 'Superseded current state (consolidation)',
        body: out.currentState.trim(),
      })
      out.currentState = loser.currentState.trim()
    } else if (
      loser.currentState.trim() !== '' &&
      loser.currentState.trim() !== out.currentState.trim()
    ) {
      out.history.unshift({
        date: (loser.meta.lastVerified ?? new Date().toISOString()).slice(0, 10),
        title: `Merged from ${loser.meta.slug}`,
        body: loser.currentState.trim(),
      })
      out.currentState = mergeSummaryText(out.currentState, loser.currentState.trim())
    }

    // Article merge — prefer denser; otherwise section-merge loser's article in.
    const loserArticle = (loser.article ?? '').trim()
    if (loserArticle) {
      if (out.article.trim() === '') {
        out.article = demoteH2Headings(loserArticle)
      } else if (loserArticle !== out.article.trim()) {
        if (loserArticle.length > out.article.length * 1.25) {
          out.history.unshift({
            date: (out.meta.lastVerified ?? new Date().toISOString()).slice(0, 10),
            title: 'Superseded article (consolidation)',
            body: out.article.trim(),
          })
          out.article = demoteH2Headings(loserArticle)
        } else {
          out.article = mergeArticleBodies(out.article, demoteH2Headings(loserArticle))
        }
      }
    }

    for (const h of loser.history) {
      const dup = out.history.find(
        (e) => e.date === h.date && e.title === h.title && e.body.trim() === h.body.trim(),
      )
      if (!dup) out.history.push({ ...h, body: h.body.trim() })
    }
    for (const c of loser.citations ?? []) {
      if (!out.citations.find((x) => x.summaryId === c.summaryId)) {
        out.citations.push(c)
      }
    }
  }
  out.history.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const capped = capSummary(out.currentState)
  out.currentState = capped.kept
  if (capped.overflow) {
    out.history.unshift({
      date: (out.meta.lastVerified ?? new Date().toISOString()).slice(0, 10),
      title: 'Summary overflow (v7 cap)',
      body: capped.overflow,
    })
  }
  const self = out.meta.slug
  const links = extractWikiLinks(`${out.currentState}\n${out.article}`).filter((s) => s !== self)
  out.meta.related = union(out.meta.related, links).filter((s) => s !== self)
  out.seeAlso = union(out.seeAlso, out.meta.related).filter((s) => s !== self)
  return out
}

// ---------------------------------------------------------------------------
// Summary / Article merge helpers (exported for tests + recompile)
// ---------------------------------------------------------------------------

/** Fold delta into standing lead without dropping prior facts. */
export function mergeSummaryText(existing: string, delta: string): string {
  const a = existing.trim()
  const b = delta.trim()
  if (b === '') return a
  if (a === '') return b
  if (a === b) return a
  if (a.includes(b)) return a
  if (b.includes(a) && b.length > a.length) return b
  // Append as new paragraph when not already subsumed.
  return `${a}\n\n${b}`
}

/** Cap lead length; return overflow for History spill. */
export function capSummary(
  text: string,
  maxChars = SUMMARY_MAX_CHARS,
): { kept: string; overflow: string } {
  const t = text.trim()
  if (t.length <= maxChars) return { kept: t, overflow: '' }
  // Keep the definitional start of the lead; spill the tail.
  let cut = maxChars
  const nl = t.lastIndexOf('\n\n', maxChars)
  if (nl > maxChars * 0.5) cut = nl
  return { kept: t.slice(0, cut).trimEnd(), overflow: t.slice(cut).trim() }
}

/**
 * Demote bare `##` headings to `###` outside fences so LLM article bodies
 * that use H2 don't get split out of ## Article by parseWikiPage.
 */
export function demoteH2Headings(markdown: string): string {
  let inFence = false
  return markdown
    .split('\n')
    .map((line) => {
      if (/^```/.test(line.trim())) inFence = !inFence
      // ## Foo → ### Foo  (but not ### already, and not ####)
      if (!inFence && /^## (?!#)/.test(line)) return `#${line}`
      return line
    })
    .join('\n')
}

/** Lean search/embed surface: title + aliases + lead + short article excerpt. */
export function buildWikiSearchText(page: WikiPage): string {
  const art = (page.article || '').trim().slice(0, SEARCH_ARTICLE_EXCERPT_CHARS)
  const related = (page.meta.related || []).join(' ')
  return [page.meta.title, page.meta.aliases.join(' '), page.currentState, art, related]
    .join(' ')
    .slice(0, 8_000)
}

/** Split ## Article body into ### subsections (+ optional lead before first ###). */
export function splitArticleSections(article: string): {
  lead: string
  sections: WikiArticleSection[]
} {
  const text = article.replace(/\r\n/g, '\n')
  const sections: WikiArticleSection[] = []
  let lead = ''
  let heading: string | undefined
  let buf: string[] = []
  let inFence = false
  const flush = (): void => {
    if (heading !== undefined) {
      sections.push({ heading, body: buf.join('\n').trim() })
    } else {
      lead = buf.join('\n').trim()
    }
    buf = []
  }
  for (const line of text.split('\n')) {
    if (/^```/.test(line.trim())) inFence = !inFence
    const m = !inFence ? /^### (.+)$/.exec(line) : null
    if (m) {
      flush()
      heading = m[1].trim()
    } else {
      buf.push(line)
    }
  }
  flush()
  return { lead, sections }
}

export function joinArticleSections(lead: string, sections: WikiArticleSection[]): string {
  const parts: string[] = []
  if (lead.trim()) parts.push(lead.trim())
  for (const s of sections) {
    parts.push(`### ${s.heading}\n\n${s.body.trim()}`)
  }
  return parts.join('\n\n').trim()
}

export function applyArticlePatches(article: string, patches: WikiArticlePatch[]): string {
  const { lead, sections } = splitArticleSections(article)
  for (const p of patches) {
    const heading = p.heading.trim()
    if (!heading) continue
    const body = p.body.trim()
    if (!body) continue
    const idx = sections.findIndex((s) => s.heading.toLowerCase() === heading.toLowerCase())
    if (idx < 0) {
      sections.push({ heading, body })
      continue
    }
    if (p.mode === 'replace') {
      sections[idx] = { heading: sections[idx].heading, body }
    } else {
      const prev = sections[idx].body
      sections[idx] = {
        heading: sections[idx].heading,
        body:
          prev.trim() === '' || prev.includes(body) ? prev || body : `${prev.trim()}\n\n${body}`,
      }
    }
  }
  return joinArticleSections(lead, sections)
}

/** Union subsection bodies by heading name. */
export function mergeArticleBodies(a: string, b: string): string {
  const left = splitArticleSections(a)
  const right = splitArticleSections(b)
  const lead = mergeSummaryText(left.lead, right.lead)
  const map = new Map<string, WikiArticleSection>()
  for (const s of left.sections) map.set(s.heading.toLowerCase(), { ...s })
  for (const s of right.sections) {
    const key = s.heading.toLowerCase()
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { ...s })
    } else if (s.body.trim() && !prev.body.includes(s.body.trim())) {
      map.set(key, {
        heading: prev.heading,
        body:
          prev.body.trim() === ''
            ? s.body.trim()
            : s.body.length > prev.body.length * 1.25
              ? s.body.trim()
              : `${prev.body.trim()}\n\n${s.body.trim()}`,
      })
    }
  }
  return joinArticleSections(lead, [...map.values()])
}

// ---------------------------------------------------------------------------

function normalizeMeta(raw: Record<string, unknown>): WikiFrontmatter {
  const title = raw.title
  const slug = raw.slug
  if (typeof title !== 'string' || title.trim() === '') throw new WikiParseError('title required')
  if (typeof slug !== 'string' || slug.trim() === '') throw new WikiParseError('slug required')
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const KNOWN = new Set([
    'title',
    'slug',
    'aliases',
    'tags',
    'entities',
    'related',
    'last_verified',
    'sources',
  ])
  const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !KNOWN.has(k)))
  return {
    title,
    slug: normalizeSlug(slug),
    aliases: strList(raw.aliases),
    tags: strList(raw.tags),
    entities: strList(raw.entities),
    related: strList(raw.related).map(normalizeSlug).filter(Boolean),
    lastVerified: typeof raw.last_verified === 'string' ? raw.last_verified : undefined,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
    sources: Array.isArray(raw.sources)
      ? raw.sources.filter(
          (s): s is WikiFrontmatter['sources'][number] =>
            typeof s === 'object' && s !== null && Array.isArray((s as { ids?: unknown }).ids),
        )
      : [],
  }
}

interface Section {
  heading: string
  body: string
}

function splitSections(body: string): { preamble: string; sections: Section[] } {
  const sections: Section[] = []
  const pre: string[] = []
  let heading: string | undefined
  let buf: string[] = []
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^```/.test(line.trim())) inFence = !inFence
    const m = !inFence ? /^## (.+)$/.exec(line) : null
    if (m) {
      if (heading !== undefined) sections.push({ heading, body: buf.join('\n') })
      heading = m[1].trim()
      buf = []
    } else if (heading !== undefined) {
      buf.push(line)
    } else {
      pre.push(line)
    }
  }
  if (heading !== undefined) sections.push({ heading, body: buf.join('\n') })
  return { preamble: pre.join('\n'), sections }
}

function parseHistory(body: string): WikiHistoryEntry[] {
  const entries: WikiHistoryEntry[] = []
  let current: WikiHistoryEntry | undefined
  let buf: string[] = []
  const flush = (): void => {
    if (current) entries.push({ ...current, body: buf.join('\n').trim() })
    buf = []
  }
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^```/.test(line.trim())) inFence = !inFence
    const m = !inFence ? HISTORY_HEADING_RE.exec(line) : null
    if (m) {
      flush()
      current = { date: m[1], title: m[2] ?? '', body: '' }
    } else if (current) {
      buf.push(line)
    }
  }
  flush()
  return entries
}

/** Parse ## See also bullets into slugs. */
export function parseSeeAlso(body: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    // - [[slug]] or - [[slug]] — label
    const wiki = /\[\[([a-z0-9-]+)\]\]/i.exec(trimmed)
    if (wiki) {
      const slug = normalizeSlug(wiki[1])
      if (slug && !seen.has(slug)) {
        seen.add(slug)
        out.push(slug)
      }
      continue
    }
    // bare slug bullet
    const bare = /^[-*]\s+([a-z0-9-]+)\s*$/i.exec(trimmed)
    if (bare) {
      const slug = normalizeSlug(bare[1])
      if (slug && !seen.has(slug)) {
        seen.add(slug)
        out.push(slug)
      }
    }
  }
  return out
}

/** Parse markdown citation table or bullet fallback. */
export function parseCitations(body: string): WikiCitation[] {
  const out: WikiCitation[] = []
  const seen = new Set<string>()
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    const table = /^\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]*)\|$/.exec(trimmed)
    if (table) {
      const dateCell = table[1].trim()
      const kindCell = table[2].trim()
      const sumCell = table[3].trim()
      const noteCell = table[4].trim()
      if (/^date$/i.test(dateCell) || /^-+$/.test(dateCell.replace(/\s/g, ''))) continue
      const idMatch = /`([0-9a-f-]{36})`/i.exec(sumCell) ?? /([0-9a-f-]{36})/i.exec(sumCell)
      if (!idMatch) continue
      const summaryId = idMatch[1].toLowerCase()
      if (seen.has(summaryId)) continue
      seen.add(summaryId)
      const date = /^\d{4}-\d{2}-\d{2}$/.test(dateCell) ? dateCell : undefined
      const kind = kindCell && !/^kind$/i.test(kindCell) ? kindCell : undefined
      const note = noteCell || undefined
      out.push({
        summaryId,
        ...(date ? { date } : {}),
        ...(kind ? { kind } : {}),
        ...(note ? { note } : {}),
      })
      continue
    }
    const bullet = /`([0-9a-f-]{36})`/i.exec(trimmed) ?? /\b([0-9a-f-]{36})\b/i.exec(trimmed)
    if (bullet && /^[-*]/.test(trimmed)) {
      const summaryId = bullet[1].toLowerCase()
      if (seen.has(summaryId)) continue
      seen.add(summaryId)
      const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(trimmed)?.[1]
      const kind = /\b(leaf|branch|root)\b/i.exec(trimmed)?.[1]?.toLowerCase()
      const noteMatch = /[—–-]\s+(.+)$/.exec(trimmed)
      out.push({
        summaryId,
        ...(date ? { date } : {}),
        ...(kind ? { kind } : {}),
        ...(noteMatch ? { note: noteMatch[1].trim() } : {}),
      })
    }
  }
  return out
}

function union(...lists: Array<string[] | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    if (!list?.length) continue
    for (const x of list) {
      if (!x || x.trim() === '') continue
      if (seen.has(x)) continue
      seen.add(x)
      out.push(x)
    }
  }
  return out
}
