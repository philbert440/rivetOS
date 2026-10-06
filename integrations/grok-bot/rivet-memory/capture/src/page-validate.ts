/**
 * ReadTranscript page inspection for ingest-pages / needs.
 * Files are never written. A rejected page leaves its header range as gaps.
 */
import { readFileSync } from 'node:fs'
import { parsePageHeader } from './parse.js'
import type { PageHeader, ParsedInput } from './types.js'

export interface PageFileRef {
  path: string
  slug: string
  before: number
}

const PAGE_FOOTER_RE = /Older messages remain:.*before=(\d+)/

export type PageRejectCode =
  'missing_header' | 'range_mismatch' | 'json_parse' | 'total_mismatch' | 'agent_id_mismatch'

export interface PageInspectError {
  code: PageRejectCode
  detail: string
}

export interface InspectedPage {
  file: PageFileRef
  header?: PageHeader
  records: unknown[]
  sourceLines: number[]
  hasOlderFooter: boolean
  error?: PageInspectError
  ok: boolean
  reason?: string
  skippedPositions: number[]
}

export function headerPositions(header: PageHeader): number[] {
  const out: number[] = []
  for (let p = header.a; p <= header.b; p++) out.push(p)
  return out
}

export function collapseRanges(positions: number[]): Array<[number, number]> {
  const sorted = [...new Set(positions)].sort((a, b) => a - b)
  if (sorted.length === 0) return []
  const ranges: Array<[number, number]> = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i]
    if (p === prev + 1) {
      prev = p
      continue
    }
    ranges.push([start, prev])
    start = p
    prev = p
  }
  ranges.push([start, prev])
  return ranges
}

export function formatGapRange(positions: number[]): string {
  return collapseRanges(positions)
    .map(([a, b]) => `${String(a)}-${String(b)}`)
    .join(', ')
}

export function formatNeedsLine(slug: string, a: number, b: number): string {
  return `needs: ${slug} positions ${String(a)}-${String(b)}`
}

function skippedPositionsFor(header: PageHeader | undefined): number[] {
  if (!header || header.a > header.b) return []
  return headerPositions(header)
}

function withReason(
  page: Omit<InspectedPage, 'ok' | 'reason'> & { error: PageInspectError },
): InspectedPage {
  const skipped = skippedPositionsFor(page.header)
  const gaps = skipped.length ? ` (positions ${formatGapRange(skipped)} left as gaps)` : ''
  return {
    ...page,
    ok: false,
    reason: `${page.error.detail}${gaps}`,
    skippedPositions: skipped,
  }
}

export function inspectPageText(text: string): {
  header?: PageHeader
  records: unknown[]
  sourceLines: number[]
  hasOlderFooter: boolean
  error?: PageInspectError
} {
  let header: PageHeader | undefined
  const records: unknown[] = []
  const sourceLines: number[] = []
  let hasOlderFooter = false
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const hdr = parsePageHeader(line)
    if (hdr && !header) {
      header = hdr
      continue
    }
    if (PAGE_FOOTER_RE.test(line) && !line.startsWith('{')) {
      hasOlderFooter = true
      continue
    }
    if (line.startsWith('{')) {
      try {
        records.push(JSON.parse(line) as unknown)
        sourceLines.push(i)
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'JSON.parse failed'
        return {
          header,
          records,
          sourceLines,
          hasOlderFooter,
          error: {
            code: 'json_parse',
            detail: `JSON parse error on line ${String(i + 1)}: ${detail}`,
          },
        }
      }
    }
  }
  if (!header) {
    return {
      records,
      sourceLines,
      hasOlderFooter,
      error: {
        code: 'missing_header',
        detail: 'ReadTranscript page is missing a "Transcript of ... positions A–B of N:" header',
      },
    }
  }
  if (header.a > header.b) {
    return {
      header,
      records,
      sourceLines,
      hasOlderFooter,
      error: {
        code: 'range_mismatch',
        detail: `header range ${String(header.a)}–${String(header.b)} is empty or reversed`,
      },
    }
  }
  if (header.a < 0 || header.a >= header.total || header.b >= header.total) {
    return {
      header,
      records,
      sourceLines,
      hasOlderFooter,
      error: {
        code: 'range_mismatch',
        detail: `header range ${String(header.a)}–${String(header.b)} of ${String(header.total)} is out of bounds`,
      },
    }
  }
  const expected = header.b - header.a + 1
  if (expected !== records.length) {
    return {
      header,
      records,
      sourceLines,
      hasOlderFooter,
      error: {
        code: 'range_mismatch',
        detail:
          `header range ${String(header.a)}–${String(header.b)} does not match ${String(records.length)} ` +
          `JSON line${records.length === 1 ? '' : 's'}`,
      },
    }
  }
  return { header, records, sourceLines, hasOlderFooter }
}

