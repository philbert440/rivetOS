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
  LLM_TIMEOUT_MS,
  type ConversationMeta,
  type CompactMessageRow,
  type SummaryRow,
  type CompactorConfig,
  type CompactorMetrics,
} from './types.js'

export { BackgroundCompactor } from './compactor.js'

// Re-export formatters for worker reuse (exact match to library implementation)
export { formatLeafPrompt, formatBranchPrompt, formatRootPrompt } from './compactor.js'
