/**
 * wire — JSON event interpretation plus the SQLite half of the opencode
 * executor: finding a session in `opencode.db` and reading back usage stdout
 * may not have carried.
 *
 * `--format json` event lines are the same objects as `message`/`part` rows
 * (user/assistant envelopes, then parts). Parse defensively by `type`;
 * unknown → ignore.
 *
 * Sessions live in SQLite (WAL): `$XDG_DATA_HOME/opencode/opencode.db` else
 * `~/.local/share/opencode/opencode.db`. This module is deliberately POST-HOC:
 * the executor reads it after the child has exited. Never throws: an
 * unreadable db or a torn row degrades the numbers.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

/** `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`. */
export function opencodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim()
  if (xdg && xdg.length > 0) return path.join(xdg, 'opencode')
  return path.join(os.homedir(), '.local', 'share', 'opencode')
}

export function opencodeDbPath(home: string): string {
  return path.join(home, 'opencode.db')
}

/**
 * XDG_DATA_HOME to point the CLI at `dataDir`. If `dataDir` ends with
 * `/opencode`, the parent is the XDG root; otherwise the path itself (the
 * CLI will then write `$XDG_DATA_HOME/opencode`).
 */
export function xdgDataHomeFor(dataDir: string): string {
  return path.basename(dataDir) === 'opencode' ? path.dirname(dataDir) : dataDir
}

/**
 * Directory that actually holds `opencode.db`. A configured home that is an
 * XDG root (`/tmp/oc-data`) maps to `<home>/opencode`; a home that already
 * ends with `/opencode` is used as-is. Matches the path the CLI writes when
 * `XDG_DATA_HOME` is set via `xdgDataHomeFor`.
 */
export function effectiveOpencodeHome(home: string): string {
  return path.basename(home) === 'opencode' ? home : path.join(home, 'opencode')
}

interface SqliteRow {
  [k: string]: unknown
}
interface SqliteStmt {
  all(...params: unknown[]): SqliteRow[]
  get(...params: unknown[]): SqliteRow | undefined
}
interface SqliteDb {
  prepare(sql: string): SqliteStmt
  close(): void
}

const require_ = createRequire(import.meta.url)

function openDb(home: string): SqliteDb | null {
  const dbPath = opencodeDbPath(home)
  if (!existsSync(dbPath)) return null
  try {
    const { DatabaseSync } = require_('node:sqlite') as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => SqliteDb
    }
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
}

export interface SessionIndexEntry {
  sessionId: string
  workDir?: string
  timeCreated?: number
}

/**
 * Every session id opencode knows for `cwd` (session.directory).
 */
