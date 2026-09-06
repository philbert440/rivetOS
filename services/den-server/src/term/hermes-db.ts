import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** ~/.hermes/state.db (respects HERMES_HOME). */
export function hermesDbPath(): string {
  const base = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
  return join(base, 'state.db')
}

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

const require_ = createRequire(import.meta.url)

/** Open the hermes DB read-only. Returns null if the file or node:sqlite
 *  (Node ≥22.5, still experimental) is unavailable — the drawer degrades to
 *  empty for hermes rather than erroring. */
export function openHermesDb(): SqliteDb | null {
  const dbPath = hermesDbPath()
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
