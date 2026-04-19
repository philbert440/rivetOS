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
  fmtIsoMinute,
  sanitizeForJson,
  formatLeafPrompt,
  formatBranchPrompt,
  formatRootPrompt,
  type ConversationMeta,
  type CompactMessageRow,
  type SummaryRow,
} from './compactor/index.js'

export { synthesizeToolCallContent, type ToolSynthOptions } from './tool-synth.js'

export { computeRelevance, temporalDecay } from './scoring.js'

export { ReviewLoop } from './review-loop.js'
export type { ReviewLoopConfig, TurnCompleteData, ReviewMetrics } from './review-loop.js'
