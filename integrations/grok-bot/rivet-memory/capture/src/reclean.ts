import { readFileSync } from 'node:fs'
import { capForStorage } from '@rivetos/capture-core'
import { classifyHidden, extractAgentMessage, systemMarker } from './hidden.js'
import { toIngestRows } from './normalize.js'
import { extractTimestampTag } from './timestamps.js'
import {
  ORDINAL_STRIDE,
  SESSION_SUFFIX_V3,
  SESSION_SUFFIX_V3_ROWS,
  STORAGE_LIMIT,
  stripSessionSuffix,
  type IngestRow,
  type NormalizeStats,
  type StoredRow,
} from './types.js'
import { extractUserText } from './wrappers.js'
import { normalizeRecords } from './normalize.js'
import { parseInput } from './parse.js'
import type { NormalizeOptions } from './types.js'
import type { CaptureMessage } from '@rivetos/capture-core'

export type { StoredRow }

export interface RecleanResult {
  session: string
  agent: string
  messages: CaptureMessage[]
  ingest: IngestRow[]
  stats: NormalizeStats
  wrote: boolean
  dryRun: boolean
}

export function v3Session(session: string): string {
  return `${stripSessionSuffix(session)}${SESSION_SUFFIX_V3}`
}

/** Row-based re-clean writes here so source-transcript -v3 ordinals never collide. */
export function v3RowsSession(session: string): string {
  return `${stripSessionSuffix(session)}${SESSION_SUFFIX_V3_ROWS}`
}

export function recleanFromSource(
  text: string,
  opts: NormalizeOptions & { dryRun?: boolean },
): RecleanResult {
  const parsed = parseInput(text)
  const session = v3Session(opts.sessionKey)
  const result = normalizeRecords(parsed.records, {
    ...opts,
    sessionKey: session,
    format: parsed.format,
    startPosition: parsed.header?.a ?? opts.startPosition ?? 0,
    agentId: parsed.header?.id ?? opts.agentId,
  })
  return {
    session,
    agent: opts.agent,
    messages: result.messages,
    ingest: toIngestRows(result.messages),
    stats: result.stats,
    wrote: false,
    dryRun: opts.dryRun !== false,
  }
}

/**
 * Re-strip already-ingested grokbot rows (content still carries wrappers).
 * Used when source transcripts are gone. Never mutates the input rows.
 */
/**
 * Decode a stored ingest ordinal to a source position. NULL ordinals stay unset.
 *
 * Production grokbot rows use old-style sequential ordinals (0, 1, 2, …).
 * Dividing those by ORDINAL_STRIDE collapses 15k Rivet rows onto ~1000
 * positions. Only decode the new stride when the row already carries
 * new-style metadata (`position` or `capture_source`).
 */
export function storedRowPosition(row: StoredRow): number | undefined {
  const pos = row.metadata?.position
  if (typeof pos === 'number' && Number.isFinite(pos)) return pos

  const raw = row.ordinal ?? row.metadata?.ordinal
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (hasNewStyleOrdinal(row) && raw >= ORDINAL_STRIDE) {
      return Math.floor(raw / ORDINAL_STRIDE)
    }
    return raw
  }
  return undefined
}

function hasNewStyleOrdinal(row: StoredRow): boolean {
  const meta = row.metadata
  if (!meta || typeof meta !== 'object') return false
  if (typeof meta.position === 'number' && Number.isFinite(meta.position)) return true
  return typeof meta.capture_source === 'string' && meta.capture_source.length > 0
}

/**
 * Honor each row's stored ordinal/position. NULL ordinals are assigned after
 * the highest known position so they are not mixed in as 0.
 */
export function assignRecleanPositions(rows: StoredRow[]): number[] {
  const known = rows.map(storedRowPosition)
  let maxKnown = -1
  for (const p of known) {
    if (p !== undefined) maxKnown = Math.max(maxKnown, p)
  }
  let nextNull = maxKnown + 1
  return known.map((p) => (p === undefined ? nextNull++ : p))
}

