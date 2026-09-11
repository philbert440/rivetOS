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
}

const require_ = createRequire(import.meta.url)

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

/** Pull input/output token fields off a sessions or messages row. */
export function tokensFromRow(row: SqliteRow | undefined): HermesTokenCounts {
  if (!row) return {}
  const input =
    tokenNum(row.input_tokens) ?? tokenNum(row.prompt_tokens) ?? tokenNum(row.tokens_input)
  const output =
    tokenNum(row.output_tokens) ??
    tokenNum(row.completion_tokens) ??
    tokenNum(row.tokens_output) ??
    tokenNum(row.token_count)
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  }
}

export function usageFromTokens(counts: HermesTokenCounts): LanguageModelV3Usage {
  if (counts.input === undefined && counts.output === undefined) return emptyUsage()
  return {
    inputTokens: {
      total: counts.input,
      noCache: counts.input,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: counts.output, text: counts.output, reasoning: undefined },
  }
}

/** Per-turn usage when session totals are cumulative (resume). */
export function usageDelta(before: HermesTokenCounts, after: HermesTokenCounts): HermesTokenCounts {
  const input =
    after.input !== undefined ? Math.max(0, after.input - (before.input ?? 0)) : undefined
  const output =
    after.output !== undefined ? Math.max(0, after.output - (before.output ?? 0)) : undefined
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  }
}

/**
 * Session totals if present, else the latest assistant message's token
 * columns. Empty object when the DB or row is unreadable.
 */
export function readHermesSessionTokens(
  sessionId: string,
  dbPath: string = hermesDbPath(),
): HermesTokenCounts {
  if (!sessionId) return {}
  const db = openHermesDb(dbPath)
  if (!db) return {}
  try {
    let sessionTokens: HermesTokenCounts = {}
    try {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ? LIMIT 1').get(sessionId)
      sessionTokens = tokensFromRow(session)
    } catch {
      /* older schema without a sessions table */
    }
    if (sessionTokens.input !== undefined || sessionTokens.output !== undefined) {
      return sessionTokens
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
      return tokensFromRow(msg)
    } catch {
      return {}
    }
  } catch {
    return {}
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
  return usageFromTokens(readHermesSessionTokens(sessionId, dbPath))
}
