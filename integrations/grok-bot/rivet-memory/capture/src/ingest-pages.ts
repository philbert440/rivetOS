/**
 * ReadTranscript page backfill → <session>-v4-backfill.
 *
 * Pages are dumped as <bot-slug>-<before>.txt. Positions are conversation
 * indices, not store.db seq. Timestamps come only from user `<timestamp>`
 * tags (any UTC offset) and are carried forward, including tags that sat on
 * a record the normalizer later dropped. Rows before the first parsable tag
 * are skipped and never stamped with the backfill run's wall clock. Every
 * kept row is marked ts_approx=true. Hidden system / agent wakes follow the
 * v4 normalizer, then system rows are dropped from this tag. Nothing is
 * folded into plain -v4.
 *
 * Overlap suppression is time-relative to the candidate rows. A hash+time
 * match is dropped only when an adjacent candidate is also a tentative
 * match (a run). A lone match is inserted: a duplicate is tolerable, a
 * missed row is not. `--overlap-hours 0` disables -v4 hash suppression.
 * source_id idempotence stays on for the exact `:<position>:<sub>` id.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CaptureMessage } from '@rivetos/capture-core'
import pg from 'pg'
import {
  discoverModels,
  identityForSlug,
  loadIdentityConfig,
  personaSlugFromIdentity,
  type DiscoverResult,
} from './identity.js'
import type { GrokbotIngestInput, GrokbotIngestResult } from './ingest-rows.js'
import { clampCreatedAt, toIngestRows, type TimeClock } from './normalize.js'
import { normalizePages } from './pages.js'
import { parseInput, partText, recordParts, recordRole } from './parse.js'
import { READONLY_POOL_OPTIONS, wrapReadOnlyClient } from './pg-readonly.js'
import { extractTimestampTag } from './timestamps.js'
import {
  DEFAULT_BACKFILL_OVERLAP_HOURS,
  ORDINAL_STRIDE,
  SESSION_SUFFIX_V4,
  type BotIdentity,
  type ParsedInput,
} from './types.js'

export const PAGE_FILE_RE = /^(.+)-(\d+)\.txt$/i
export const BACKFILL_SOURCE = 'grokbot-readtranscript-backfill'

/**
 * Live `-v4` `created_at` is the real clock; backfill times are the last user
 * tag, carried forward across the turn (then bumped 1ms so they stay ordered).
 * 60 minutes covers one long tool-using turn — a live row can land well after
 * its tag — without treating the same short text from a previous day as the
 * same occurrence. `--overlap-hours 0` turns hash suppression off entirely.
 * An isolated match inside that window is still inserted; only a run of
 * adjacent tentative matches is suppressed.
 */
export const OVERLAP_TIME_TOLERANCE_MS = 60 * 60 * 1000

export interface PageSpoolFile {
  path: string
  slug: string
  before: number
}

export interface OverlapRow {
  role: string
  content: string
  tool_name?: string | null
  tool_args?: unknown
  tool_result?: string | null
  created_at?: string | Date | null
  metadata?: Record<string, unknown> | null
}

/** One stored backfill idempotence key, plus its content digest when present. */
export interface StoredSourceId {
  sourceId: string
  /** Absent when the stored row has no `metadata.content_hash`. */
  contentHash?: string
}

export interface OverlapStore {
  newestCreatedAt(sessionKey: string, agent: string): Promise<Date | undefined>
  /**
   * `since` / `until` bound `created_at` when set. The backfill source-id
   * fallback calls this with neither bound.
   */
  rowsSince(sessionKey: string, agent: string, since?: Date, until?: Date): Promise<OverlapRow[]>
  /** Distinct backfill source ids and digests. Preferred over `rowsSince`. */
  sourceIds?(sessionKey: string, agent: string): Promise<StoredSourceId[]>
  close?: () => Promise<void>
}

export interface V4OverlapHit {
  hash: string
  createdAtMs: number
}