export function recleanStoredRows(
  rows: StoredRow[],
  opts: NormalizeOptions & { dryRun?: boolean },
): RecleanResult {
  const session = v3RowsSession(opts.sessionKey)
  const records = rows.map((r) => ({
    role: r.role,
    message: {
      content: [
        { type: 'text', text: r.content },
        ...(r.tool_name ? [{ type: 'tool_use', name: r.tool_name, input: r.tool_args ?? {} }] : []),
        ...(r.tool_result
          ? [{ type: 'tool_result', name: r.tool_name ?? 'tool', result: r.tool_result }]
          : []),
      ],
    },
    created_at: r.created_at,
  }))
  const positions = assignRecleanPositions(rows)
  const result = normalizeRecords(records, {
    ...opts,
    sessionKey: session,
    startPosition: positions[0] ?? 0,
    positions,
    useStoredCreatedAt: true,
  })
  return {
    session,
    agent: opts.agent,
    messages: result.messages,
    ingest: toIngestRows(result.messages),
    stats: result.stats,
    wrote: false,
    dryRun: opts.dryRun !== false,
  }
}

export function recleanContentOnly(content: string): {
  content: string
  kind?: string
  dropped?: boolean
  created_at?: string
} {
  const created_at = extractTimestampTag(content)
  const kind = classifyHidden(content)
  const userText = extractUserText(content)
  if (userText)
    return { content: capForStorage(userText, { limit: STORAGE_LIMIT }).text, created_at }
  if (kind === 'agent_message') {
    const agent = extractAgentMessage(content)
    return { content: agent?.text ?? systemMarker('agent_message'), kind, created_at }
  }
  if (kind) return { content: systemMarker(kind), kind, created_at }
  return { content: '', dropped: true, created_at }
}

export const FROM_ROWS_LIMITS = [
  '--from-rows / PG write <session>-v3-rows (not -v3): stored-row positions do not match source-transcript positions.',
  '--from-rows cannot restore tool results: the old converter ignored `result`, so stored tool rows have empty tool_result.',
  'Assistant rows keep the legacy [tool X] / [thinking] text.',
  'Full fidelity needs a backfill from the source transcripts.',
].join(' ')

export function printRecleanStats(result: RecleanResult): string {
  const s = result.stats
  const lines = [
    `session=${result.session} agent=${result.agent} dry_run=${String(result.dryRun)} wrote=${String(result.wrote)}`,
    `in=${String(s.in)} out=${String(s.out)} dropped=${String(s.dropped)} system_events=${String(s.systemEvents)}`,
    `roles user=${String(s.user)} assistant=${String(s.assistant)} tool=${String(s.tool)} system=${String(s.system)}`,
    `truncated=${String(s.truncated)} time_known=${String(s.timeKnown)}${s.lastKnownTime ? ` last_known=${s.lastKnownTime}` : ''}`,
  ]
  if (!s.timeKnown) {
    lines.push('created_at: unset (no timestamp in source; DB default on ingest)')
  }
  return lines.join('\n')
}

export { LIST_CONVERSATIONS_SQL, ROWS_BY_CONVERSATION_SQL } from './pg-readonly.js'

export const EXISTING_ROWS_SQL = `
SELECT m.role, m.content, m.tool_name, m.tool_args, m.tool_result, m.created_at, m.metadata,
       (m.metadata->>'ordinal')::int AS ordinal, m.conversation_id
  FROM ros_messages m
  JOIN ros_conversations c ON c.id = m.conversation_id
 WHERE c.channel = 'grokbot'
   AND c.session_key = $1
   AND ($2::text IS NULL OR c.agent = $2)
 ORDER BY m.conversation_id, COALESCE((m.metadata->>'ordinal')::int, 0), m.created_at
`.trim()

export function loadStoredRowsJson(path: string): StoredRow[] {
  const raw = readFileSync(path, 'utf8').trim()
  if (raw.startsWith('[')) return JSON.parse(raw) as StoredRow[]
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredRow)
}
