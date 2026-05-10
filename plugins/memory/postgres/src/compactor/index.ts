/**
 * Compactor — barrel re-exports for v5 pipeline.
 *
 * Exports v5 prompts, formatters, helpers, and types so the compaction-worker
 * service (services/compaction-worker/) and CLI can reuse them.
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
} from './types.js'

// Formatters for worker reuse (exact match to v5 spec)
export { formatLeafPrompt, formatBranchPrompt, formatRootPrompt } from './compactor.js'