export interface OverlapIndex {
  /**
   * Exact `readtranscript:<slug>:<position>:<sub>` ids. The value is the
   * stored content digest, or `undefined` when that row has none (treat as
   * the same content). Legacy ids without `:<sub>` are not keys that match.
   */
  sourceIds: Map<string, string | undefined>
  /** -v4 rows inside the candidate-relative overlap window. */
  v4Hits: V4OverlapHit[]
}

export interface IngestPagesCounts {
  slug: string
  session: string
  agent: string
  pages: number
  entriesParsed: number
  droppedSystem: number
  skippedNoTimestamp: number
  skippedNoPosition: number
  skippedOverlap: number
  /** Existing source id whose stored digest differs. Not written. */
  skippedChanged: number
  new: number
  conflicts: number[]
  pagesFailed: number
  unknownSlugs: number
}

export interface IngestPagesResult {
  dryRun: boolean
  bots: IngestPagesCounts[]
  wrote: boolean
  /** Set when this run had no overlap store because RIVETOS_PG_URL was unset. */
  overlapUnavailable?: boolean
}

export interface IngestPagesDeps {
  overlap?: OverlapStore
  commit?: (input: GrokbotIngestInput) => Promise<GrokbotIngestResult>
  discover?: (opts?: { agentsDir?: string }) => DiscoverResult
  /** Set when --commit was requested but no writer could be built. */
  commitError?: string
  overlapUnavailable?: boolean
}

export function parsePageFileName(name: string): { slug: string; before: number } | undefined {
  const m = PAGE_FILE_RE.exec(basename(name))
  if (!m) return undefined
  return { slug: m[1], before: Number(m[2]) }
}

/**
 * Numeric `<before>` first, then the page header position, then path.
 * Filename order is wrong: `alpha-1000.txt` sorts before `alpha-999.txt`.
 */
export function compareParsedPages(
  a: { before: number; path: string; headerA?: number },
  b: { before: number; path: string; headerA?: number },
): number {
  const before = a.before - b.before
  if (before !== 0) return before
  const header = (a.headerA ?? 0) - (b.headerA ?? 0)
  if (header !== 0) return header
  return a.path.localeCompare(b.path)
}

export function listPageSpoolFiles(dir: string): PageSpoolFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: PageSpoolFile[] = []
  for (const name of names) {
    const parsed = parsePageFileName(name)
    if (!parsed) continue
    const full = join(dir, name)
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    out.push({ path: full, slug: parsed.slug, before: parsed.before })
  }
  out.sort((a, b) => compareParsedPages(a, b))
  return out
}

export function backfillSession(sessionBase: string, liveSuffix = SESSION_SUFFIX_V4): string {
  const suffix = `${liveSuffix}-backfill`
  return sessionBase.endsWith(suffix) ? sessionBase : `${sessionBase}${suffix}`
}

export function liveV4Session(sessionBase: string, liveSuffix = SESSION_SUFFIX_V4): string {
  return sessionBase.endsWith(liveSuffix) ? sessionBase : `${sessionBase}${liveSuffix}`
}

/**
 * Stored ids are `readtranscript:<slug>:<position>:<sub>`. Omit `sub` only
 * to build the historical two-part string; idempotence does not honor it.
 */
export function backfillSourceId(slug: string, position: number, sub?: number): string {
  const base = `readtranscript:${slug}:${String(position)}`
  return sub === undefined ? base : `${base}:${String(sub)}`
}

