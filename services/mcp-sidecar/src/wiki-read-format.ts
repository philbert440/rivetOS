/**
 * Bound wiki_read output so MCP/capture truncation cannot hide Summary
 * behind a megabyte of YAML aliases.
 *
 * Live failure (2026-08-21): topics/rivetos.md ~3.8 MB / 67k lines, ~2500
 * aliases in frontmatter. wiki_read served the file verbatim; the alias
 * dump occupied the entire truncated MCP payload, so agents never saw
 * Summary, Article, or History.
 *
 * Small pages stay verbatim. Oversized pages get a compact encyclopedia
 * view (lead + article + recent history). `section=` requests a slice.
 */

import { parseWikiPage, type WikiPage } from '@rivetos/wiki-core'

/** Raw file is returned as-is at or below this character count. */
export const WIKI_READ_VERBATIM_MAX_CHARS = 24_000

export const WIKI_READ_SECTIONS = [
  'summary',
  'article',
  'history',
  'aliases',
  'citations',
  'full',
] as const

export type WikiReadSection = (typeof WIKI_READ_SECTIONS)[number]

const DEFAULT_ARTICLE_CHARS = 8_000
const SECTION_ARTICLE_CHARS = 24_000
const DEFAULT_HISTORY = 6
const SECTION_HISTORY = 20
const HISTORY_BODY_CHARS = 500
const DEFAULT_ALIASES = 8
const SECTION_ALIASES = 200
const DEFAULT_SEE_ALSO = 24
const DEFAULT_CITATIONS = 8
const SECTION_CITATIONS = 40
const DEFAULT_TAGS = 16
const MALFORMED_RAW_CHARS = 8_000

export function formatWikiRead(
  markdown: string,
  opts: { slug: string; section?: WikiReadSection },
): string {
  const { slug, section } = opts
  let page: WikiPage
  try {
    page = parseWikiPage(markdown)
  } catch (err: unknown) {
    return formatMalformed(markdown, slug, err)
  }

  const oversized = markdown.length > WIKI_READ_VERBATIM_MAX_CHARS

  if (section === 'full') {
    if (!oversized) return markdown
    return [
      refuseFullBanner(page, markdown, slug),
      '',
      formatEncyclopedia(page, markdown, slug, { skipBanner: true }),
    ].join('\n')
  }

  if (!section && !oversized) return markdown

  switch (section) {
    case 'summary':
      return formatSummarySlice(page, markdown, slug)
    case 'article':
      return formatArticleSlice(page, markdown, slug)
    case 'history':
      return formatHistorySlice(page, markdown, slug)
    case 'aliases':
      return formatAliasesSlice(page, markdown, slug)
    case 'citations':
      return formatCitationsSlice(page, markdown, slug)
    default:
      return formatEncyclopedia(page, markdown, slug)
  }
}

function formatMalformed(markdown: string, slug: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const header =
    `⚠ Page "${slug}" is malformed (${msg}) — raw content follows; ` +
    'the next extractor pass will re-structure it.'
  if (markdown.length <= WIKI_READ_VERBATIM_MAX_CHARS) {
    return `${header}\n\n${markdown}`
  }
  return [
    header,
    `Page is also oversized (${fmtCount(markdown.length)} chars); showing the first ${fmtCount(MALFORMED_RAW_CHARS)}.`,
    '',
    capText(markdown, MALFORMED_RAW_CHARS, `wiki_read slug=${slug} after the next extractor pass`),
  ].join('\n')
}

