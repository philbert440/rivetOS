/**
 * Runtime path resolution helpers shared by CLI commands.
 *
 * The migrate runner and the embedding/compaction workers ship alongside
 * `@rivetos/memory-postgres`. They run as separate processes (DDL/pg-pool
 * isolation, GPU vs CPU split) and are resolved at runtime:
 *
 *   workspace dev    → walk up from this file to the repo root, then
 *                      plugins/memory/postgres/{dist/schema,workers}/...
 *   container bundle → /app/plugins/memory/postgres/{dist/schema,workers}/...
 *   npm install      → node_modules/@rivetos/memory-postgres/...
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const MIGRATE_CANDIDATES = [
  'plugins/memory/postgres/dist/schema/migrate.js',
  'node_modules/@rivetos/memory-postgres/dist/schema/migrate.js',
]

const WORKER_CANDIDATES: Record<'embedding' | 'compaction', string[]> = {
  embedding: [
    'plugins/memory/postgres/workers/embedding/index.js',
    'node_modules/@rivetos/memory-postgres/workers/embedding/index.js',
  ],
  compaction: [
    'plugins/memory/postgres/workers/compaction/index.js',
    'node_modules/@rivetos/memory-postgres/workers/compaction/index.js',
  ],
}

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

export function resolveMemoryWorkerScript(name: 'embedding' | 'compaction'): string | null {
  return walkUp(WORKER_CANDIDATES[name])
}
