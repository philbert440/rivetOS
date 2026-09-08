#!/usr/bin/env node
/**
 * Codex transcript backfill — one-shot ingest of existing Codex rollout
 * jsonl files into the shared RivetOS memory store.
 *
 * Identity scheme is reused verbatim from the capture worker so a live
 * watcher and this tool collide rather than duplicate:
 *   agent='rivet-gpt', channel='codex', session_key='codex:<uuid>'
 *   event_id = rollout item id (`rs_…`/`ctc_…`/`ctco_…`) or
 *              `codex:<uuid>:line:<index>`
 *
 * Parser is kept in lockstep with ../capture/src/codex-memory-capture.ts
 * (same fold rules as den-server `codexTurnsFromLines`). Tests import both
 * and compare event ids on the shared fixture.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CAPTURE_AGENT = 'rivet-gpt'
export const CAPTURE_CHANNEL = 'codex'
export const BACKFILL_SOURCE = 'codex-backfill'
export const MAX_CONTENT = 16000
const STATEMENT_TIMEOUT_MS = 60000
const DEFAULT_TITLE = 'Codex session'

const CODEX_NATIVE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLLOUT_NAME_RE =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export interface BackfillRow {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string | null
  toolArgs?: unknown
  toolResult?: string | null
  eventId: string
  eventTs: string | null
  createdAt: string
  lineIndex: number
  extra: Record<string, unknown>
}

export interface ParseResult {
  rows: BackfillRow[]
  sessionId: string
  cwd: string | null
  firstUserText: string | null
  malformed: number
  skipped: Record<string, number>
}

export interface Transcript {
  file: string
  sessionId: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function isCodexWrapper(text: string): boolean {
  return (
    text.startsWith('<environment_context>') ||
    text.startsWith('<skills_instructions>') ||
    text.startsWith('<multi_agent_')
  )
}

export function contentText(content: unknown, want: 'input_text' | 'output_text'): string | null {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (!isRecord(b) || typeof b.text !== 'string') return ''
        if (b.type !== want && b.type !== 'text') return ''
        return b.text
      })
      .filter(Boolean)
      .join('\n')
  }
  text = text.trim()
  if (!text || isCodexWrapper(text)) return null
  return text
}

function reasoningText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string' && payload.text) return payload.text
  const parts: string[] = []
  const collect = (raw: unknown): void => {
    if (!Array.isArray(raw)) return
    for (const item of raw) {
      if (!isRecord(item) || typeof item.text !== 'string' || !item.text) continue
      parts.push(item.text)
    }
  }
  collect(payload.summary)
  collect(payload.content)
  return parts.join('')
}

function parseToolInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

export function deriveSessionKey(sessionId: string): string {
  return `${CAPTURE_CHANNEL}:${sessionId}`
}

export function uuidFromRolloutName(name: string): string | undefined {
  const m = name.match(ROLLOUT_NAME_RE)
  return m?.[1]
}

export function eventIdFromItem(
  sessionId: string,
  payload: Record<string, unknown> | undefined,
  lineIndex: number,
): string {
  const id = (payload ? asString(payload.id) : null) || (payload ? asString(payload.call_id) : null)
  if (id) return id
  return `codex:${sessionId}:line:${String(lineIndex)}`
}

export function truncate(value: string): { stored: string; truncated: boolean } {
  if (value.length <= MAX_CONTENT) return { stored: value, truncated: false }
  return { stored: value.slice(0, MAX_CONTENT) + '\n…[truncated]', truncated: true }
}

export function parseRollout(
  text: string,
  opts: { sessionId?: string | null; file?: string | null },
): ParseResult {
  const lines = text.split('\n')
  const skipped: Record<string, number> = {}
  let malformed = 0
  let sessionId = opts.sessionId ?? null
  let cwd: string | null = null
  let firstUserText: string | null = null
  const rows: BackfillRow[] = []
  const toolNameById = new Map<string, string>()
  let lastMs = 0

  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (!line) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    if (!isRecord(obj)) {
      malformed++
      continue
    }
    const payload = isRecord(obj.payload) ? obj.payload : undefined
    const type = obj.type
    const wireMs =
      typeof obj.timestamp === 'number'
        ? obj.timestamp
        : typeof obj.time === 'number'
          ? obj.time
          : Date.parse(typeof obj.timestamp === 'string' ? obj.timestamp : '') || 0
    const eventTs =
      wireMs > 0 ? new Date(wireMs > 1e12 ? wireMs : wireMs * 1000).toISOString() : null

    if (type === 'session_meta' && payload) {
      const id = asString(payload.id)
      if (id && CODEX_NATIVE_RE.test(id)) sessionId = id
      const cwdVal =
        asString(payload.cwd) || (isRecord(payload.cwd) ? asString(payload.cwd.path) : null)
      if (cwdVal) cwd = cwdVal
      continue
    }
    if (type !== 'response_item' || !payload) continue

    const sid = sessionId ?? opts.sessionId ?? 'unknown'
    const eventId = eventIdFromItem(sid, payload, i)
    const ms = wireMs > lastMs ? wireMs : lastMs + 1
    lastMs = ms || lastMs + 1
    const createdAt = new Date(lastMs || i + 1).toISOString()

    const extraBase = {
      sourceEvent: `response_item:${String(payload.type)}`,
      source: BACKFILL_SOURCE,
    }

    switch (payload.type) {
      case 'message': {
        const role = payload.role
        if (role === 'developer') {
          bump('developer')
          break
        }
        if (role === 'user') {
          const body = contentText(payload.content, 'input_text')
          if (!body) {
            bump('user:wrapper-or-empty')
            break
          }
          if (firstUserText === null) firstUserText = body
          rows.push({
            role: 'user',
            content: body,
            eventId,
            eventTs,
            createdAt,
            lineIndex: i,
            extra: extraBase,
          })
          break
        }
        if (role !== 'assistant') {
          bump(`message:${String(role)}`)
          break
        }
        const body = contentText(payload.content, 'output_text')
        if (!body) {
          bump('assistant:empty')
          break
        }
        rows.push({
          role: 'assistant',
          content: body,
          eventId,
          eventTs,
          createdAt,
          lineIndex: i,
          extra: extraBase,
        })
        break
      }
      case 'reasoning': {
        const chunk = reasoningText(payload)
        if (!chunk) {
          bump('reasoning:empty')
          break
        }
        rows.push({
          role: 'assistant',
          content: `[thinking] ${chunk}`,
          eventId,
          eventTs,
          createdAt,
          lineIndex: i,
          extra: { ...extraBase, partType: 'think' },
        })
        break
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name = asString(payload.name) || asString(payload.tool) || 'unknown'
        const callId = asString(payload.call_id) || asString(payload.id)
        if (callId) toolNameById.set(callId, name)
        rows.push({
          role: 'tool',
          content: `[tool] ${name}`,
          toolName: name,
          toolArgs: parseToolInput(payload.input ?? payload.arguments),
          eventId,
          eventTs,
          createdAt,
          lineIndex: i,
          extra: { ...extraBase, callId },
        })
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = asString(payload.call_id) || asString(payload.id)
        const name = (callId && toolNameById.get(callId)) || 'unknown'
        const err = payload.error
        const isFailure = err != null && err !== false && err !== ''
        const out = payload.output ?? payload.content
        const toolResult = typeof out === 'string' ? out : out != null ? safeJson(out) : null
        rows.push({
          role: 'tool',
          content: isFailure ? `[tool-failure] ${name}` : `[tool-result] ${name}`,
          toolName: name,
          toolResult,
          eventId,
          eventTs,
          createdAt,
          lineIndex: i,
          extra: { ...extraBase, callId, failure: isFailure },
        })
        break
      }
      default:
        bump(`payload:${String(payload.type)}`)
        break
    }
  }

  if (!sessionId) {
    sessionId = (opts.file ? uuidFromRolloutName(path.basename(opts.file)) : undefined) ?? 'unknown'
  }

  return { rows, sessionId, cwd, firstUserText, malformed, skipped }
}

function isDateDir(name: string, width: number): boolean {
  return name.length === width && /^\d+$/.test(name)
}

export function defaultSessionsDir(): string {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')
  return path.join(home, 'sessions')
}

export function discoverTranscripts(root: string): Transcript[] {
  const out: Transcript[] = []
  let years: string[]
  try {
    years = fs.readdirSync(root).sort()
  } catch {
    return out
  }
  for (const year of years) {
    if (!isDateDir(year, 4)) continue
    let months: string[]
    try {
      months = fs.readdirSync(path.join(root, year)).sort()
    } catch {
      continue
    }
    for (const month of months) {
      if (!isDateDir(month, 2)) continue
      let days: string[]
      try {
        days = fs.readdirSync(path.join(root, year, month)).sort()
      } catch {
        continue
      }
      for (const day of days) {
        if (!isDateDir(day, 2)) continue
        const dir = path.join(root, year, month, day)
        let files: string[]
        try {
          files = fs.readdirSync(dir)
        } catch {
          continue
        }
        for (const f of files) {
          const sessionId = uuidFromRolloutName(f)
          if (!sessionId) continue
          const file = path.join(dir, f)
          try {
            if (!fs.statSync(file).isFile()) continue
          } catch {
            continue
          }
          out.push({ file, sessionId })
        }
      }
    }
  }
  return out
}

export interface SessionPlan {
  sessionId: string
  sessionKey: string
  rows: BackfillRow[]
  files: number
  malformed: number
  skipped: Record<string, number>
  cwd: string | null
  title: string
  errors: string[]
  file: string | null
}

export function planSessions(
  transcripts: Transcript[],
  opts: { readFile?: (f: string) => string } = {},
): SessionPlan[] {
  const read = opts.readFile ?? ((f: string) => fs.readFileSync(f, 'utf8'))
  const bySession = new Map<string, SessionPlan>()

  for (const t of transcripts) {
    let plan = bySession.get(t.sessionId)
    if (!plan) {
      plan = {
        sessionId: t.sessionId,
        sessionKey: deriveSessionKey(t.sessionId),
        rows: [],
        files: 0,
        malformed: 0,
        skipped: {},
        cwd: null,
        title: DEFAULT_TITLE,
        errors: [],
        file: t.file,
      }
      bySession.set(t.sessionId, plan)
    }
    plan.files++
    plan.file = t.file
    let text: string
    try {
      text = read(t.file)
    } catch (err) {
      plan.errors.push(`${t.file}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const parsed = parseRollout(text, { sessionId: t.sessionId, file: t.file })
    const abs = path.resolve(t.file)
    for (const row of parsed.rows) {
      row.extra = {
        ...row.extra,
        session_jsonl_path: abs,
        sessionJsonlPath: abs,
        session_jsonl_line: row.lineIndex,
        sessionJsonlLine: row.lineIndex,
      }
    }
    plan.rows.push(...parsed.rows)
    plan.malformed += parsed.malformed
    for (const [k, v] of Object.entries(parsed.skipped)) {
      plan.skipped[k] = (plan.skipped[k] ?? 0) + v
    }
    if (!plan.cwd && parsed.cwd) plan.cwd = parsed.cwd
    if (parsed.firstUserText) {
      plan.title = parsed.firstUserText.replace(/\s+/g, ' ').slice(0, 120)
    }
  }

  return [...bySession.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

export function countRoles(rows: BackfillRow[]): {
  user: number
  assistant: number
  thinking: number
  tool: number
} {
  let user = 0
  let assistant = 0
  let thinking = 0
  let tool = 0
  for (const r of rows) {
    if (r.role === 'user') user++
    else if (r.role === 'tool') tool++
    else if (r.extra.partType === 'think') thinking++
    else assistant++
  }
  return { user, assistant, thinking, tool }
}

export interface CliOptions {
  dryRun: boolean
  offline: boolean
  sessionsDir: string
  pgUrl?: string
  sessionFilter: string[]
  json: boolean
  help: boolean
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: true,
    offline: false,
    sessionsDir: defaultSessionsDir(),
    sessionFilter: [],
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = (): string => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${a} needs a value`)
      i++
      return v
    }
    switch (a) {
      case '--dry-run':
        opts.dryRun = true
        break
      case '--write':
      case '--no-dry-run':
        opts.dryRun = false
        break
      case '--offline':
        opts.offline = true
        break
      case '--sessions-dir':
        opts.sessionsDir = value()
        break
      case '--pg-url':
        opts.pgUrl = value()
        break
      case '--session':
        opts.sessionFilter.push(value())
        break
      case '--json':
        opts.json = true
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        throw new Error(`unknown argument: ${a}`)
    }
  }
  return opts
}

export const USAGE = `codex-transcript-backfill — replay Codex rollout jsonl into RivetOS memory

  codex-rivet-memory-backfill [options]

  --dry-run            report only, write nothing (DEFAULT)
  --write              actually insert (alias: --no-dry-run)
  --offline            dry-run without touching the database at all
  --sessions-dir DIR   default $CODEX_HOME/sessions or ~/.codex/sessions
  --pg-url URL         default $RIVETOS_PG_URL, else ~/.rivetos/.env
  --session ID         only this rollout uuid (repeatable)
  --json               machine-readable summary on stdout
  -h, --help           this text
`

export function resolvePgUrl(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.RIVETOS_PG_URL) return process.env.RIVETOS_PG_URL
  const envFile = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  try {
    const raw = fs.readFileSync(envFile, 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^\s*RIVETOS_PG_URL\s*=\s*(.+?)\s*$/.exec(line)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {
    // fall through
  }
  throw new Error('RIVETOS_PG_URL not set and not found in ~/.rivetos/.env')
}

export function splitByEventId(
  rows: BackfillRow[],
  have: Set<string>,
): { inserted: number; skipped: number } {
  let inserted = 0
  let skipped = 0
  for (const r of rows) {
    if (have.has(r.eventId)) {
      skipped++
      continue
    }
    have.add(r.eventId)
    inserted++
  }
  return { inserted, skipped }
}

export async function runSession(
  client: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
  },
  plan: SessionPlan,
  dryRun: boolean,
): Promise<{ inserted: number; skipped: number }> {
  if (plan.rows.length === 0) return { inserted: 0, skipped: 0 }

  if (dryRun) {
    // SET LOCAL only lives for this transaction; a session SET would leak
    // read-only onto every other client sharing the PGlite session.
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL default_transaction_read_only = on')
      const conv = await client.query(
        `SELECT id FROM ros_conversations WHERE session_key = $1 AND agent = $2`,
        [plan.sessionKey, CAPTURE_AGENT],
      )
      if (conv.rows.length === 0) {
        await client.query('ROLLBACK')
        return splitByEventId(plan.rows, new Set<string>())
      }
      const existing = await client.query(
        `SELECT metadata->>'event_id' AS event_id FROM ros_messages
          WHERE conversation_id = $1 AND metadata->>'event_id' = ANY($2::text[])`,
        [conv.rows[0].id, plan.rows.map((r) => r.eventId)],
      )
      await client.query('ROLLBACK')
      return splitByEventId(plan.rows, new Set(existing.rows.map((r) => String(r.event_id))))
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    }
  }

  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [plan.sessionKey])

    const upserted = await client.query(
      `INSERT INTO ros_conversations (session_key, agent, channel, title, settings, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, NOW(), NOW())
       ON CONFLICT (session_key, agent) DO UPDATE
         SET updated_at = NOW()
       RETURNING id`,
      [
        plan.sessionKey,
        CAPTURE_AGENT,
        CAPTURE_CHANNEL,
        plan.title.slice(0, 120),
        JSON.stringify({
          source: BACKFILL_SOURCE,
          sessionId: plan.sessionId,
          cwd: plan.cwd,
        }),
      ],
    )
    const conversationId = upserted.rows[0].id

    const existing = await client.query(
      `SELECT metadata->>'event_id' AS event_id FROM ros_messages
        WHERE conversation_id = $1 AND metadata->>'event_id' = ANY($2::text[])`,
      [conversationId, plan.rows.map((r) => r.eventId)],
    )
    const have = new Set(existing.rows.map((r) => String(r.event_id)))

    let inserted = 0
    let skipped = 0
    for (const row of plan.rows) {
      if (have.has(row.eventId)) {
        skipped++
        continue
      }
      have.add(row.eventId)

      const content = truncate(row.content)
      const toolResult = row.toolResult == null ? null : truncate(row.toolResult)
      const metadata: Record<string, unknown> = {
        source: BACKFILL_SOURCE,
        event_id: row.eventId,
        event_ts: row.eventTs,
        ...row.extra,
      }
      if (content.truncated) {
        metadata.full_content_length = row.content.length
        metadata.truncated = true
      }
      if (toolResult?.truncated && row.toolResult) {
        metadata.full_tool_result_length = row.toolResult.length
        metadata.truncated = true
      }

      await client.query(
        `INSERT INTO ros_messages
           (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          conversationId,
          CAPTURE_AGENT,
          CAPTURE_CHANNEL,
          row.role,
          content.stored,
          row.toolName ?? null,
          row.toolArgs != null ? JSON.stringify(row.toolArgs) : null,
          toolResult?.stored ?? null,
          JSON.stringify(metadata),
          row.createdAt,
        ],
      )
      inserted++
    }

    await client.query('COMMIT')
    return { inserted, skipped }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  }
}

interface SessionOutcome {
  sessionId: string
  files: number
  user: number
  assistant: number
  thinking: number
  tool: number
  malformed: number
  inserted: number
  skipped: number
  status: string
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}
function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

function printTable(outcomes: SessionOutcome[]): void {
  const head = [
    pad('session', 36),
    padStart('files', 5),
    padStart('user', 5),
    padStart('asst', 5),
    padStart('think', 6),
    padStart('tool', 5),
    padStart('bad', 4),
    padStart('ins', 6),
    padStart('skip', 6),
    'status',
  ].join(' ')
  console.log(head)
  console.log('-'.repeat(head.length))
  for (const o of outcomes) {
    console.log(
      [
        pad(o.sessionId, 36),
        padStart(String(o.files), 5),
        padStart(String(o.user), 5),
        padStart(String(o.assistant), 5),
        padStart(String(o.thinking), 6),
        padStart(String(o.tool), 5),
        padStart(String(o.malformed), 4),
        padStart(String(o.inserted), 6),
        padStart(String(o.skipped), 6),
        o.status,
      ].join(' '),
    )
  }
}

async function main(): Promise<number> {
  let opts: CliOptions
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n`)
    console.error(USAGE)
    return 2
  }
  if (opts.help) {
    console.log(USAGE)
    return 0
  }

  const transcripts = discoverTranscripts(opts.sessionsDir).filter(
    (t) => opts.sessionFilter.length === 0 || opts.sessionFilter.includes(t.sessionId),
  )
  if (transcripts.length === 0) {
    console.error(`no rollout jsonl transcripts under ${opts.sessionsDir}`)
    return 1
  }

  const plans = planSessions(transcripts)
  const outcomes: SessionOutcome[] = []
  let client: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
  } | null = null
  let close: (() => Promise<void>) | null = null

  if (!(opts.dryRun && opts.offline)) {
    const { default: pg } = await import('pg')
    const c = new pg.Client({ connectionString: resolvePgUrl(opts.pgUrl) })
    await c.connect()
    client = c
    close = async () => {
      await c.end()
    }
  }

  try {
    for (const plan of plans) {
      const counts = countRoles(plan.rows)
      let inserted = 0
      let skipped = 0
      let status = plan.errors.length > 0 ? `read-error(${plan.errors.length})` : 'ok'
      if (client) {
        try {
          const r = await runSession(client, plan, opts.dryRun)
          inserted = r.inserted
          skipped = r.skipped
        } catch (err) {
          status = `db-error: ${err instanceof Error ? err.message : String(err)}`
        }
      } else {
        const split = splitByEventId(plan.rows, new Set<string>())
        inserted = split.inserted
        skipped = split.skipped
        status = 'offline'
      }
      outcomes.push({
        sessionId: plan.sessionId,
        files: plan.files,
        ...counts,
        malformed: plan.malformed,
        inserted,
        skipped,
        status,
      })
      for (const e of plan.errors) console.error(`! ${plan.sessionId} ${e}`)
    }
  } finally {
    if (close) await close()
  }

  const total = outcomes.reduce(
    (acc, o) => ({
      files: acc.files + o.files,
      user: acc.user + o.user,
      assistant: acc.assistant + o.assistant,
      thinking: acc.thinking + o.thinking,
      tool: acc.tool + o.tool,
      malformed: acc.malformed + o.malformed,
      inserted: acc.inserted + o.inserted,
      skipped: acc.skipped + o.skipped,
    }),
    {
      files: 0,
      user: 0,
      assistant: 0,
      thinking: 0,
      tool: 0,
      malformed: 0,
      inserted: 0,
      skipped: 0,
    },
  )

  if (opts.json) {
    console.log(
      JSON.stringify(
        { mode: opts.dryRun ? 'dry-run' : 'write', total, sessions: outcomes },
        null,
        2,
      ),
    )
  } else {
    console.log(
      `\ncodex transcript backfill — ${opts.dryRun ? 'DRY RUN (nothing written)' : 'WRITE'}  sessions=${outcomes.length}  dir=${opts.sessionsDir}\n`,
    )
    printTable(outcomes)
    console.log(
      `\ntotals: files=${total.files} user=${total.user} assistant=${total.assistant} thinking=${total.thinking} tool=${total.tool} malformed=${total.malformed} ${opts.dryRun ? 'would-insert' : 'inserted'}=${total.inserted} skipped=${total.skipped}`,
    )
    if (opts.dryRun) console.log('\nre-run with --write to commit.')
  }

  return outcomes.some((o) => o.status.startsWith('db-error')) ? 1 : 0
}

const invokedDirectly =
  process.argv[1] !== undefined && /codex-transcript-backfill\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      console.error(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
      process.exitCode = 1
    })
}