/** Stable JSON: object keys sorted, undefined keys omitted, array holes as null. */
export function canonicalJson(value: unknown): string {
  const encoded = canonicalJsonValue(value)
  return encoded ?? ''
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalJsonValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!isJsonObject(value) && !Array.isArray(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonValue(item) ?? 'null').join(',')}]`
  }
  const parts: string[] = []
  for (const key of Object.keys(value).sort()) {
    const encoded = canonicalJsonValue(value[key])
    if (encoded === undefined) continue
    parts.push(`${JSON.stringify(key)}:${encoded}`)
  }
  return `{${parts.join(',')}}`
}

function sha256(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

function toolArgsField(toolArgs: unknown): string {
  if (toolArgs === undefined) return ''
  return canonicalJson(toolArgs)
}

/**
 * Hash used to compare a backfill row with a stored `-v4` row.
 * Assistant tool rows ignore `content`: the tool-synthesis worker rewrites
 * that field, and JSONB may reorder `tool_args` keys.
 */
export function contentHashForRow(row: {
  role: string
  content: string
  toolName?: string | null
  toolArgs?: unknown
  toolResult?: string | null
}): string {
  const toolName = row.toolName ?? ''
  const args = toolArgsField(row.toolArgs)
  if (row.role === 'assistant' && toolName) {
    return sha256([row.role, toolName, args].join('\0'))
  }
  const content = row.content || row.toolResult || toolName || ''
  return sha256([row.role, content, toolName, args].join('\0'))
}

export function tagTimesByPosition(records: unknown[], positions: number[]): Map<number, string> {
  const tags = new Map<number, string>()
  records.forEach((rec, i) => {
    const role = recordRole(rec)
    if (role !== 'user' && role !== 'human') return
    const raw = recordParts(rec).map(partText).filter(Boolean).join('\n')
    const time = extractTimestampTag(raw)
    if (!time) return
    const pos = positions[i]
    if (typeof pos === 'number') tags.set(pos, time)
  })
  return tags
}

export function applyBackfillTimestamps(
  messages: CaptureMessage[],
  tagByPosition: Map<number, string>,
): { kept: CaptureMessage[]; skippedNoTimestamp: number } {
  const taggedPositions = [...tagByPosition.keys()].sort((a, b) => a - b)
  if (taggedPositions.length === 0) {
    return { kept: [], skippedNoTimestamp: messages.length }
  }
  const firstTagPos = taggedPositions[0] ?? 0
  const clock: TimeClock = {}
  const kept: CaptureMessage[] = []
  let skippedNoTimestamp = 0
  let lastTime: string | undefined
  for (const message of messages) {
    const position = message.metadata?.position
    if (typeof position !== 'number' || position < firstTagPos) {
      skippedNoTimestamp += 1
      continue
    }
    // Advance through every tag at or before this position, including tags
    // whose own record was dropped (hidden/system) before this walk.
    for (const tagPos of taggedPositions) {
      if (tagPos > position) break
      const tagged = tagByPosition.get(tagPos)
      if (tagged) lastTime = tagged
    }
    if (!lastTime) {
      skippedNoTimestamp += 1
      continue
    }
    const createdAt = clampCreatedAt(clock, lastTime)
    if (!createdAt) {
      skippedNoTimestamp += 1
      continue
    }
    const taggedHere = tagByPosition.get(position)
    const metadata: Record<string, unknown> = {
      ...(message.metadata ?? {}),
      ts_approx: true,
    }
    if (taggedHere) metadata.time_source = 'tag'
    else if (!metadata.time_source) metadata.time_source = 'inherited'
    kept.push({
      ...message,
      created_at: createdAt,
      metadata,
    })
  }
  return { kept, skippedNoTimestamp }
}

export function dropSystemMessages(messages: CaptureMessage[]): {
  kept: CaptureMessage[]
  droppedSystem: number
} {
  const kept: CaptureMessage[] = []
  let droppedSystem = 0
  for (const message of messages) {
    if (message.role === 'system') {
      droppedSystem += 1
      continue
    }
    kept.push(message)
  }
  return { kept, droppedSystem }
}

function subIndexFor(message: CaptureMessage, fallback: number): number {
  const position = message.metadata?.position
  const ordinal = message.metadata?.ordinal
  if (typeof position === 'number' && typeof ordinal === 'number' && Number.isFinite(ordinal)) {
    const sub = ordinal - position * ORDINAL_STRIDE
    if (sub >= 0 && sub < ORDINAL_STRIDE) return sub
  }
  return fallback
}

export function attachBackfillMeta(
  messages: CaptureMessage[],
  slug: string,
): { kept: CaptureMessage[]; skippedNoPosition: number } {
  const kept: CaptureMessage[] = []
  let skippedNoPosition = 0
  let lastPos: number | undefined
  let fallbackSub = 0
  for (const message of messages) {
    const position = message.metadata?.position
    if (typeof position !== 'number' || !Number.isFinite(position)) {
      skippedNoPosition += 1
      continue
    }
    if (position !== lastPos) {
      lastPos = position
      fallbackSub = 0
    }
    const sub = subIndexFor(message, fallbackSub)
    fallbackSub = sub + 1
    const metadata: Record<string, unknown> = {
      ...(message.metadata ?? {}),
      source: BACKFILL_SOURCE,
      capture_source: BACKFILL_SOURCE,
      backfill: true,
      source_id: backfillSourceId(slug, position, sub),
      sub_index: sub,
      content_hash: contentHashForRow({
        role: message.role,
        content: message.content,
        toolName: message.tool_name,
        toolArgs: message.tool_args,
        toolResult: message.tool_result,
      }),
      ts_approx: true,
    }
    kept.push({ ...message, metadata })
  }
  return { kept, skippedNoPosition }
}

function overlapKey(row: OverlapRow): string {
  return contentHashForRow({
    role: row.role,
    content: row.content,
    toolName: row.tool_name,
    toolArgs: row.tool_args,
    toolResult: row.tool_result,
  })
}

function messageHash(message: CaptureMessage): string {
  return contentHashForRow({
    role: message.role,
    content: message.content,
    toolName: message.tool_name,
    toolArgs: message.tool_args,
    toolResult: message.tool_result,
  })
}

function rowCreatedAtMs(raw: string | Date | null | undefined): number | undefined {
  if (!raw) return undefined
  const ms = new Date(raw).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

export async function loadOverlapIndex(
  store: OverlapStore,
  ident: BotIdentity,
  opts?: {
    overlapHours?: number
    liveSuffix?: string
    candidateCreatedAt?: Array<string | undefined>
  },
): Promise<OverlapIndex> {
  const hours = opts?.overlapHours ?? DEFAULT_BACKFILL_OVERLAP_HOURS
  const liveSuffix = opts?.liveSuffix ?? SESSION_SUFFIX_V4
  const liveSession = liveV4Session(ident.session, liveSuffix)
  const backfill = backfillSession(ident.session, liveSuffix)
  const sourceIds = new Map<string, string | undefined>()
  const v4Hits: V4OverlapHit[] = []
  // overlap-hours 0 disables -v4 suppression. Otherwise the read is bounded
  // by the candidate span: nothing before the earliest tag minus the overlap
  // window, and nothing after the latest candidate plus the hash tolerance.
  // A stalled -v4 newest is not the anchor.
  if (hours > 0) {
    const times: number[] = []
    for (const raw of opts?.candidateCreatedAt ?? []) {
      if (!raw) continue
      const ms = Date.parse(raw)
      if (Number.isFinite(ms)) times.push(ms)
    }
    if (times.length > 0) {
      const since = new Date(Math.min(...times) - hours * 3_600_000)
      const until = new Date(Math.max(...times) + OVERLAP_TIME_TOLERANCE_MS)
      for (const row of await store.rowsSince(liveSession, ident.agent, since, until)) {
        const ms = rowCreatedAtMs(row.created_at)
        if (ms === undefined) continue
        v4Hits.push({ hash: overlapKey(row), createdAtMs: ms })
      }
    }
  }
  if (store.sourceIds) {
    for (const ref of await store.sourceIds(backfill, ident.agent)) {
      rememberSourceId(sourceIds, ref.sourceId, ref.contentHash)
    }
  } else {
    for (const row of await store.rowsSince(backfill, ident.agent)) {
      rememberSourceId(sourceIds, row.metadata?.source_id, row.metadata?.content_hash)
    }
  }
  return { sourceIds, v4Hits }
}

function rememberSourceId(
  sourceIds: Map<string, string | undefined>,
  sourceId: unknown,
  contentHash: unknown,
): void {
  if (typeof sourceId !== 'string' || !sourceId) return
  const digest = typeof contentHash === 'string' && contentHash ? contentHash : undefined
  if (!sourceIds.has(sourceId)) {
    sourceIds.set(sourceId, digest)
    return
  }
  // A later row that actually stored a digest wins over a missing one.
  if (sourceIds.get(sourceId) === undefined && digest) sourceIds.set(sourceId, digest)
}

/**
 * Exact source id only. No stored digest matches any content. A different
 * digest is a visible change, not a quiet skip and not a hash suppression.
 */
function sourceIdDisposition(
  message: CaptureMessage,
  sourceIds: Map<string, string | undefined>,
): 'none' | 'same' | 'changed' {
  const sourceId = message.metadata?.source_id
  if (typeof sourceId !== 'string' || !sourceId || !sourceIds.has(sourceId)) return 'none'
  const stored = sourceIds.get(sourceId)
  if (!stored) return 'same'
  return stored === messageHash(message) ? 'same' : 'changed'
}

function messagePosition(message: CaptureMessage): number | undefined {
  const position = message.metadata?.position
  return typeof position === 'number' && Number.isFinite(position) ? position : undefined
}

type UsedHit = V4OverlapHit & { used: boolean }

function matchingHitIndex(hits: UsedHit[], message: CaptureMessage, reserved: Set<number>): number {
  const created = message.created_at ? Date.parse(message.created_at) : Number.NaN
  if (!Number.isFinite(created)) return -1
  const hash = messageHash(message)
  return hits.findIndex(
    (row, idx) =>
      !row.used &&
      !reserved.has(idx) &&
      row.hash === hash &&
      Math.abs(row.createdAtMs - created) <= OVERLAP_TIME_TOLERANCE_MS,
  )
}

export function filterOverlap(
  messages: CaptureMessage[],
  index: OverlapIndex,
): {
  kept: CaptureMessage[]
  skippedOverlap: number
  skippedChanged: number
  changedPositions: number[]
} {
  const suppressed = new Array<boolean>(messages.length).fill(false)
  const changedPositions: number[] = []
  let skippedOverlap = 0
  let skippedChanged = 0
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const disposition = sourceIdDisposition(message, index.sourceIds)
    if (disposition === 'none') continue
    suppressed[i] = true
    if (disposition === 'same') {
      skippedOverlap += 1
      continue
    }
    skippedChanged += 1
    const position = messagePosition(message)
    if (position !== undefined && !changedPositions.includes(position)) {
      changedPositions.push(position)
    }
  }

  // Tentative hash+time matches keep multiplicity, but a hit is consumed
  // only when the match is confirmed: the candidate and at least one
  // adjacent candidate (spool order) both match a distinct live row. A
  // length-1 run is not confirmed, so its hit stays free for a later run.
  // One candidate alone is never hash-suppressed.
  const hits: UsedHit[] = index.v4Hits.map((hit) => ({ ...hit, used: false }))
  let i = 0
  while (i < messages.length) {
    if (suppressed[i]) {
      i += 1
      continue
    }
    const reserved = new Set<number>()
    let j = i
    while (j < messages.length && !suppressed[j]) {
      const message = messages[j]
      const hitIdx = matchingHitIndex(hits, message, reserved)
      if (hitIdx < 0) break
      reserved.add(hitIdx)
      j += 1
    }
    if (j - i >= 2) {
      for (let k = i; k < j; k++) suppressed[k] = true
      for (const hitIdx of reserved) {
        const hit = hits[hitIdx]
        hit.used = true
      }
      skippedOverlap += j - i
      i = j
      continue
    }
    i += 1
  }

  const kept: CaptureMessage[] = []
  for (let n = 0; n < messages.length; n++) {
    const message = messages[n]
    if (!suppressed[n]) kept.push(message)
  }
  changedPositions.sort((a, b) => a - b)
  return { kept, skippedOverlap, skippedChanged, changedPositions }
}

function blankCounts(
  slug: string,
  session: string,
  agent: string,
  pages: number,
  extra?: Partial<Pick<IngestPagesCounts, 'pagesFailed' | 'unknownSlugs'>>,
): IngestPagesCounts {
  return {
    slug,
    session,
    agent,
    pages,
    entriesParsed: 0,
    droppedSystem: 0,
    skippedNoTimestamp: 0,
    skippedNoPosition: 0,
    skippedOverlap: 0,
    skippedChanged: 0,
    new: 0,
    conflicts: [],
    pagesFailed: extra?.pagesFailed ?? 0,
    unknownSlugs: extra?.unknownSlugs ?? 0,
  }
}

export function formatIngestPagesChanged(slug: string, positions: number[]): string {
  if (positions.length === 0) return ''
  const shown = positions.slice(0, 5).join(', ')
  const more = positions.length > 5 ? '...' : ''
  return (
    `CHANGED slug=${slug} positions ${shown}${more} ` +
    `content differs from the stored source_id. Those rows were not written.`
  )
}

export function formatIngestPagesConflicts(slug: string, conflicts: number[]): string {
  if (conflicts.length === 0) return ''
  const shown = conflicts.slice(0, 5).join(', ')
  const more = conflicts.length > 5 ? '...' : ''
  return (
    `CONFLICT slug=${slug} positions ${shown}${more} differ across pages ` +
    `(conversation reset/rewritten?). Nothing written for this bot. ` +
    `Other bots in this run are still ingested. Investigate, then ` +
    `rotate GROKBOT_SESSION_SUFFIX or re-run after fixing the source.`
  )
}

export async function ingestPages(
  inputDir: string,
  opts?: {
    commit?: boolean
    agentsDir?: string
    overlapHours?: number
    liveSuffix?: string
    overlapUnavailable?: boolean
    deps?: IngestPagesDeps
  },
): Promise<IngestPagesResult> {
  const commit = Boolean(opts?.commit)
  const liveSuffix = opts?.liveSuffix ?? SESSION_SUFFIX_V4
  const discover = opts?.deps?.discover ?? discoverModels
  const catalog = discover({ agentsDir: opts?.agentsDir })
  const cfg = loadIdentityConfig()
  const files = listPageSpoolFiles(inputDir)
  const bySlug = new Map<string, PageSpoolFile[]>()
  for (const file of files) {
    const list = bySlug.get(file.slug) ?? []
    list.push(file)
    bySlug.set(file.slug, list)
  }

  const bots: IngestPagesCounts[] = []
  let wrote = false

  for (const [fileSlug, slugPages] of bySlug) {
    const ident = identityForSlug(fileSlug, {
      agentsDir: opts?.agentsDir,
      config: cfg,
      catalog,
    })
    if (!ident) {
      console.error(`SKIP unknown slug: ${fileSlug} (not on the discovered roster)`)
      bots.push(blankCounts(fileSlug, '', '', slugPages.length, { unknownSlugs: 1 }))
      continue
    }
    const slug = personaSlugFromIdentity(ident, cfg)
    const session = backfillSession(ident.session, liveSuffix)
    const ordered = [...slugPages].sort((a, b) => compareParsedPages(a, b))
    const loaded: Array<{ page: PageSpoolFile; parsed: ParsedInput }> = []
    let pagesFailed = 0
    for (const page of ordered) {
      try {
        const parsed = parseInput(readFileSync(page.path, 'utf8'), 'page')
        loaded.push({ page, parsed: { ...parsed, sourcePath: page.path } })
      } catch (err) {
        pagesFailed += 1
        const message = err instanceof Error ? err.message : 'parse failed'
        console.error(`SKIP malformed page ${basename(page.path)}: ${message}`)
      }
    }
    loaded.sort((a, b) =>
      compareParsedPages(
        { before: a.page.before, path: a.page.path, headerA: a.parsed.header?.a },
        { before: b.page.before, path: b.page.path, headerA: b.parsed.header?.a },
      ),
    )
    if (loaded.length === 0) {
      bots.push(blankCounts(slug, session, ident.agent, slugPages.length, { pagesFailed }))
      continue
    }
    const parsed = loaded.map((item) => item.parsed)
    const result = normalizePages(parsed, {
      sessionKey: session,
      agent: ident.agent,
      agentId: ident.id,
      persona: ident.persona,
      format: 'page',
    })
    const conflicts = result.conflicts ?? []
    if (conflicts.length > 0) console.error(formatIngestPagesConflicts(slug, conflicts))
    const tagByPosition = tagTimesFromParsed(parsed)
    const withoutSystem = dropSystemMessages(result.messages)
    const stamped = applyBackfillTimestamps(withoutSystem.kept, tagByPosition)
    const tagged = attachBackfillMeta(stamped.kept, slug)
    let index: OverlapIndex = { sourceIds: new Map(), v4Hits: [] }
    if (opts?.deps?.overlap) {
      index = await loadOverlapIndex(opts.deps.overlap, ident, {
        overlapHours: opts.overlapHours,
        liveSuffix,
        candidateCreatedAt: tagged.kept.map((message) => message.created_at),
      })
    }
    const overlap = filterOverlap(tagged.kept, index)
    if (overlap.changedPositions.length > 0) {
      console.error(formatIngestPagesChanged(slug, overlap.changedPositions))
    }
    const counts: IngestPagesCounts = {
      slug,
      session,
      agent: ident.agent,
      pages: slugPages.length,
      entriesParsed: result.stats.in,
      droppedSystem: result.stats.dropped + withoutSystem.droppedSystem,
      skippedNoTimestamp: stamped.skippedNoTimestamp,
      skippedNoPosition: tagged.skippedNoPosition,
      skippedOverlap: overlap.skippedOverlap,
      skippedChanged: overlap.skippedChanged,
      new: overlap.kept.length,
      conflicts,
      pagesFailed,
      unknownSlugs: 0,
    }
    if (commit && conflicts.length === 0 && overlap.kept.length > 0) {
      const write = opts?.deps?.commit
      if (!write) {
        throw new Error('ingest-pages --commit needs an ingest writer (RIVETOS_PG_URL)')
      }
      const rows = toIngestRows(overlap.kept)
      await write({
        sessionId: session,
        agent: ident.agent,
        persona: ident.persona,
        source: BACKFILL_SOURCE,
        channel: 'grokbot',
        messages: rows,
      })
      wrote = true
    }
    bots.push(counts)
  }

  return {
    dryRun: !commit,
    bots,
    wrote,
    overlapUnavailable: Boolean(opts?.overlapUnavailable),
  }
}

function tagTimesFromParsed(inputs: ParsedInput[]): Map<number, string> {
  const tags = new Map<number, string>()
  for (const input of inputs) {
    const start = input.header?.a ?? 0
    const positions = input.records.map((_, i) => start + i)
    for (const [pos, time] of tagTimesByPosition(input.records, positions)) {
      if (!tags.has(pos)) tags.set(pos, time)
    }
  }
  return tags
}

export const NEWEST_CREATED_SQL = `
SELECT MAX(m.created_at) AS newest
  FROM ros_messages m
  JOIN ros_conversations c ON c.id = m.conversation_id
 WHERE c.channel = 'grokbot'
   AND c.session_key = $1
   AND c.agent = $2
