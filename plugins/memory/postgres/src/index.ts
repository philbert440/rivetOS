/**
 * @rivetos/memory-postgres
 *
 * RivetOS Memory System — hybrid-scored search, summary DAG,
 * access-frequency tracking, and background review loop.
 *
 * Tables: ros_messages, ros_conversations, ros_summaries, ros_summary_sources,
 *         ros_embedding_queue, ros_compaction_queue
 *
 * Architecture:
 *   adapter.ts      — implements Memory interface from @rivetos/types
 *   search.ts       — hybrid FTS + semantic + temporal + importance scoring
 *   expand.ts       — summary DAG traversal (parent_id on ros_summaries)
 *   tools/          — agent tools: memory_search (unified), memory_browse, memory_stats
 *   embedder.ts     — schema migration helpers (ensureEmbedderSchema)
 *   compactor/      — types, prompts, constants (shared with Datahub worker)
 *   review-loop.ts  — turn-based background review (runs on agent CTs)
 *   scoring.ts      — pure domain: relevance scoring functions (no I/O)
 *
 * Embedding and compaction jobs run on the Datahub as dedicated services:
 *   services/embedding-worker/   — event-driven via Postgres LISTEN/NOTIFY → Nemotron GPU
 *   services/compaction-worker/  — event-driven via Postgres LISTEN/NOTIFY → E2B CPU
 */

export { PostgresMemory } from './adapter.js'
export type { PostgresMemoryConfig } from './adapter.js'

export { SearchEngine } from './search.js'
export type { SearchOptions, SearchHit, SearchEngineConfig } from './search.js'

export { Expander } from './expand.js'
export type { SummaryNode, ExpandResult } from './expand.js'

export { createMemoryTools } from './tools/index.js'
export type { MemoryToolsConfig } from './tools/index.js'

// Schema migration helpers — still needed by agent CTs to ensure columns exist
export { ensureEmbedderSchema } from './embedder.js'

// Compactor types/prompts/formatters — shared with Datahub compaction-worker and CLI
export {
  BackgroundCompactor,
  type CompactorConfig,
  type CompactorMetrics,
  LEAF_SYSTEM_PROMPT,
  BRANCH_SYSTEM_PROMPT,
  ROOT_SYSTEM_PROMPT,
  LEAF_MAX_TOKENS,
  BRANCH_MAX_TOKENS,
  ROOT_MAX_TOKENS,
  PIPELINE_VERSION,
  LLM_TIMEOUT_MS,
  LLM_TEMPERATURE,
  LLM_RETRIES,
  LLM_RETRY_BACKOFF_MS,
  MIN_BATCH_SIZE,
  MAX_CONVERSATIONS_PER_CYCLE,
  TOOL_SYNTH_QUEUE_TABLE,
  fmtIsoMinute,
  sanitizeForJson,
  formatLeafPrompt,
  formatBranchPrompt,
  formatRootPrompt,
  type ConversationMeta,
  type CompactMessageRow,
  type SummaryRow,
} from './compactor/index.js'

export {
  synthesizeToolCallContent,
  TOOL_SYNTH_TEMPERATURE,
  type ToolSynthOptions,
} from './tool-synth.js'

export { computeRelevance, temporalDecay } from './scoring.js'

export { ReviewLoop } from './review-loop.js'
export type { ReviewLoopConfig, TurnCompleteData, ReviewMetrics } from './review-loop.js'

// Migration helpers — migrate-v3.ts is a standalone CLI (run via npx tsx), not a library export

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

import type { PluginManifest, TurnAfterContext, DelegationAfterContext } from '@rivetos/types'
import { PostgresMemory } from './adapter.js'
import { createMemoryTools } from './tools/index.js'
import { ensureEmbedderSchema } from './embedder.js'
import { ReviewLoop } from './review-loop.js'

