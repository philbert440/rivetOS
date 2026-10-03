/**
 * ReadTranscript page backfill → <session>-v4-backfill.
 *
 * Pages are dumped as <bot-slug>-<before>.txt. Positions are conversation
 * indices, not store.db seq. Timestamps come only from user `<timestamp>`
 * tags (any UTC offset) and are carried forward; rows before the first
 * parsable tag are skipped. Every kept row is marked ts_approx=true.
 * Hidden system / agent wakes follow the v4 normalizer, then system rows
 * are dropped from this tag. Nothing is folded into plain -v4.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { contentTupleHash, type CaptureMessage } from '@rivetos/capture-core'
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
import { formatMergeConflicts, normalizePages } from './pages.js'
import { parseInput, partText, recordParts, recordRole } from './parse.js'
import { extractTimestampTag } from './timestamps.js'
import {
  DEFAULT_BACKFILL_OVERLAP_HOURS,
  SESSION_SUFFIX_V4,
  type BotIdentity,
  type ParsedInput,
} from './types.js'

export const PAGE_FILE_RE = /^(.+)-(\d+)\.txt$/i
export const BACKFILL_SOURCE = 'grokbot-readtranscript-backfill'

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
}

export interface IngestPagesCounts {
  slug: string
  session: string
  agent: string
  pages: number
  entriesParsed: number
  droppedSystem: number
  skippedNoTimestamp: number
  skippedOverlap: number
  new: number
  conflicts: number[]
}

export interface IngestPagesResult {
  dryRun: boolean
  bots: IngestPagesCounts[]
  wrote: boolean
}

export interface IngestPagesDeps {
  overlap?: OverlapStore
  commit?: (input: GrokbotIngestInput) => Promise<GrokbotIngestResult>
  discover?: (opts?: { agentsDir?: string }) => DiscoverResult
}

export function parsePageFileName(name: string): { slug: string; before: number } | undefined {
  const m = PAGE_FILE_RE.exec(basename(name))
  if (!m) return undefined
  return { slug: m[1], before: Number(m[2]) }
}

export function listPageSpoolFiles(dir: string): PageSpoolFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: PageSpoolFile[] = []
  for (const name of names.sort()) {
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
  return out
}

export function backfillSession(sessionBase: string, liveSuffix = SESSION_SUFFIX_V4): string {
  const suffix = `${liveSuffix}-backfill`
  return sessionBase.endsWith(suffix) ? sessionBase : `${sessionBase}${suffix}`
}

export function liveV4Session(sessionBase: string, liveSuffix = SESSION_SUFFIX_V4): string {
  return sessionBase.endsWith(liveSuffix) ? sessionBase : `${sessionBase}${liveSuffix}`
}

export function backfillSourceId(slug: string, position: number): string {
  return `readtranscript:${slug}:${String(position)}`
}

export function contentHashForRow(row: {
  role: string
  content: string
  toolName?: string | null
  toolArgs?: unknown
  toolResult?: string | null
}): string {
  return contentTupleHash({
    role: row.role,
    content: row.content || row.toolResult || row.toolName || '',
    toolName: row.toolName ?? undefined,
    toolArgs: row.toolArgs ?? undefined,
  })
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
  const firstTagPos = [...tagByPosition.keys()].sort((a, b) => a - b)[0]
  if (firstTagPos === undefined) {
    return { kept: [], skippedNoTimestamp: messages.length }
  }
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
    const tagged = tagByPosition.get(position)
    if (tagged) lastTime = tagged
    const createdAt = clampCreatedAt(clock, lastTime)
    const metadata: Record<string, unknown> = {
      ...(message.metadata ?? {}),
      ts_approx: true,
    }
    if (tagged) metadata.time_source = 'tag'
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

export function attachBackfillMeta(messages: CaptureMessage[], slug: string): CaptureMessage[] {
  return messages.map((message) => {
    const position = typeof message.metadata?.position === 'number' ? message.metadata.position : 0
    const metadata: Record<string, unknown> = {
      ...(message.metadata ?? {}),
      source: BACKFILL_SOURCE,
      source_id: backfillSourceId(slug, position),
      ts_approx: true,
    }
    return { ...message, metadata }
  })
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

export async function loadOverlapHashes(
  store: OverlapStore,
  ident: BotIdentity,
  opts?: { overlapHours?: number; liveSuffix?: string },
): Promise<Set<string>> {
  const hours = opts?.overlapHours ?? DEFAULT_BACKFILL_OVERLAP_HOURS
  const liveSuffix = opts?.liveSuffix ?? SESSION_SUFFIX_V4
  const liveSession = liveV4Session(ident.session, liveSuffix)
  const backfill = backfillSession(ident.session, liveSuffix)
  const hashes = new Set<string>()
  const newest = await store.newestCreatedAt(liveSession, ident.agent)
  const since = newest ? new Date(newest.getTime() - hours * 3_600_000) : undefined
  if (newest) {
    for (const row of await store.rowsSince(liveSession, ident.agent, since)) {
      hashes.add(overlapKey(row))
    }
  }
  for (const row of await store.rowsSince(backfill, ident.agent)) {
    hashes.add(overlapKey(row))
    const sourceId = row.metadata?.source_id
    if (typeof sourceId === 'string' && sourceId) hashes.add(`source:${sourceId}`)
  }
  return hashes
}

export function filterOverlap(
  messages: CaptureMessage[],
  hashes: Set<string>,
): { kept: CaptureMessage[]; skippedOverlap: number } {
  const kept: CaptureMessage[] = []
  let skippedOverlap = 0
  for (const message of messages) {
    const sourceId = message.metadata?.source_id
    if (
      hashes.has(messageHash(message)) ||
      (typeof sourceId === 'string' && hashes.has(`source:${sourceId}`))
    ) {
      skippedOverlap += 1
      continue
    }
    kept.push(message)
  }
  return { kept, skippedOverlap }
}

export async function ingestPages(
  inputDir: string,
  opts?: {
    commit?: boolean
    agentsDir?: string
    overlapHours?: number
    liveSuffix?: string
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

  for (const [fileSlug, pages] of bySlug) {
    const ident =
      identityForSlug(fileSlug, { agentsDir: opts?.agentsDir, config: cfg }) ??
      catalog.models.find((m) => personaSlugFromIdentity(m, cfg) === fileSlug)
    if (!ident) {
      console.error(`SKIP unknown slug: ${fileSlug} (not on the discovered roster)`)
      continue
    }
    const slug = personaSlugFromIdentity(ident, cfg)
    const session = backfillSession(ident.session, liveSuffix)
    const parsed: ParsedInput[] = []
    for (const page of pages) {
      try {
        parsed.push(parseInput(readFileSync(page.path, 'utf8'), 'page'))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'parse failed'
        console.error(`SKIP malformed page ${basename(page.path)}: ${message}`)
      }
    }
    if (parsed.length === 0) {
      bots.push({
        slug,
        session,
        agent: ident.agent,
        pages: pages.length,
        entriesParsed: 0,
        droppedSystem: 0,
        skippedNoTimestamp: 0,
        skippedOverlap: 0,
        new: 0,
        conflicts: [],
      })
      continue
    }
    const result = normalizePages(parsed, {
      sessionKey: session,
      agent: ident.agent,
      agentId: ident.id,
      persona: ident.persona,
      format: 'page',
    })
    if ((result.conflicts ?? []).length > 0) {
      console.error(formatMergeConflicts(result.conflicts ?? []))
    }
    const tagByPosition = tagTimesFromParsed(parsed)
    const withoutSystem = dropSystemMessages(result.messages)
    const stamped = applyBackfillTimestamps(withoutSystem.kept, tagByPosition)
    const tagged = attachBackfillMeta(stamped.kept, slug)
    let hashes = new Set<string>()
    if (opts?.deps?.overlap) {
      hashes = await loadOverlapHashes(opts.deps.overlap, ident, {
        overlapHours: opts.overlapHours,
        liveSuffix,
      })
    }
    const overlap = filterOverlap(tagged, hashes)
    const counts: IngestPagesCounts = {
      slug,
      session,
      agent: ident.agent,
      pages: pages.length,
      entriesParsed: result.stats.in,
      droppedSystem: result.stats.dropped + withoutSystem.droppedSystem,
      skippedNoTimestamp: stamped.skippedNoTimestamp,
      skippedOverlap: overlap.skippedOverlap,
      new: overlap.kept.length,
      conflicts: result.conflicts ?? [],
    }
    if (commit && overlap.kept.length > 0) {
      const write = opts?.deps?.commit
      if (!write) {
        throw new Error('ingest-pages --commit needs an ingest writer (RIVETOS_PG_URL)')
      }
      const rows = toIngestRows(overlap.kept)
      await write({
        sessionId: session,
        agent: ident.agent,
        persona: ident.persona,
        source: 'grokbot',
        channel: 'grokbot',
        messages: rows,
      })
      wrote = true
    }
    bots.push(counts)
  }

  return { dryRun: !commit, bots, wrote }
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

export function createPgOverlapStore(connectionString: string): OverlapStore {
  const query = async (sql: string, params: unknown[]) => {
    const pool = new pg.Pool({ connectionString, max: 1 })
    try {
      return await pool.query(sql, params)
    } finally {
      await pool.end()
    }
  }
  return {
    async newestCreatedAt(sessionKey, agent) {
      const result = await query(NEWEST_CREATED_SQL, [sessionKey, agent])
      const raw = result.rows[0]?.newest as string | Date | null | undefined
      if (!raw) return undefined
      const dt = new Date(raw)
      return Number.isNaN(dt.getTime()) ? undefined : dt
    },
    async rowsSince(sessionKey, agent, since) {
      const result = await query(ROWS_SINCE_SQL, [sessionKey, agent, since ?? null])
      return result.rows as OverlapRow[]
    },
  }
}

export function formatIngestPagesCounts(result: IngestPagesResult): string {
  const lines = result.bots.map((b) => {
    const prefix = result.dryRun ? 'DRY' : 'WRITE'
    return (
      `${prefix} slug=${b.slug} session=${b.session} agent=${b.agent} ` +
      `pages=${String(b.pages)} entries_parsed=${String(b.entriesParsed)} ` +
      `dropped_system=${String(b.droppedSystem)} skipped_no_timestamp=${String(b.skippedNoTimestamp)} ` +
      `skipped_overlap=${String(b.skippedOverlap)} new=${String(b.new)}`
    )
  })
  lines.push(
    `ingest-pages bots=${String(result.bots.length)} write=${result.wrote ? 'true' : 'false'} dry=${result.dryRun ? 'true' : 'false'}`,
  )
  return lines.join('\n')
}