export function listSessionIds(home: string, cwd: string): Set<string> {
  const ids = new Set<string>()
  const cwdResolved = path.resolve(cwd)
  const db = openDb(home)
  if (!db) return ids
  try {
    const rows = db.prepare(`SELECT id, directory FROM session`).all()
    for (const r of rows) {
      const id = typeof r.id === 'string' ? r.id : ''
      if (!id) continue
      const dir = typeof r.directory === 'string' ? r.directory : undefined
      if (dir !== undefined && path.resolve(dir) !== cwdResolved) continue
      ids.add(id)
    }
  } catch {
    return ids
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
  return ids
}

/**
 * Newest `session` row for this cwd with `time_created >= sinceMs`.
 * Fallback when the JSON stream carried no `sessionID` (every real
 * `--format json` line has one). Concurrent tasks in the same cwd can
 * otherwise steal each other's newest row.
 */
export function newestSessionAfter(home: string, cwd: string, sinceMs: number): string | undefined {
  const db = openDb(home)
  if (!db) return undefined
  try {
    const cwdResolved = path.resolve(cwd)
    const rows = db
      .prepare(
        `SELECT id, directory, time_created FROM session
         WHERE time_created >= ?
         ORDER BY time_created DESC, time_updated DESC`,
      )
      .all(sinceMs)
    for (const r of rows) {
      const id = typeof r.id === 'string' ? r.id : ''
      if (!id) continue
      const dir = typeof r.directory === 'string' ? r.directory : undefined
      if (dir !== undefined && path.resolve(dir) !== cwdResolved) continue
      return id
    }
    return undefined
  } catch {
    return undefined
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Stream JSON → tagged event
// ---------------------------------------------------------------------------

export type ParsedOpencodeKind =
  'text' | 'tool-start' | 'tool-end' | 'usage' | 'session' | 'error' | 'other'

export interface ParsedOpencodeEvent {
  kind: ParsedOpencodeKind
  sessionId?: string
  text?: string
  tool?: string
  toolCallId?: string
  usage?: { inputTokens: number; outputTokens: number }
  error?: string
  raw: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function tokensToUsage(tokens: Record<string, unknown>): {
  inputTokens: number
  outputTokens: number
} {
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined
  return {
    inputTokens: num(tokens.input) + num(cache?.read) + num(cache?.write),
    outputTokens: num(tokens.output) + num(tokens.reasoning),
  }
}

function sessionIdOf(
  rec: Record<string, unknown>,
  nested?: Record<string, unknown>,
): string | undefined {
  return (
    str(rec.sessionID) ??
    str(rec.sessionId) ??
    str(rec.session_id) ??
    (isRecord(rec.session) ? str(rec.session.id) : undefined) ??
    (nested
      ? (str(nested.sessionID) ?? str(nested.sessionId) ?? str(nested.session_id))
      : undefined)
  )
}

/**
 * Interpret one JSON object from `opencode run --format json`.
 *
 * Real 1.18.30 `--format json` lines are
 * `{type:"step_finish"|"step_start"|"text"|"reasoning"|"tool"…, timestamp,
 * sessionID, part}` — the payload is under `part`, tokens are in
 * `part.tokens` on `step_finish`, and `sessionID` is on every line. There is
 * no `role:"assistant"` envelope on stdout (that shape exists only in DB
 * `message` rows). Hyphenated `step-finish` / top-level `tokens` are still
 * accepted. Unknown types are `other`, never fatal.
 */
export function parseOpencodeEvent(row: unknown): ParsedOpencodeEvent | undefined {
  if (!isRecord(row)) return undefined
  const type = typeof row.type === 'string' ? row.type : ''
  const part = isRecord(row.part) ? row.part : undefined
  const sessionId = sessionIdOf(row, part)
  const partType = part ? str(part.type) : undefined
  const role = str(row.role)

  if (type === 'text' || partType === 'text') {
    const text = str(row.text) ?? (part ? str(part.text) : undefined) ?? ''
    return { kind: 'text', sessionId, text, raw: row }
  }

  if (type === 'reasoning' || type === 'thinking' || partType === 'reasoning') {
    return { kind: 'other', sessionId, raw: row }
  }

  const isTool =
    type === 'tool' ||
    type === 'tool_use' ||
    type === 'tool_result' ||
    type === 'tool-result' ||
    partType === 'tool'
  if (isTool) {
    const tool = str(row.tool) ?? (part ? str(part.tool) : undefined) ?? 'tool'
    const toolCallId =
      str(row.callID) ??
      str(row.toolCallId) ??
      str(row.tool_call_id) ??
      str(row.id) ??
      (part ? (str(part.callID) ?? str(part.id)) : undefined)
    const state =
      part && isRecord(part.state) ? part.state : isRecord(row.state) ? row.state : undefined
    const status = state ? str(state.status) : undefined
    const ended =
      type === 'tool_result' ||
      type === 'tool-result' ||
      status === 'completed' ||
      status === 'error'
    return {
      kind: ended ? 'tool-end' : 'tool-start',
      sessionId,
      tool,
      toolCallId,
      raw: row,
    }
  }

  if (
    type === 'step-finish' ||
    type === 'step_finish' ||
    type === 'step.finish' ||
    type === 'usage'
  ) {
    const tokens = isRecord(row.tokens)
      ? row.tokens
      : part && isRecord(part.tokens)
        ? part.tokens
        : undefined
    const usage = tokens ? tokensToUsage(tokens) : undefined
    return { kind: usage ? 'usage' : 'other', sessionId, usage, raw: row }
  }

  if (role === 'assistant' && isRecord(row.tokens)) {
    return { kind: 'usage', sessionId, usage: tokensToUsage(row.tokens), raw: row }
  }

  if (type === 'error' || type === 'session.error') {
    const err = isRecord(row.error) ? row.error : undefined
    return {
      kind: 'error',
      sessionId,
      error: str(row.message) ?? (err ? str(err.message) : undefined) ?? 'opencode error',
      raw: row,
    }
  }

  if (
    type === 'session' ||
    type === 'session.created' ||
    type === 'step-start' ||
    type === 'step_start'
  ) {
    return { kind: sessionId ? 'session' : 'other', sessionId, raw: row }
  }

  return { kind: 'other', sessionId, raw: row }
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export interface WireTurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface WireTurnEnd {
  reason: string
  turnId?: number
  durationMs?: number
  timeMs: number
}

export interface WireTurnFacts {
  usage: WireTurnUsage
  /** Assistant message rows counted into `usage`. Zero means "found nothing". */
  usageRecords: number
  /** Newest completed assistant message at or after the spawn clock. */
  turnEnded?: WireTurnEnd
  /** Message rows read. */
  files: number
  /** Rows that were not parseable JSON — tolerated, never fatal. */
  malformed: number
}

export function emptyWireTurnFacts(): WireTurnFacts {
  return {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    usageRecords: 0,
    files: 0,
    malformed: 0,
  }
}

function parseData(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) return raw
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Sum one turn's usage out of a session's message rows.
 *
 * `sinceMs` is the spawn clock: a resumed session's rows hold every previous
 * turn too, so the floor is what separates this turn from its predecessors.
 *
 * Never throws: an unreadable db or a torn body degrades the numbers, and
 * zero usage is a truthful "we could not tell", not a failed turn.
 */
export function reconcileTurn(opts: {
  home: string
  sessionId: string
  sinceMs: number
}): WireTurnFacts {
  const facts = emptyWireTurnFacts()
  const db = openDb(opts.home)
  if (!db) return facts
  try {
    const rows = db
      .prepare(
        `SELECT data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC`,
      )
      .all(opts.sessionId)
    for (const r of rows) {
      facts.files += 1
      const row = parseData(r.data)
      if (!row) {
        facts.malformed += 1
        continue
      }
      const role = str(row.role)
      if (role !== 'assistant') continue
      const time = isRecord(row.time) ? row.time : undefined
      const timeMs =
        typeof time?.completed === 'number'
          ? time.completed
          : typeof time?.created === 'number'
            ? time.created
            : typeof r.time_created === 'number'
              ? r.time_created
              : undefined
      if (timeMs === undefined || timeMs < opts.sinceMs) continue
      const tokens = isRecord(row.tokens) ? row.tokens : undefined
      if (tokens === undefined) continue
      const usage = tokensToUsage(tokens)
      facts.usage.inputTokens += usage.inputTokens
      facts.usage.outputTokens += usage.outputTokens
      facts.usageRecords += 1
      const ended: WireTurnEnd = { reason: 'completed', timeMs }
      if (facts.turnEnded === undefined || ended.timeMs >= facts.turnEnded.timeMs) {
        facts.turnEnded = ended
      }
    }
    facts.usage.totalTokens = facts.usage.inputTokens + facts.usage.outputTokens
    return facts
  } catch {
    return facts
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}
