import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * OpenCode sessions live in SQLite, not files:
 *   `$XDG_DATA_HOME/opencode/opencode.db` else `~/.local/share/opencode/opencode.db`
 * (WAL mode; `-shm`/`-wal` siblings sit next to the db).
 *
 * Same sqlite module + read-only open flags as `hermes-db.ts`.
 */
export function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim()
  return join(xdg || join(homedir(), '.local', 'share'), 'opencode')
}

export function opencodeDbPath(): string {
  return join(opencodeDataDir(), 'opencode.db')
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

/** Open the OpenCode DB read-only. Returns null if the file or node:sqlite
 *  (Node ≥22.5, still experimental) is unavailable — the drawer degrades to
 *  empty for opencode rather than erroring. */
export function openOpencodeDb(): SqliteDb | null {
  const dbPath = opencodeDbPath()
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
