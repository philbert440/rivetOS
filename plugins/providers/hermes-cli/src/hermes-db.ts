/**
 * Read-only access to ~/.hermes/state.db — same node:sqlite module and
 * HERMES_HOME path the den uses (services/den-server/src/term/hermes-db.ts).
 * Best-effort: missing file, missing module, or a schema without token
 * columns all yield empty usage rather than throwing.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV3Usage } from '@ai-sdk/provider'

export interface SqliteRow {
  [k: string]: unknown
}
export interface SqliteStmt {
  all(...params: unknown[]): SqliteRow[]
  get(...params: unknown[]): SqliteRow | undefined
}
export interface SqliteDb {
  prepare(sql: string): SqliteStmt
  close(): void
}

export interface HermesTokenCounts {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

/** Where the counts came from — resume accounting depends on this. */
export type HermesTokenKind = 'session-total' | 'message' | 'unknown'

export interface HermesTokenSnapshot {
  kind: HermesTokenKind
  counts: HermesTokenCounts
}

const require_ = createRequire(import.meta.url)

export const UNKNOWN_TOKENS: HermesTokenSnapshot = { kind: 'unknown', counts: {} }

export function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

/** ~/.hermes/state.db (respects HERMES_HOME). */
export function hermesDbPath(): string {
  const base = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
  return join(base, 'state.db')
}

/** Open the hermes DB read-only. Returns null if the file or node:sqlite
 *  (Node ≥22.5, still experimental) is unavailable. */
export function openHermesDb(dbPath: string = hermesDbPath()): SqliteDb | null {
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

function tokenNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return undefined
}

function hasCounts(counts: HermesTokenCounts): boolean {
  return (
    counts.input !== undefined ||
    counts.output !== undefined ||
    counts.cacheRead !== undefined ||
    counts.cacheWrite !== undefined ||
    counts.reasoning !== undefined
  )
}

function hasSessionTotals(counts: HermesTokenCounts): boolean {
  return counts.input !== undefined || counts.output !== undefined
}

/** Pull input/output/cache/reasoning token fields off a sessions or messages row. */
export function tokensFromRow(row: SqliteRow | undefined): HermesTokenCounts {
  if (!row) return {}
  const input =
    tokenNum(row.input_tokens) ?? tokenNum(row.prompt_tokens) ?? tokenNum(row.tokens_input)
  const output =
    tokenNum(row.output_tokens) ??
    tokenNum(row.completion_tokens) ??
    tokenNum(row.tokens_output) ??
    tokenNum(row.token_count)
  const cacheRead = tokenNum(row.cache_read_tokens)
  const cacheWrite = tokenNum(row.cache_write_tokens)
  const reasoning = tokenNum(row.reasoning_tokens)
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  }
}

export function usageFromTokens(counts: HermesTokenCounts): LanguageModelV3Usage {
  if (!hasCounts(counts)) return emptyUsage()
  return {
    inputTokens: {
      total: counts.input,
      // Unknown — do not claim all input was uncached just because we have a total.
      noCache: undefined,
      cacheRead: counts.cacheRead,
      cacheWrite: counts.cacheWrite,
    },
    outputTokens: { total: counts.output, text: counts.output, reasoning: counts.reasoning },
  }
}

function deltaField(before: number | undefined, after: number | undefined): number | undefined {
  if (after === undefined || before === undefined) return undefined
  return Math.max(0, after - before)
}

/** Per-turn usage when session totals are cumulative (resume).
 *  A missing baseline field is unknown, not zero. */
export function usageDelta(before: HermesTokenCounts, after: HermesTokenCounts): HermesTokenCounts {
  const input = deltaField(before.input, after.input)
  const output = deltaField(before.output, after.output)
  const cacheRead = deltaField(before.cacheRead, after.cacheRead)
  const cacheWrite = deltaField(before.cacheWrite, after.cacheWrite)
  const reasoning = deltaField(before.reasoning, after.reasoning)
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  }
}

/**
 * Per-turn counts from a pre-spawn baseline and a post-exit snapshot.
 * Delta only for cumulative session totals with a known session-total
 * baseline; message rows are reported as-is; unknown → empty.
 */
export function tokensForTurn(
  resumed: boolean,
  prior: HermesTokenSnapshot,
  after: HermesTokenSnapshot,
): HermesTokenCounts {
  if (after.kind === 'unknown') return {}
  if (after.kind === 'message') return after.counts
  if (!resumed) return after.counts
  if (prior.kind !== 'session-total') return {}
  return usageDelta(prior.counts, after.counts)
}

/**
 * Session totals if present, else the latest assistant message's token
 * columns. `kind: 'unknown'` when the DB or row is unreadable.
 */
export function readHermesSessionTokens(
  sessionId: string,
  dbPath: string = hermesDbPath(),
): HermesTokenSnapshot {
  if (!sessionId) return UNKNOWN_TOKENS
  const db = openHermesDb(dbPath)
  if (!db) return UNKNOWN_TOKENS
  try {
    let sessionTokens: HermesTokenCounts = {}
    try {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ? LIMIT 1').get(sessionId)
      sessionTokens = tokensFromRow(session)
    } catch {
      /* older schema without a sessions table */
    }
    if (hasSessionTotals(sessionTokens)) {
      return { kind: 'session-total', counts: sessionTokens }
    }
    try {
      const msg = db
        .prepare(
          `SELECT * FROM messages
           WHERE session_id = ? AND role = 'assistant'
           ORDER BY timestamp DESC, rowid DESC
           LIMIT 1`,
        )
        .get(sessionId)
      const counts = tokensFromRow(msg)
      if (hasCounts(counts)) return { kind: 'message', counts }
      return UNKNOWN_TOKENS
    } catch {
      return UNKNOWN_TOKENS
    }
  } catch {
    return UNKNOWN_TOKENS
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

export function readHermesUsage(
  sessionId: string,
  dbPath: string = hermesDbPath(),
): LanguageModelV3Usage {
  return usageFromTokens(readHermesSessionTokens(sessionId, dbPath).counts)
}
