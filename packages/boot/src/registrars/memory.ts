/**
 * Memory Registrar — sets up PostgreSQL-backed memory with search, embedding, compaction,
 * and the background review loop (M4.2).
 */

import type { Runtime } from '@rivetos/core'
import type {
  Memory,
  Tool,
  HookPipeline,
  TurnAfterContext,
  DelegationAfterContext,
} from '@rivetos/types'
import type { RivetConfig } from '../config.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Memory')

// ---------------------------------------------------------------------------
// Module type for dynamic import of @rivetos/memory-postgres
// ---------------------------------------------------------------------------

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

interface PostgresMemoryInstance extends Memory {
  getSearchEngine(): unknown
  getExpander(): unknown
  getPool(): PgPool
}

interface MemoryPostgresModule {
  PostgresMemory: new (opts: { connectionString: string }) => PostgresMemoryInstance
  createMemoryTools: (
    searchEngine: unknown,
    expander: unknown,
    opts: Record<string, unknown>,
  ) => Tool[]
  BackgroundEmbedder: new (opts: Record<string, unknown>) => { start(): void }
  BackgroundCompactor: new (opts: Record<string, unknown>) => { start(): void }
  ensureEmbedderSchema: (pool: PgPool) => Promise<void>
  ReviewLoop: new (opts: Record<string, unknown>) => {
    onTurnComplete(ctx: Record<string, unknown>): void
  }
}

