/**
 * @rivetos/memory-sqlite
 *
 * SQLite Memory backend — WAL + FTS5 for zero-start capture.
 * Phase 1: append, history, settings, FTS search behind the Memory contract.
 */

export { SqliteMemory, resolveSqlitePath, buildFtsMatchQuery } from './adapter.js'
export type { SqliteMemoryConfig } from './adapter.js'
export { SCHEMA } from './schema.js'

import { homedir } from 'node:os'
import type { PluginManifest } from '@rivetos/types'
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
    return Promise.resolve()
  },
}
