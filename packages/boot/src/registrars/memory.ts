/**
 * Memory Registrar — sets up PostgreSQL-backed memory with search and
 * the background review loop (M4.2).
 *
 * Embedding and compaction are handled by dedicated event-driven workers
 * on the Datahub ONLY. Agent nodes no longer run BackgroundEmbedder or
 * BackgroundCompactor. See:
 *   services/embedding-worker/   — Postgres LISTEN/NOTIFY → Nemotron
 *   services/compaction-worker/  — Postgres LISTEN/NOTIFY → E2B (review + compaction)
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
    const memoryPkg = '@rivetos/memory-postgres'
    const { PostgresMemory, createMemoryTools, ensureEmbedderSchema, ReviewLoop } = (await import(
      memoryPkg
    )) as MemoryPostgresModule

    const memory: PostgresMemoryInstance = new PostgresMemory({ connectionString })
    runtime.registerMemory(memory)

    // Use the adapter's internal pool and engines (no duplicate pool)
    const searchEngine = memory.getSearchEngine()
    const expander = memory.getExpander()
    const pool = memory.getPool()

    // Ensure embed_failures / embed_error columns exist (schema migration)
    await ensureEmbedderSchema(pool)

    // Memory tools (search, browse, stats) — no compactor/embedding config needed on agents
    const memoryTools = createMemoryTools(searchEngine, expander, { pool })

    for (const tool of memoryTools) {
      runtime.registerTool(tool)
    }

    // NOTE: BackgroundEmbedder and BackgroundCompactor are NO LONGER started
    // on agent nodes. They run as dedicated systemd services on the Datahub only:
    //   rivet-embedder.service
    //   rivet-compactor.service
    //
    // The review loop still runs on every agent (it enqueues work via Postgres).

    const reviewEndpoint =
      (pgConfig.review_endpoint as string | undefined) ?? process.env.RIVETOS_REVIEW_URL ?? ''
    const reviewModel = (pgConfig.review_model as string | undefined) ?? 'rivet-v0.1'
    const reviewApiKey =
      (pgConfig.review_api_key as string | undefined) ?? process.env.RIVETOS_REVIEW_API_KEY ?? ''

    if (hooks && reviewEndpoint) {
      const reviewLoop = new ReviewLoop({
        reviewEndpoint,
        reviewModel,
        reviewApiKey: reviewApiKey || undefined,
        pool,
        turnThreshold: 10,
        iterationThreshold: 15,
        verbose: true,
      })

      hooks.register({
        id: 'memory:review-loop',
        event: 'turn:after',
        priority: 95,
        description: 'Background memory review — counts turns and triggers LLM review',
        onError: 'continue',
        handler: (ctx: TurnAfterContext) => {
          if (ctx.aborted) return

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

          return
        },
      })

      log.info(`Review loop: active (threshold: 10 turns, endpoint: ${reviewEndpoint})`)

      // Delegation tracking
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
            log.debug(`📨 Delegation tracked: ${ctx.fromAgent} → ${ctx.toAgent} (${String(ctx.durationMs)}ms)`)
          } else {
            log.warn(`📨 Delegation ${ctx.status}: ${ctx.fromAgent} → ${ctx.toAgent}`)
          }
        },
      })

      log.info('Delegation tracker: active')
    }

    log.info('Memory: postgres (ros_* tables + centralized workers on Datahub)')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`Failed to initialize memory: ${message}`)
  }
}