`.trim()

export const ROWS_SINCE_SQL = `
SELECT m.role, m.content, m.tool_name, m.tool_args, m.tool_result,
       m.created_at, m.metadata
  FROM ros_messages m
  JOIN ros_conversations c ON c.id = m.conversation_id
 WHERE c.channel = 'grokbot'
   AND c.session_key = $1
   AND c.agent = $2
   AND ($3::timestamptz IS NULL OR m.created_at >= $3)
   AND ($4::timestamptz IS NULL OR m.created_at <= $4)
`.trim()

/** Backfill idempotence keys only. Does not load content or tool payloads. */
export const BACKFILL_SOURCE_IDS_SQL = `
SELECT DISTINCT m.metadata->>'source_id' AS source_id,
       m.metadata->>'content_hash' AS content_hash
  FROM ros_messages m
  JOIN ros_conversations c ON c.id = m.conversation_id
 WHERE c.channel = 'grokbot'
   AND c.session_key = $1
   AND c.agent = $2
   AND COALESCE(m.metadata->>'source_id', '') <> ''
`.trim()

export function createPgOverlapStore(connectionString: string): OverlapStore {
  const pool = new pg.Pool({
    connectionString,
    ...READONLY_POOL_OPTIONS,
  })
  const guarded = wrapReadOnlyClient({
    query: async (sql, params) => pool.query(sql, params),
  })
  return {
    async newestCreatedAt(sessionKey, agent) {
      const result = await guarded.query(NEWEST_CREATED_SQL, [sessionKey, agent])
      const row = result.rows[0] as { newest?: string | Date | null } | undefined
      const raw = row?.newest
      if (!raw) return undefined
      const dt = new Date(raw)
      return Number.isNaN(dt.getTime()) ? undefined : dt
    },
    async rowsSince(sessionKey, agent, since, until) {
      const result = await guarded.query(ROWS_SINCE_SQL, [
        sessionKey,
        agent,
        since ?? null,
        until ?? null,
      ])
      return result.rows as OverlapRow[]
    },
    async sourceIds(sessionKey, agent) {
      const result = await guarded.query(BACKFILL_SOURCE_IDS_SQL, [sessionKey, agent])
      const ids: StoredSourceId[] = []
      for (const row of result.rows as Array<{
        source_id?: string | null
        content_hash?: string | null
      }>) {
        if (typeof row.source_id !== 'string' || !row.source_id) continue
        const contentHash =
          typeof row.content_hash === 'string' && row.content_hash ? row.content_hash : undefined
        ids.push(
          contentHash ? { sourceId: row.source_id, contentHash } : { sourceId: row.source_id },
        )
      }
      return ids
    },
    async close() {
      await pool.end()
    },
  }
}

export function formatIngestPagesCounts(result: IngestPagesResult): string {
  const lines = result.bots.map((b) => {
    const prefix = result.dryRun ? 'DRY' : 'WRITE'
    return (
      `${prefix} slug=${b.slug} session=${b.session} agent=${b.agent} ` +
      `pages=${String(b.pages)} entries_parsed=${String(b.entriesParsed)} ` +
      `dropped_system=${String(b.droppedSystem)} ` +
      `skipped_no_timestamp=${String(b.skippedNoTimestamp)} ` +
      `skipped_no_position=${String(b.skippedNoPosition)} ` +
      `skipped_overlap=${String(b.skippedOverlap)} ` +
      `skipped_changed=${String(b.skippedChanged)} new=${String(b.new)} ` +
      `pages_failed=${String(b.pagesFailed)} unknown_slugs=${String(b.unknownSlugs)}`
    )
  })
  const summary =
    `ingest-pages bots=${String(result.bots.length)} write=${result.wrote ? 'true' : 'false'} ` +
    `dry=${result.dryRun ? 'true' : 'false'}`
  lines.push(
    result.overlapUnavailable ? `${summary} overlap=unavailable (no RIVETOS_PG_URL)` : summary,
  )
  return lines.join('\n')
}
