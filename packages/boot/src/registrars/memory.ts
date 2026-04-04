/**
 * Memory Registrar — sets up PostgreSQL-backed memory with search, embedding, and compaction.
 */

import type { Runtime } from '@rivetos/core'
import type { RivetConfig } from '../config.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Memory')

export async function registerMemory(runtime: Runtime, config: RivetConfig): Promise<void> {
  if (!config.memory?.postgres) return

  const pgConfig = config.memory.postgres
  const connectionString =
    (pgConfig.connection_string as string | undefined) ?? process.env.RIVETOS_PG_URL ?? ''

  if (!connectionString) return

  try {
    const { PostgresMemory, createMemoryTools, BackgroundEmbedder, BackgroundCompactor } =
      await import('@rivetos/memory-postgres')

    const memory = new PostgresMemory({ connectionString })
    runtime.registerMemory(memory)

    // Use the adapter's internal pool and engines (no duplicate pool)
    const searchEngine = memory.getSearchEngine()
    const expander = memory.getExpander()

    const compactorEndpoint =
      (pgConfig.compactor_endpoint as string | undefined) ?? process.env.RIVETOS_COMPACTOR_URL ?? ''
    const compactorModel = (pgConfig.compactor_model as string | undefined) ?? 'rivet-v0.1'

    const memoryTools = createMemoryTools(searchEngine, expander, {
      compactorEndpoint: compactorEndpoint || undefined,
      compactorModel,
      pool: memory.getPool(),
    })

    for (const tool of memoryTools) {
      runtime.registerTool(tool)
    }

    // Background embedder
    const embedEndpoint =
      (pgConfig.embed_endpoint as string | undefined) ?? process.env.RIVETOS_EMBED_URL ?? ''
    if (embedEndpoint) {
      const embedder = new BackgroundEmbedder({
        connectionString,
        embedEndpoint,
        batchSize: 10,
        intervalMs: 30000,
      })
      embedder.start()
    }

    // Background compactor
    if (compactorEndpoint) {
      const compactor = new BackgroundCompactor({
        connectionString,
        compactorEndpoint,
        compactorModel,
        intervalMs: 1_800_000, // 30 minutes
      })
      compactor.start()
      log.info(`Compactor: ${compactorEndpoint} (model: ${compactorModel})`)
    }

    log.info('Memory: postgres (ros_* tables)')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`Failed to initialize memory: ${message}`)
  }
}
