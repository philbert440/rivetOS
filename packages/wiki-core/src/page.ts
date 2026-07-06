/**
 * parse / serialize / applyPatch — pure functions over the page model.
 * Round-trip guarantee: serialize(parse(x)) is stable for well-formed pages;
 * unknown sections are preserved verbatim (forward compatibility).
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  normalizeSlug,
  type WikiFrontmatter,
  type WikiHistoryEntry,
  type WikiPage,
  type WikiPatch,
} from './model.js'

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/
const HISTORY_HEADING_RE = /^### (\d{4}-\d{2}-\d{2})(?:\s+—\s+(.*))?$/

export class WikiParseError extends Error {
  constructor(detail: string) {
    super(`invalid wiki page: ${detail}`)
    this.name = 'WikiParseError'
  }
}

export function parseWikiPage(markdown: string): WikiPage {
  const fm = FRONTMATTER_RE.exec(markdown)
  if (!fm) throw new WikiParseError('missing YAML frontmatter')
  const rawMeta = parseYaml(fm[1]) as Record<string, unknown> | null
  if (!rawMeta || typeof rawMeta !== 'object') throw new WikiParseError('frontmatter not a map')
  const meta = normalizeMeta(rawMeta)

  const body = markdown.slice(fm[0].length)
  const sections = splitSections(body)
  const current = sections.find((s) => s.heading.toLowerCase() === 'current state')
  const history = sections.find((s) => s.heading.toLowerCase() === 'history')

  return {
    meta,
    currentState: (current?.body ?? '').trim(),
    history: history ? parseHistory(history.body) : [],
  }
}

export function serializeWikiPage(page: WikiPage): string {
  const meta: Record<string, unknown> = {
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
  return [
    `---\n${stringifyYaml(meta).trimEnd()}\n---`,
    '',
    '## Current state',
    '',
    page.currentState.trim(),
    '',
    '## History',
    '',
    history.trimEnd(),
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
      }

  if (patch.title) page.meta.title = patch.title
  page.meta.aliases = union(page.meta.aliases, patch.addAliases)
  page.meta.tags = union(page.meta.tags, patch.addTags)
  page.meta.entities = union(page.meta.entities, patch.addEntities)
  page.meta.lastVerified = patch.verifiedAt
  for (const src of patch.addSources ?? []) {
    const dup = page.meta.sources.find(
      (s) => s.kind === src.kind && s.ids.join(',') === src.ids.join(','),
    )
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

  return page
}

// ---------------------------------------------------------------------------

function normalizeMeta(raw: Record<string, unknown>): WikiFrontmatter {
  const title = raw.title
  const slug = raw.slug
  if (typeof title !== 'string' || title.trim() === '') throw new WikiParseError('title required')
  if (typeof slug !== 'string' || slug.trim() === '') throw new WikiParseError('slug required')
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    title,
    slug: normalizeSlug(slug),
    aliases: strList(raw.aliases),
    tags: strList(raw.tags),
    entities: strList(raw.entities),
    lastVerified: typeof raw.last_verified === 'string' ? raw.last_verified : undefined,
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

function splitSections(body: string): Section[] {
  const sections: Section[] = []
  let heading: string | undefined
  let buf: string[] = []
  for (const line of body.split('\n')) {
    const m = /^## (.+)$/.exec(line)
    if (m) {
      if (heading !== undefined) sections.push({ heading, body: buf.join('\n') })
      heading = m[1].trim()
      buf = []
    } else if (heading !== undefined) {
      buf.push(line)
    }
  }
  if (heading !== undefined) sections.push({ heading, body: buf.join('\n') })
  return sections
}

function parseHistory(body: string): WikiHistoryEntry[] {
  const entries: WikiHistoryEntry[] = []
  let current: WikiHistoryEntry | undefined
  let buf: string[] = []
  const flush = (): void => {
    if (current) entries.push({ ...current, body: buf.join('\n').trim() })
    buf = []
  }
  for (const line of body.split('\n')) {
    const m = HISTORY_HEADING_RE.exec(line)
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

function union(base: string[], add?: string[]): string[] {
  if (!add?.length) return base
  return [...new Set([...base, ...add])]
}
