/**
 * Runtime path resolution helpers shared by CLI commands.
 *
 * The migrate runner ships alongside `@rivetos/memory-postgres`. It runs as a
 * separate process (DDL isolation) and is resolved at runtime:
 *
 *   workspace dev    → walk up from this file to the repo root, then
 *                      plugins/memory/postgres/dist/schema/...
 *   container bundle → /app/plugins/memory/postgres/dist/schema/...
 *   npm install      → node_modules/@rivetos/memory-postgres/dist/schema/...
 *
 * The embedding and compaction workers live at services/{embedding,compaction}-worker/
 * and run as their own systemd units; they are not launched via this CLI.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const MIGRATE_CANDIDATES = [
  'plugins/memory/postgres/dist/schema/migrate.js',
  'node_modules/@rivetos/memory-postgres/dist/schema/migrate.js',
]

function walkUp(candidates: string[]): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let i = 0; i < 12; i++) {
    for (const rel of candidates) {
      const candidate = resolve(dir, rel)
      if (existsSync(candidate)) return candidate
    }
    const next = dirname(dir)
    if (next === dir) break
    dir = next
  }
  return null
}

export function resolveMemoryMigrateScript(): string | null {
  return walkUp(MIGRATE_CANDIDATES)
}
