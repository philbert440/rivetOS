/**
 * @rivetos/memory-postgres
 *
 * RivetOS Memory System — hybrid-scored search, background compaction,
 * summary DAG, and access-frequency tracking.
 *
 * Tables: ros_messages, ros_conversations, ros_summaries, ros_summary_sources
 *
 * Architecture:
 *   adapter.ts   — implements Memory interface from @rivetos/types
 *   search.ts    — hybrid FTS + semantic + temporal + importance scoring
 *   expand.ts    — summary DAG traversal (parent_id on ros_summaries)
 *   tools.ts     — agent tools: memory_search (unified), memory_browse, memory_stats
 *   embedder.ts  — background job: embed messages + summaries via Nemotron
 *   compactor.ts — background job: summarize old messages via Rivet Local
 *   scoring.ts   — pure domain: relevance scoring functions (no I/O)
 *   migrate.ts   — one-shot migration from LCM tables (standalone script)
 */

export { PostgresMemory } from './adapter.js'
export type { PostgresMemoryConfig } from './adapter.js'

export { SearchEngine } from './search.js'
export type { SearchOptions, SearchHit } from './search.js'

export { Expander } from './expand.js'
export type { SummaryNode, ExpandResult } from './expand.js'

export { createMemoryTools } from './tools/index.js'
export type { MemoryToolsConfig } from './tools/index.js'

export { BackgroundEmbedder, ensureEmbedderSchema } from './embedder.js'
export type { EmbedderConfig, EmbedderMetrics } from './embedder.js'

export { BackgroundCompactor } from './compactor/index.js'
export type { CompactorConfig, CompactorMetrics } from './compactor/index.js'

export { computeRelevance, temporalDecay } from './scoring.js'

export { ReviewLoop } from './review-loop.js'
export type { ReviewLoopConfig, TurnCompleteData, ReviewMetrics } from './review-loop.js'
