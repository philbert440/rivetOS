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
 * Overlap suppression is time-relative to the candidate rows. `--overlap-hours 0`
 * disables -v4 content-hash suppression (source_id idempotence stays on).
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
 * same occurrence. `--overlap-hours 0` turns suppression off entirely.
 */
export const OVERLAP_TIME_TOLERANCE_MS = 60 * 60 * 1000

const NEW_SOURCE_ID_RE = /^readtranscript:(.+):(\d+):(\d+)$/

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

export interface OverlapStore {
  newestCreatedAt(sessionKey: string, agent: string): Promise<Date | undefined>
  rowsSince(sessionKey: string, agent: string, since?: Date): Promise<OverlapRow[]>
  /** Distinct backfill `metadata.source_id` values. Preferred over `rowsSince`. */
  sourceIds?(sessionKey: string, agent: string): Promise<string[]>
  close?: () => Promise<void>
}

export interface V4OverlapHit {
  hash: string
  createdAtMs: number
}

export interface OverlapIndex {
  /** Existing -v4-backfill source ids, new form and legacy `…:<position>`. */
  sourceIds: Set<string>
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
 * New ids are `readtranscript:<slug>:<position>:<sub>`. Omit `sub` for the
 * legacy per-position id written before sub-indexes existed.
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
  const sourceIds = new Set<string>()
  const v4Hits: V4OverlapHit[] = []
  // overlap-hours 0 disables -v4 suppression. The window otherwise starts at
  // the earliest candidate time, not at the (possibly stalled) -v4 newest.
  if (hours > 0) {
    const times: number[] = []
    for (const raw of opts?.candidateCreatedAt ?? []) {
      if (!raw) continue
      const ms = Date.parse(raw)
      if (Number.isFinite(ms)) times.push(ms)
    }
    if (times.length > 0) {
      const since = new Date(Math.min(...times) - hours * 3_600_000)
      for (const row of await store.rowsSince(liveSession, ident.agent, since)) {
        const ms = rowCreatedAtMs(row.created_at)
        if (ms === undefined) continue
        v4Hits.push({ hash: overlapKey(row), createdAtMs: ms })
      }
    }
  }
  if (store.sourceIds) {
    for (const id of await store.sourceIds(backfill, ident.agent)) {
      if (id) sourceIds.add(id)
    }
  } else {
    for (const row of await store.rowsSince(backfill, ident.agent)) {
      const sourceId = row.metadata?.source_id
      if (typeof sourceId === 'string' && sourceId) sourceIds.add(sourceId)
    }
  }
  return { sourceIds, v4Hits }
}

function positionCounts(messages: CaptureMessage[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const message of messages) {
    const position = message.metadata?.position
    if (typeof position !== 'number' || !Number.isFinite(position)) continue
    counts.set(position, (counts.get(position) ?? 0) + 1)
  }
  return counts
}

/**
 * Legacy ids are `readtranscript:<slug>:<position>` with no sub-index.
 * A single kept message at that position is provably sub 0. Several messages
 * shared one id, and DISTINCT cannot say which subs landed, so the legacy id
 * covers every sub — a re-run must not duplicate those rows.
 */
function coveredBySourceId(
  message: CaptureMessage,
  sourceIds: Set<string>,
  counts: Map<number, number>,
): boolean {
  const sourceId = message.metadata?.source_id
  if (typeof sourceId !== 'string' || !sourceId) return false
  if (sourceIds.has(sourceId)) return true
  const parsed = NEW_SOURCE_ID_RE.exec(sourceId)
  if (!parsed) return false
  const legacy = `readtranscript:${parsed[1]}:${parsed[2]}`
  if (!sourceIds.has(legacy)) return false
  const position = Number(parsed[2])
  const sub = Number(parsed[3])
  const n = counts.get(position) ?? 1
  if (n === 1 && sub === 0) return true
  if (n > 1) return true
  return false
}

export function filterOverlap(
  messages: CaptureMessage[],
  index: OverlapIndex,
): { kept: CaptureMessage[]; skippedOverlap: number } {
  const counts = positionCounts(messages)
  const unused = index.v4Hits.map((hit) => ({ ...hit, used: false }))
  const kept: CaptureMessage[] = []
  let skippedOverlap = 0
  for (const message of messages) {
    if (coveredBySourceId(message, index.sourceIds, counts)) {
      skippedOverlap += 1
      continue
    }
    const hash = messageHash(message)
    const created = message.created_at ? Date.parse(message.created_at) : Number.NaN
    if (!Number.isFinite(created)) {
      kept.push(message)
      continue
    }
    const hit = unused.find(
      (row) =>
        !row.used &&
        row.hash === hash &&
        Math.abs(row.createdAtMs - created) <= OVERLAP_TIME_TOLERANCE_MS,
    )
    if (hit) {
      hit.used = true
      skippedOverlap += 1
      continue
    }
    kept.push(message)
  }
  return { kept, skippedOverlap }
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
    new: 0,
    conflicts: [],
    pagesFailed: extra?.pagesFailed ?? 0,
    unknownSlugs: extra?.unknownSlugs ?? 0,
  }
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
    let index: OverlapIndex = { sourceIds: new Set(), v4Hits: [] }
    if (opts?.deps?.overlap) {
      index = await loadOverlapIndex(opts.deps.overlap, ident, {
        overlapHours: opts.overlapHours,
        liveSuffix,
        candidateCreatedAt: tagged.kept.map((message) => message.created_at),
      })
    }
    const overlap = filterOverlap(tagged.kept, index)
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
`.trim()

/** Backfill idempotence keys only. Does not load content or tool payloads. */
export const BACKFILL_SOURCE_IDS_SQL = `
SELECT DISTINCT m.metadata->>'source_id' AS source_id
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
    async rowsSince(sessionKey, agent, since) {
      const result = await guarded.query(ROWS_SINCE_SQL, [sessionKey, agent, since ?? null])
      return result.rows as OverlapRow[]
    },
    async sourceIds(sessionKey, agent) {
      const result = await guarded.query(BACKFILL_SOURCE_IDS_SQL, [sessionKey, agent])
      const ids: string[] = []
      for (const row of result.rows as Array<{ source_id?: string | null }>) {
        if (typeof row.source_id === 'string' && row.source_id) ids.push(row.source_id)
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
      `skipped_overlap=${String(b.skippedOverlap)} new=${String(b.new)} ` +
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