export const manifest: PluginManifest = {
  type: 'memory',
  name: 'postgres',
  async register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    const connectionString =
      (cfg.connection_string as string | undefined) ?? ctx.env.RIVETOS_PG_URL ?? ''
    if (!connectionString) return

    const embedEndpoint =
      (cfg.embed_endpoint as string | undefined) ?? ctx.env.RIVETOS_EMBED_URL ?? ''
    const embedModel =
      (cfg.embed_model as string | undefined) ?? ctx.env.RIVETOS_EMBED_MODEL ?? 'nemotron'

    const memory = new PostgresMemory({
      connectionString,
      embedEndpoint: embedEndpoint || undefined,
      embedModel,
    })
    ctx.registerMemory(memory)

    const searchEngine = memory.getSearchEngine()
    const expander = memory.getExpander()
    const pool = memory.getPool()

    await ensureEmbedderSchema(pool)

    for (const tool of createMemoryTools(searchEngine, expander, { pool })) {
      ctx.registerTool(tool)
    }

    const reviewEndpoint =
      (cfg.review_endpoint as string | undefined) ?? ctx.env.RIVETOS_REVIEW_URL ?? ''
    const reviewModel = (cfg.review_model as string | undefined) ?? 'rivet-v0.1'
    const reviewApiKey =
      (cfg.review_api_key as string | undefined) ?? ctx.env.RIVETOS_REVIEW_API_KEY ?? ''

    if (!reviewEndpoint) {
      ctx.logger.info(
        `Memory: postgres (ros_* tables + centralized workers on Datahub)` +
          (embedEndpoint
            ? ` | hybrid search via ${embedEndpoint}`
            : ' | FTS-only (no embed endpoint)'),
      )
      return
    }

    const reviewLoop = new ReviewLoop({
      reviewEndpoint,
      reviewModel,
      reviewApiKey: reviewApiKey || undefined,
      pool,
      turnThreshold: 10,
      iterationThreshold: 15,
      verbose: true,
    })

    ctx.registerHook({
      id: 'memory:review-loop',
      event: 'turn:after',
      priority: 95,
      description: 'Background memory review — counts turns and triggers LLM review',
      onError: 'continue',
      handler: (turnCtx: TurnAfterContext) => {
        if (turnCtx.aborted) return
        const hadErrorRecovery = turnCtx.toolsUsed.some(
          (t, i) => i > 0 && turnCtx.toolsUsed[i - 1] === t,
        )
        reviewLoop.onTurnComplete({
          agentId: turnCtx.agentId ?? 'unknown',
          sessionId: turnCtx.sessionId ?? 'unknown',
          response: turnCtx.response,
          toolsUsed: turnCtx.toolsUsed,
          iterations: turnCtx.iterations,
          hadErrorRecovery,
          hadUserCorrection: Boolean(turnCtx.metadata.hadSteer),
          usage: turnCtx.usage,
        })
      },
    })

    ctx.registerHook({
      id: 'memory:delegation-tracker',
      event: 'delegation:after',
      priority: 90,
      description: 'Persist delegation events for learning and auditing',
      onError: 'continue',
      handler: async (delCtx: DelegationAfterContext) => {
        const parts = [
          `Delegation: ${delCtx.fromAgent} → ${delCtx.toAgent}`,
          `Task: ${delCtx.task.slice(0, 200)}`,
          `Status: ${delCtx.status}`,
          `Duration: ${String(delCtx.durationMs)}ms`,
        ]
        if (delCtx.toolsUsed?.length) parts.push(`Tools: ${delCtx.toolsUsed.join(', ')}`)
        if (delCtx.cached) parts.push('(cached result)')
        const insight = parts.join(' | ')

        const conv = await pool.query(
          `SELECT id FROM ros_conversations WHERE agent = $1 AND active = true ORDER BY updated_at DESC LIMIT 1`,
          [delCtx.agentId],
        )
        if (conv.rows.length === 0) return
        const convId = (conv.rows[0] as Record<string, unknown>).id as string

        await pool.query(
          `INSERT INTO ros_messages (conversation_id, agent, channel, role, content, metadata, created_at)
           VALUES ($1, $2, 'delegation', 'system', $3, $4, NOW())`,
          [
            convId,
            delCtx.agentId,
            insight,
            JSON.stringify({
              type: 'delegation_event',
              fromAgent: delCtx.fromAgent,
              toAgent: delCtx.toAgent,
              status: delCtx.status,
              durationMs: delCtx.durationMs,
              toolsUsed: delCtx.toolsUsed,
              cached: delCtx.cached,
            }),
          ],
        )

        if (delCtx.status === 'completed') {
          ctx.logger.debug(
            `📨 Delegation tracked: ${delCtx.fromAgent} → ${delCtx.toAgent} ` +
              `(${String(delCtx.durationMs)}ms)`,
          )
        } else {
          ctx.logger.warn(`📨 Delegation ${delCtx.status}: ${delCtx.fromAgent} → ${delCtx.toAgent}`)
        }
      },
    })

    ctx.logger.info(`Review loop: active (threshold: 10 turns, endpoint: ${reviewEndpoint})`)
    ctx.logger.info('Delegation tracker: active')
    ctx.logger.info(
      `Memory: postgres (ros_* tables + centralized workers on Datahub)` +
        (embedEndpoint
          ? ` | hybrid search via ${embedEndpoint}`
          : ' | FTS-only (no embed endpoint)'),
    )
  },
}
