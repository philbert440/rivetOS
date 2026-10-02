/**
 * @rivetos/memory-sqlite
 *
 * SQLite Memory backend — WAL + FTS5 for the in-process Memory contract.
 * Phase 1: append, history, settings, FTS search. HTTP /api/capture is deferred.
 */

export {
  SqliteMemory,
  resolveSqlitePath,
  buildFtsMatchQuery,
  relevanceFromBm25,
  resolveTaskId,
  ensureSqliteParentDir,
  restrictSqliteFileModes,
} from './adapter.js'
export type { SqliteMemoryConfig } from './adapter.js'
export { SCHEMA, SCHEMA_VERSION } from './schema.js'

import { homedir } from 'node:os'
import type { PluginManifest } from '@rivetos/types'
import { loadUsersRegistry } from '@rivetos/types'
import { SqliteMemory, resolveSqlitePath } from './adapter.js'

export const manifest: PluginManifest = {
  type: 'memory',
  name: 'sqlite',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    const rawPath = typeof cfg.path === 'string' ? cfg.path.trim() : ''
    if (!rawPath) {
      ctx.logger.warn('memory.sqlite.path is missing — sqlite memory not registered')
      return Promise.resolve()
    }

    const path = resolveSqlitePath(rawPath)
    const memory = new SqliteMemory({ path })
    ctx.registerMemory(memory)
    ctx.registerShutdown(() => {
      memory.close()
    })

    const display =
      path === ':memory:'
        ? ':memory:'
        : path.startsWith(homedir())
          ? `~${path.slice(homedir().length)}`
          : path
    ctx.logger.info(`sqlite memory ready at ${display}`)

    // Phase 1 is single-file / single-user. Warn when a users registry defines
    // additional accounts so operators know transcripts are not isolated.
    try {
      const registry = loadUsersRegistry(ctx.env)
      if (registry) {
        const others = Object.keys(registry.users).filter((id) => id !== registry.ownerUserId)
        if (others.length > 0) {
          ctx.logger.warn(
            `memory.sqlite is single-user in phase 1 — ${others.length} routed user(s) in the users registry share this file; per-user isolation is deferred`,
          )
        }
      }
    } catch {
      // registry load failures are unrelated to opening the store
    }

    return Promise.resolve()
  },
}