export function inspectPageFile(file: PageFileRef): InspectedPage {
  const raw = inspectPageText(readFileSync(file.path, 'utf8'))
  if (raw.error) {
    return withReason({ file, ...raw, error: raw.error, skippedPositions: [] })
  }
  return {
    file,
    header: raw.header,
    records: raw.records,
    sourceLines: raw.sourceLines,
    hasOlderFooter: raw.hasOlderFooter,
    ok: true,
    skippedPositions: [],
  }
}

export function inspectPageFiles(files: PageFileRef[]): InspectedPage[] {
  return files.map((file) => inspectPageFile(file))
}

/**
 * Live-spool consensus: current total is the max header.total among
 * range-valid pages; agent id is the newest page that named one.
 * Older leftover pages with a smaller total, or a page for a different
 * agent id, are skipped. Backfill dumps keep mixed totals (no consensus).
 */
export function applySpoolConsensus(
  pages: InspectedPage[],
  opts?: { live?: boolean },
): InspectedPage[] {
  if (!opts?.live) return pages
  const okPages = pages.filter((page) => page.ok && page.header)
  if (okPages.length === 0) return pages
  let canonicalTotal = -1
  for (const page of okPages) {
    const total = page.header?.total ?? -1
    if (total > canonicalTotal) canonicalTotal = total
  }
  const byNewest = [...okPages].sort((a, b) => {
    const before = b.file.before - a.file.before
    if (before !== 0) return before
    return (b.header?.a ?? 0) - (a.header?.a ?? 0)
  })
  const canonicalId = byNewest.find((page) => page.header?.id)?.header?.id
  return pages.map((page) => {
    if (!page.ok || !page.header) return page
    if (page.header.total !== canonicalTotal) {
      return withReason({
        ...page,
        error: {
          code: 'total_mismatch',
          detail: `header total ${String(page.header.total)} does not match spool total ${String(canonicalTotal)}`,
        },
      })
    }
    if (canonicalId && page.header.id && page.header.id !== canonicalId) {
      return withReason({
        ...page,
        error: {
          code: 'agent_id_mismatch',
          detail: 'header agent id does not match the other pages in this spool',
        },
      })
    }
    return page
  })
}

export function toParsedInput(page: InspectedPage): ParsedInput | undefined {
  if (!page.ok || !page.header) return undefined
  return {
    format: 'page',
    header: page.header,
    records: page.records,
    hasOlderFooter: page.hasOlderFooter,
    sourceLines: page.sourceLines,
    sourcePath: page.file.path,
  }
}

export function coveredPositions(pages: InspectedPage[]): Set<number> {
  const set = new Set<number>()
  for (const page of pages) {
    if (!page.ok || !page.header) continue
    for (const pos of headerPositions(page.header)) set.add(pos)
  }
  return set
}

export function skippedGapPositions(pages: InspectedPage[]): number[] {
  const set = new Set<number>()
  for (const page of pages) {
    if (page.ok) continue
    for (const pos of page.skippedPositions) set.add(pos)
  }
  return [...set].sort((a, b) => a - b)
}

export function neededPositions(opts: {
  covered: Set<number>
  lastIngestedPosition: number | null
  total: number
  extraGaps?: number[]
}): number[] {
  const from = opts.lastIngestedPosition == null ? 0 : opts.lastIngestedPosition + 1
  const want = new Set<number>()
  for (let p = from; p < opts.total; p++) {
    if (!opts.covered.has(p)) want.add(p)
  }
  for (const p of opts.extraGaps ?? []) {
    if (p >= 0 && p < opts.total && !opts.covered.has(p)) want.add(p)
  }
  return [...want].sort((a, b) => a - b)
}

export function formatNeedsLines(slug: string, positions: number[]): string[] {
  return collapseRanges(positions).map(([a, b]) => formatNeedsLine(slug, a, b))
}
