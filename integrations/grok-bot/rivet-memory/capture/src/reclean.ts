import { readFileSync } from 'node:fs'
import { capForStorage } from '@rivetos/capture-core'
import { classifyHidden, extractAgentMessage, systemMarker } from './hidden.js'
import { toIngestRows } from './normalize.js'
import { extractTimestampTag } from './timestamps.js'
import { SESSION_SUFFIX_V3, STORAGE_LIMIT, type IngestRow, type NormalizeStats } from './types.js'
import { extractUserText } from './wrappers.js'
import { normalizeRecords } from './normalize.js'
import { parseInput } from './parse.js'
import type { NormalizeOptions } from './types.js'
import type { CaptureMessage } from '@rivetos/capture-core'

export interface StoredRow {
  role: string
  content: string
  tool_name?: string | null
  tool_args?: unknown
  tool_result?: string | null
  created_at?: string | Date | null
  metadata?: Record<string, unknown> | null
  ordinal?: number | null
}

export interface RecleanResult {
  session: string
  agent: string
  messages: CaptureMessage[]
  ingest: IngestRow[]
  stats: NormalizeStats
  wrote: boolean
  dryRun: boolean
}

const EXISTING_SESSION_RE = /^(grokbot-.+?)(?:-v2)?$/

export function v3Session(session: string): string {
  if (session.endsWith(SESSION_SUFFIX_V3)) return session
  const m = EXISTING_SESSION_RE.exec(session)
  return `${m?.[1] ?? session}${SESSION_SUFFIX_V3}`
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
export function recleanStoredRows(
  rows: StoredRow[],
  opts: NormalizeOptions & { dryRun?: boolean },
): RecleanResult {
  const session = v3Session(opts.sessionKey)
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
  const result = normalizeRecords(records, {
    ...opts,
    sessionKey: session,
    startPosition: typeof rows[0]?.ordinal === 'number' ? rows[0].ordinal : 0,
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

export const EXISTING_ROWS_SQL = `
SELECT m.role, m.content, m.tool_name, m.tool_args, m.tool_result, m.created_at, m.metadata,
       (m.metadata->>'ordinal')::int AS ordinal
  FROM ros_messages m
  JOIN ros_conversations c ON c.id = m.conversation_id
 WHERE c.channel = 'grokbot'
   AND c.session_key = $1
 ORDER BY COALESCE((m.metadata->>'ordinal')::int, 0), m.created_at
`.trim()

export function loadStoredRowsJson(path: string): StoredRow[] {
  const raw = readFileSync(path, 'utf8').trim()
  if (raw.startsWith('[')) return JSON.parse(raw) as StoredRow[]
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredRow)
}