export async function registerMemory(
  runtime: Runtime,
  config: RivetConfig,
  hooks?: HookPipeline,
): Promise<void> {
  if (!config.memory?.postgres) return

  const pgConfig = config.memory.postgres
  const connectionString =
    (pgConfig.connection_string as string | undefined) ?? process.env.RIVETOS_PG_URL ?? ''

  if (!connectionString) return

  try {
    // Dynamic import — resolved at runtime via npm workspaces, not at compile time.
    // Using a variable prevents TypeScript from statically resolving the module.
    const memoryPkg = '@rivetos/memory-postgres'
    const {
      PostgresMemory,
      createMemoryTools,
      BackgroundEmbedder,
      BackgroundCompactor,
      ensureEmbedderSchema,
      ReviewLoop,
    } = (await import(memoryPkg)) as MemoryPostgresModule

    const memory: PostgresMemoryInstance = new PostgresMemory({ connectionString })
    runtime.registerMemory(memory)

    // Use the adapter's internal pool and engines (no duplicate pool)
    const searchEngine = memory.getSearchEngine()
    const expander = memory.getExpander()

    const compactorEndpoint =
      (pgConfig.compactor_endpoint as string | undefined) ?? process.env.RIVETOS_COMPACTOR_URL ?? ''
    const compactorModel = (pgConfig.compactor_model as string | undefined) ?? 'rivet-v0.1'
    const compactorApiKey =
      (pgConfig.compactor_api_key as string | undefined) ??
      process.env.RIVETOS_COMPACTOR_API_KEY ??
      ''
    const compactorConcurrency = (pgConfig.compactor_concurrency as number | undefined) ?? 1

    const memoryTools = createMemoryTools(searchEngine, expander, {
      compactorEndpoint: compactorEndpoint || undefined,
      compactorModel,
      compactorApiKey: compactorApiKey || undefined,
      pool: memory.getPool(),
    })

    for (const tool of memoryTools) {
      runtime.registerTool(tool)
    }

    // Background embedder
    const embedEndpoint =
      (pgConfig.embed_endpoint as string | undefined) ?? process.env.RIVETOS_EMBED_URL ?? ''
    if (embedEndpoint) {
      // Ensure embed_failures / embed_error columns exist
      await ensureEmbedderSchema(memory.getPool())

      const embedder = new BackgroundEmbedder({
        connectionString,
        embedEndpoint,
        batchSize: 50,
        apiBatchSize: 8,
        intervalMs: 30_000,
        maxRetries: 3,
        maxFailures: 3,
      })
      embedder.start()
      log.info(`Embedder: ${embedEndpoint} (batch 50, api batch 8)`)
    }

    // Background compactor
    if (compactorEndpoint) {
      const compactor = new BackgroundCompactor({
        connectionString,
        compactorEndpoint,
        compactorModel,
        compactorApiKey: compactorApiKey || undefined,
        compactorConcurrency,
        intervalMs: 1_800_000, // 30 minutes
      })
      compactor.start()
      log.info(`Compactor: ${compactorEndpoint} (model: ${compactorModel}, concurrency: ${compactorConcurrency})`)
    }

    // Background review loop (M4.2) — turn counting + background LLM review
    if (hooks && compactorEndpoint) {
      const reviewLoop = new ReviewLoop({
        reviewEndpoint: compactorEndpoint,
        reviewModel: compactorModel,
        reviewApiKey: compactorApiKey || undefined,
        reviewConcurrency: compactorConcurrency,
        pool: memory.getPool(),
        turnThreshold: 10,
        iterationThreshold: 15,
        verbose: true,
      })

      hooks.register({
        id: 'memory:review-loop',
        event: 'turn:after',
        priority: 95, // Run very late — after all other turn:after hooks
        description: 'Background memory review — counts turns and triggers LLM review',
        onError: 'continue', // NEVER block a turn for review
        handler: (ctx: TurnAfterContext) => {
          // Only review non-aborted turns
          if (ctx.aborted) return

          // Detect error recovery: same tool appearing consecutively
          const hadErrorRecovery = ctx.toolsUsed.some((t, i) => i > 0 && ctx.toolsUsed[i - 1] === t)

          reviewLoop.onTurnComplete({
            agentId: ctx.agentId ?? 'unknown',
            sessionId: ctx.sessionId ?? 'unknown',
            response: ctx.response,
            toolsUsed: ctx.toolsUsed,
            iterations: ctx.iterations,
            hadErrorRecovery,
            hadUserCorrection: Boolean(ctx.metadata.hadSteer),
            usage: ctx.usage,
          })

          // Return immediately — review runs in background
          return
        },
      })

      log.info('Review loop: active (threshold: 10 turns)')

      // Delegation tracking — persist delegation events for learning and auditing
      hooks.register({
        id: 'memory:delegation-tracker',
        event: 'delegation:after',
        priority: 90,
        description: 'Persist delegation events for learning and auditing',
        onError: 'continue',
        handler: async (ctx: DelegationAfterContext) => {
          const parts = [
            `Delegation: ${ctx.fromAgent} → ${ctx.toAgent}`,
            `Task: ${ctx.task.slice(0, 200)}`,
            `Status: ${ctx.status}`,
            `Duration: ${String(ctx.durationMs)}ms`,
          ]
          if (ctx.toolsUsed?.length) parts.push(`Tools: ${ctx.toolsUsed.join(', ')}`)
          if (ctx.cached) parts.push('(cached result)')
          const insight = parts.join(' | ')

          const pool = memory.getPool()
          const conv = await pool.query(
            `SELECT id FROM ros_conversations WHERE agent = $1 AND active = true ORDER BY updated_at DESC LIMIT 1`,
            [ctx.agentId],
          )
          if (conv.rows.length === 0) return
          const convId = conv.rows[0].id as string

          await pool.query(
            `INSERT INTO ros_messages (conversation_id, agent, channel, role, content, metadata, created_at)
             VALUES ($1, $2, 'delegation', 'system', $3, $4, NOW())`,
            [
              convId,
              ctx.agentId,
              insight,
              JSON.stringify({
                type: 'delegation_event',
                fromAgent: ctx.fromAgent,
                toAgent: ctx.toAgent,
                status: ctx.status,
                durationMs: ctx.durationMs,
                toolsUsed: ctx.toolsUsed,
                cached: ctx.cached,
              }),
            ],
          )

          if (ctx.status === 'completed') {
            log.debug(
              `📨 Delegation tracked: ${ctx.fromAgent} → ${ctx.toAgent} (${String(ctx.durationMs)}ms)`,
            )
          } else {
            log.warn(`📨 Delegation ${ctx.status}: ${ctx.fromAgent} → ${ctx.toAgent}`)
          }
        },
      })

      log.info('Delegation tracker: active')
    }

    log.info('Memory: postgres (ros_* tables)')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`Failed to initialize memory: ${message}`)
  }
}
