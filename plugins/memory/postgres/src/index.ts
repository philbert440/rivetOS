/**
 * @rivetos/memory-postgres
 *
 * RivetOS Memory System — hybrid-scored search, summary DAG,
 * and access-frequency tracking.
 *
 * Tables: ros_messages, ros_conversations, ros_summaries, ros_summary_sources
 *
 * Background work (compaction, embedding, tool-call synthesis) runs on
 * graphile-worker. Triggers on ros_messages/ros_summaries call graphile_worker.add_job
 * directly; the compaction-worker and embedding-worker services consume those jobs.
 *
 * Architecture:
 *   adapter.ts      — implements Memory interface from @rivetos/types
 *   search.ts       — hybrid FTS + semantic + temporal + importance scoring
 *   expand.ts       — summary DAG traversal (parent_id on ros_summaries)
 *   tools/          — agent tools: memory_search (unified), memory_browse, memory_stats
 *   embedder.ts     — schema migration helpers (ensureEmbedderSchema)
 *   compactor/      — types, prompts, constants (shared with Datahub worker)
 *   scoring.ts      — pure domain: relevance scoring functions (no I/O)
 *
 * Embedding and compaction jobs run as graphile-worker services:
 *   services/embedding-worker/   — graphile-worker → Nemotron GPU
 *   services/compaction-worker/  — graphile-worker → CPU LLM (compactor)
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

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

import type { PluginManifest, DelegationAfterContext } from '@rivetos/types'
import { PostgresMemory } from './adapter.js'
import { createMemoryTools } from './tools/index.js'
import { ensureEmbedderSchema } from './embedder.js'

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

    // Opt-in: on main this hook was (accidentally) gated behind the removed
    // review-loop's endpoint check, so deployed configs never ran it. Keep
    // that deployed behavior unless explicitly enabled.
    if (cfg.delegation_tracking === true) {
      registerDelegationTracker()
    }

    function registerDelegationTracker(): void {
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
            ctx.logger.warn(
              `📨 Delegation ${delCtx.status}: ${delCtx.fromAgent} → ${delCtx.toAgent}`,
            )
          }
        },
      })

      ctx.logger.info('Delegation tracker: active')
    }

    ctx.logger.info(
      `Memory: postgres (ros_* tables + centralized workers on Datahub)` +
        (embedEndpoint
          ? ` | hybrid search via ${embedEndpoint}`
          : ' | FTS-only (no embed endpoint)'),
    )
  },
}

export { WikiIndex } from './wiki/index-reader.js'
export type {
  WikiTopicRow,
  WikiTopicHit,
  WikiIndexConfig,
  ExtractionMark,
} from './wiki/index-reader.js'
