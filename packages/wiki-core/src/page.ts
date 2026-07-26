/**
 * parse / serialize / applyPatch — pure functions over the page model.
 * Round-trip guarantee: serialize(parse(x)) is stable for well-formed pages;
 * unknown sections are preserved verbatim (forward compatibility).
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  normalizeSlug,
  type WikiCitation,
  type WikiFrontmatter,
  type WikiHistoryEntry,
  type WikiPage,
  type WikiPatch,
} from './model.js'

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/
// Accept em-dash, en-dash, or ASCII hyphen between date and title.
const HISTORY_HEADING_RE = /^### (\d{4}-\d{2}-\d{2})(?:\s+[—–-]\s+(.*))?$/

const CORE_HEADINGS = new Set(['current state', 'history', 'citations'])

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
  const current = sections.find((s) => s.heading.toLowerCase() === 'current state')
  const history = sections.find((s) => s.heading.toLowerCase() === 'history')
  const citationsSec = sections.find((s) => s.heading.toLowerCase() === 'citations')
  const extras = sections.filter((s) => !CORE_HEADINGS.has(s.heading.toLowerCase()))

  return {
    meta,
    currentState: (current?.body ?? '').trim(),
    history: history ? parseHistory(history.body) : [],
    citations: citationsSec ? parseCitations(citationsSec.body) : [],
    ...(preamble.trim() !== '' ? { preamble: preamble.trim() } : {}),
    ...(extras.length > 0
      ? { extraSections: extras.map((s) => ({ heading: s.heading, body: s.body.trim() })) }
      : {}),
  }
}

export function serializeWikiPage(page: WikiPage): string {
  const meta: Record<string, unknown> = {
    ...(page.meta.extra ?? {}),
    title: page.meta.title,
    slug: page.meta.slug,
    aliases: page.meta.aliases,
    tags: page.meta.tags,
    entities: page.meta.entities,
    ...(page.meta.lastVerified ? { last_verified: page.meta.lastVerified } : {}),
    sources: page.meta.sources,
  }
  const history = page.history
    .map((h) => `### ${h.date}${h.title ? ` — ${h.title}` : ''}\n\n${h.body.trim()}\n`)
    .join('\n')
  const citations = page.citations ?? []
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

  return [
    `---\n${stringifyYaml(meta).trimEnd()}\n---`,
    ...(page.preamble ? ['', page.preamble] : []),
    '',
    '## Current state',
    '',
    page.currentState.trim(),
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
 * Current state with different content and carries no explicit history
 * entry covering it, the PRIOR state is archived as a dated entry first —
 * human edits included, nothing is silently lost.
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
          sources: [],
        },
        currentState: '',
        history: [],
        citations: [],
      }

  // Older pages parsed before citations field — normalize.
  if (!page.citations) page.citations = []

  if (patch.title) page.meta.title = patch.title
  page.meta.aliases = union(page.meta.aliases, patch.addAliases)
  page.meta.tags = union(page.meta.tags, patch.addTags)
  page.meta.entities = union(page.meta.entities, patch.addEntities)
  page.meta.lastVerified = patch.verifiedAt
  for (const src of patch.addSources ?? []) {
    const key = (x: { ids: string[] }): string => JSON.stringify([...x.ids].sort())
    const dup = page.meta.sources.find((s) => s.kind === src.kind && key(s) === key(src))
    if (!dup) page.meta.sources.push(src)
  }

  if (patch.currentState !== undefined && patch.currentState.trim() !== page.currentState.trim()) {
    if (page.currentState.trim() !== '') {
      page.history.unshift({
        date: patch.verifiedAt.slice(0, 10),
        title: 'Superseded current state',
        body: page.currentState.trim(),
      })
    }
    page.currentState = patch.currentState.trim()
  }

  if (patch.historyEntry) {
    const h = patch.historyEntry
    const dup = page.history.find(
      (e) => e.date === h.date && e.title === h.title && e.body.trim() === h.body.trim(),
    )
    if (!dup) page.history.unshift({ ...h, body: h.body.trim() })
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

  return page
}

/**
 * Merge loser pages into a canonical durable topic (consolidation).
 * Keeps canonical current_state if non-empty; otherwise takes the longest
 * loser state. Unions meta; prepends loser history + citations (deduped).
 */
export function mergePages(canonical: WikiPage, losers: WikiPage[]): WikiPage {
  const out: WikiPage = structuredClone(canonical)
  if (!out.citations) out.citations = []
  for (const loser of losers) {
    if (loser.meta.slug === out.meta.slug) continue
    out.meta.aliases = union(out.meta.aliases, [
      loser.meta.slug,
      ...loser.meta.aliases,
      loser.meta.title,
    ])
    out.meta.tags = union(out.meta.tags, loser.meta.tags)
    out.meta.entities = union(out.meta.entities, loser.meta.entities)
    for (const src of loser.meta.sources) {
      const key = (x: { ids: string[] }): string => JSON.stringify([...x.ids].sort())
      const dup = out.meta.sources.find((s) => s.kind === src.kind && key(s) === key(src))
      if (!dup) out.meta.sources.push(src)
    }
    if (out.currentState.trim() === '' && loser.currentState.trim() !== '') {
      out.currentState = loser.currentState.trim()
    } else if (
      loser.currentState.trim() !== '' &&
      loser.currentState.trim() !== out.currentState.trim() &&
      loser.currentState.length > out.currentState.length * 1.25
    ) {
      // Prefer richer standing state when clearly denser; archive the prior.
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
  // History: newest first by date string (YYYY-MM-DD sorts lexically).
  out.history.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return out
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

/** Parse markdown citation table or bullet fallback. */
export function parseCitations(body: string): WikiCitation[] {
  const out: WikiCitation[] = []
  const seen = new Set<string>()
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    // Table row: | date | kind | `uuid` | note |
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
    // Bullet: - `uuid` — note  or  - uuid (leaf, 2026-07-25)
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

function union(base: string[], add?: string[]): string[] {
  if (!add?.length) return base
  return [...new Set([...base, ...add.filter((x) => x && x.trim() !== '')])]
}
