/**
 * Compactor — barrel re-exports for v5 pipeline.
 *
 * Exports v5 prompts, formatters, helpers, and types so the standalone
 * compaction-worker (services/compaction-worker/index.js) and CLI can reuse them.
 */

export {
  LEAF_SYSTEM_PROMPT,
  BRANCH_SYSTEM_PROMPT,
  ROOT_SYSTEM_PROMPT,
  fmtIsoMinute,
  sanitizeForJson,
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
  type ConversationMeta,
  type CompactMessageRow,
  type SummaryRow,
  type CompactorConfig,
  type CompactorMetrics,
  TOOL_SYNTH_QUEUE_TABLE,
} from './types.js'

export { BackgroundCompactor } from './compactor.js'

// Re-export formatters for worker reuse (exact match to library implementation)
export { formatLeafPrompt, formatBranchPrompt, formatRootPrompt } from './compactor.js'
