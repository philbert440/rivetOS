/**
 * Runtime path resolution helpers shared by CLI commands.
 *
 * The migrate runner ships as a separate JS file under `@rivetos/memory-postgres`
 * (it must be a separate process so DDL doesn't share the CLI's pg pool). We
 * resolve it at runtime depending on how the CLI is installed:
 *
 *   workspace dev        → walk up from this file to the repo root, then
 *                          plugins/memory/postgres/dist/schema/migrate.js
 *   container bundle     → /app/plugins/memory/postgres/dist/schema/migrate.js
 *                          (the Dockerfile copies the plugin's dist/ subtree)
 *   npm install          → node_modules/@rivetos/memory-postgres/dist/schema/migrate.js
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const RELATIVE_CANDIDATES = [
  'plugins/memory/postgres/dist/schema/migrate.js',
  'node_modules/@rivetos/memory-postgres/dist/schema/migrate.js',
]

export function resolveMemoryMigrateScript(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let i = 0; i < 12; i++) {
    for (const rel of RELATIVE_CANDIDATES) {
      const candidate = resolve(dir, rel)
      if (existsSync(candidate)) return candidate
    }
    const next = dirname(dir)
    if (next === dir) break
    dir = next
  }
  return null
}