function formatEncyclopedia(
  page: WikiPage,
  markdown: string,
  slug: string,
  opts: { skipBanner?: boolean } = {},
): string {
  const parts: string[] = []
  if (!opts.skipBanner) parts.push(oversizedBanner(page, markdown, slug))
  parts.push(compactHeader(page))
  parts.push('')
  parts.push('## Summary')
  parts.push('')
  parts.push(page.currentState.trim() || '(empty)')
  const article = page.article.trim()
  if (article) {
    parts.push('')
    parts.push('## Article')
    parts.push('')
    parts.push(capText(article, DEFAULT_ARTICLE_CHARS, `wiki_read slug=${slug} section=article`))
  }
  const seeAlso = unique(page.seeAlso)
  if (seeAlso.length > 0) {
    parts.push('')
    parts.push('## See also')
    parts.push('')
    parts.push(
      listPreview(
        seeAlso,
        DEFAULT_SEE_ALSO,
        (s) => `- [[${s}]]`,
        `wiki_read slug=${slug} (see-also is not a slice; pick a linked slug)`,
      ),
    )
  }
  parts.push('')
  parts.push(
    `## Recent history (${Math.min(DEFAULT_HISTORY, page.history.length)} of ${fmtCount(page.history.length)})`,
  )
  parts.push('')
  parts.push(formatHistoryEntries(page, DEFAULT_HISTORY, slug))
  if (page.citations.length > 0) {
    parts.push('')
    parts.push(
      `## Citations (${Math.min(DEFAULT_CITATIONS, page.citations.length)} of ${fmtCount(page.citations.length)})`,
    )
    parts.push('')
    parts.push(formatCitationTable(page, DEFAULT_CITATIONS, slug))
  }
  parts.push('')
  parts.push(
    `Use section=summary|article|history|aliases|citations for a slice. section=full is refused while the page exceeds ${fmtCount(WIKI_READ_VERBATIM_MAX_CHARS)} characters.`,
  )
  return parts.join('\n')
}

function formatSummarySlice(page: WikiPage, markdown: string, slug: string): string {
  return [
    sliceBanner(page, markdown, slug, 'summary'),
    compactHeader(page),
    '',
    '## Summary',
    '',
    page.currentState.trim() || '(empty)',
  ].join('\n')
}

function formatArticleSlice(page: WikiPage, markdown: string, slug: string): string {
  const article = page.article.trim() || '(empty)'
  return [
    sliceBanner(page, markdown, slug, 'article'),
    compactHeader(page),
    '',
    '## Article',
    '',
    capText(
      article,
      SECTION_ARTICLE_CHARS,
      `wiki_read slug=${slug} section=article (still truncated)`,
    ),
  ].join('\n')
}

function formatHistorySlice(page: WikiPage, markdown: string, slug: string): string {
  return [
    sliceBanner(page, markdown, slug, 'history'),
    compactHeader(page),
    '',
    `## History (${Math.min(SECTION_HISTORY, page.history.length)} of ${fmtCount(page.history.length)}, newest first)`,
    '',
    formatHistoryEntries(page, SECTION_HISTORY, slug),
  ].join('\n')
}

function formatAliasesSlice(page: WikiPage, markdown: string, slug: string): string {
  const aliases = page.meta.aliases
  return [
    sliceBanner(page, markdown, slug, 'aliases'),
    compactHeader(page, { omitAliasPreview: true }),
    '',
    `## Aliases (${Math.min(SECTION_ALIASES, aliases.length)} of ${fmtCount(aliases.length)})`,
    '',
    aliases.length === 0
      ? '(none)'
      : listPreview(
          aliases,
          SECTION_ALIASES,
          (s) => `- ${s}`,
          `wiki_read slug=${slug} section=aliases (first ${fmtCount(SECTION_ALIASES)} only)`,
        ),
  ].join('\n')
}

function formatCitationsSlice(page: WikiPage, markdown: string, slug: string): string {
  return [
    sliceBanner(page, markdown, slug, 'citations'),
    compactHeader(page),
    '',
    `## Citations (${Math.min(SECTION_CITATIONS, page.citations.length)} of ${fmtCount(page.citations.length)})`,
    '',
    formatCitationTable(page, SECTION_CITATIONS, slug),
  ].join('\n')
}

function oversizedBanner(page: WikiPage, markdown: string, slug: string): string {
  return [
    `⚠ Oversized wiki page "${slug}" (${pageStats(page, markdown)}).`,
    'The raw file leads with YAML aliases, so MCP/capture truncation hid Summary and Article.',
    'Showing the encyclopedia view (lead + article + recent history), not the raw file.',
    '',
  ].join('\n')
}

function sliceBanner(page: WikiPage, markdown: string, slug: string, section: string): string {
  const prefix =
    markdown.length > WIKI_READ_VERBATIM_MAX_CHARS
      ? `⚠ Oversized wiki page "${slug}" (${pageStats(page, markdown)}). `
      : ''
  return `${prefix}section=${section}\n`
}

function refuseFullBanner(page: WikiPage, markdown: string, slug: string): string {
  return [
    `section=full refused for "${slug}": page is ${pageStats(page, markdown)} (limit ${fmtCount(WIKI_READ_VERBATIM_MAX_CHARS)} characters).`,
    'Dumping the raw file would truncate in MCP/capture before Summary.',
    'Encyclopedia view follows. Slice with section=summary|article|history|aliases|citations.',
  ].join('\n')
}

function pageStats(page: WikiPage, markdown: string): string {
  const kb = (markdown.length / 1024).toFixed(1)
  return `${kb} KB · ${fmtCount(page.meta.aliases.length)} aliases · ${fmtCount(page.history.length)} history · ${fmtCount(page.citations.length)} citations · ${fmtCount(page.seeAlso.length)} see-also`
}

function compactHeader(page: WikiPage, opts: { omitAliasPreview?: boolean } = {}): string {
  const tags = page.meta.tags.slice(0, DEFAULT_TAGS)
  const tagExtra =
    page.meta.tags.length > DEFAULT_TAGS ? ` (+${page.meta.tags.length - DEFAULT_TAGS})` : ''
  const aliasLine = opts.omitAliasPreview
    ? `aliases_count: ${fmtCount(page.meta.aliases.length)}`
    : `aliases: ${aliasPreview(page.meta.aliases)}`
  const lines = [
    '---',
    `title: ${page.meta.title}`,
    `slug: ${page.meta.slug}`,
    ...(page.meta.lastVerified ? [`last_verified: ${page.meta.lastVerified}`] : []),
    ...(tags.length > 0 ? [`tags: ${tags.join(', ')}${tagExtra}`] : []),
    aliasLine,
    '---',
  ]
  return lines.join('\n')
}

function aliasPreview(aliases: string[]): string {
  if (aliases.length === 0) return '0'
  const shown = aliases.slice(0, DEFAULT_ALIASES).join(', ')
  if (aliases.length <= DEFAULT_ALIASES) return `${fmtCount(aliases.length)} (${shown})`
  return `${fmtCount(aliases.length)} (showing ${DEFAULT_ALIASES}: ${shown}) — section=aliases`
}

function formatHistoryEntries(page: WikiPage, keep: number, slug: string): string {
  if (page.history.length === 0) return '(none yet)'
  const entries = page.history.slice(0, keep)
  const blocks = entries.map((h) => {
    const heading = `### ${h.date}${h.title ? ` — ${h.title}` : ''}`
    const body = capText(
      h.body.trim() || '(empty)',
      HISTORY_BODY_CHARS,
      `wiki_read slug=${slug} section=history`,
    )
    return `${heading}\n\n${body}`
  })
  const extra =
    page.history.length > keep
      ? `\n\n…[${fmtCount(page.history.length - keep)} older entries — wiki_read slug=${slug} section=history]`
      : ''
  return blocks.join('\n\n') + extra
}

function formatCitationTable(page: WikiPage, keep: number, slug: string): string {
  if (page.citations.length === 0) return '(none)'
  const rows = page.citations.slice(0, keep).map((c) => {
    const date = c.date ?? ''
    const kind = c.kind ?? 'leaf'
    const note = (c.note ?? '').replace(/\|/g, '\\|')
    return `| ${date} | ${kind} | \`${c.summaryId}\` | ${note} |`
  })
  const extra =
    page.citations.length > keep
      ? `\n…[${fmtCount(page.citations.length - keep)} more — wiki_read slug=${slug} section=citations]`
      : ''
  return (
    ['| Date | Kind | Summary | Note |', '|------|------|---------|------|', ...rows].join('\n') +
    extra
  )
}

function listPreview(
  items: string[],
  keep: number,
  render: (item: string) => string,
  moreHint: string,
): string {
  const shown = items.slice(0, keep).map(render)
  const extra =
    items.length > keep ? `\n…[${fmtCount(items.length - keep)} more — ${moreHint}]` : ''
  return shown.join('\n') + extra
}

function capText(text: string, max: number, hint: string): string {
  if (text.length <= max) return text
  let cut = max
  const nl = text.lastIndexOf('\n\n', max)
  if (nl > max * 0.5) cut = nl
  const kept = text.slice(0, cut).trimEnd()
  return `${kept}\n\n…[${fmtCount(text.length - kept.length)} more chars — ${hint}]`
}

function unique(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US')
}
