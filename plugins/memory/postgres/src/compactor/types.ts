/**
 * Compactor types, config, constants, and prompts.
 */

// ---------------------------------------------------------------------------
// Row interfaces
// ---------------------------------------------------------------------------

export interface CandidateRow {
  conversation_id: string
  unsummarized: string
}

export interface CompactMessageRow {
  id: string
  role: string
  content: string
  agent: string
  created_at: Date
}

export interface SummaryRow {
  id: string
  content: string
  kind: string
  earliest_at: Date | null
  latest_at: Date | null
  message_count: number
  created_at: Date
}

export interface IdRow {
  id: string
}

export interface LlmResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string | null
    }
  }>
}

export interface BranchCandidateRow {
  conversation_id: string
  leaf_count: string
}

export interface RootCandidateRow {
  conversation_id: string
  branch_count: string
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CompactorConfig {
  /** PostgreSQL connection string */
  connectionString: string
  /** LLM endpoint for summarization (default: http://192.168.1.50:8000/v1) */
  compactorEndpoint?: string
  /** Model name (default: rivet-v0.1) */
  compactorModel?: string
  /** API key for authenticated endpoints (e.g., xAI, Google) */
  compactorApiKey?: string
  /** Milliseconds between cycles (default: 1800000 = 30 min) */
  intervalMs?: number
  /** Minimum unsummarized messages to trigger leaf compaction (default: 50) */
  minUnsummarized?: number
  /** Messages per leaf compaction batch (default: 25) */
  batchSize?: number
  /** Minimum unparented leaves to trigger branch compaction (default: 5) */
  minLeafsForBranch?: number
  /** Max leaves per branch (default: 8) */
  branchBatchSize?: number
  /** Minimum unparented branches to trigger root compaction (default: 3) */
  minBranchesForRoot?: number
  /** Max branches per root (default: 5) */
  rootBatchSize?: number
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface CompactorMetrics {
  cyclesCompleted: number
  leafsCreated: number
  branchesCreated: number
  rootsCreated: number
  llmCalls: number
  llmFailures: number
  lastCycleAt: Date | null
  lastCycleDurationMs: number
}

// ---------------------------------------------------------------------------
// Level-specific prompts
// ---------------------------------------------------------------------------

export const LEAF_SYSTEM_PROMPT =
  'Summarize these conversation messages concisely. Preserve: key decisions, ' +
  'technical details, configurations, action items, state changes, problems solved, ' +
  'and any code snippets or commands that were used. ' +
  'Format as bullet points. Be specific — include names, values, and outcomes.'

export const BRANCH_SYSTEM_PROMPT =
  'You are summarizing a series of conversation summaries into a higher-level overview. ' +
  'These summaries represent a period of conversation in a single thread. ' +
  'Identify the main themes, key decisions, and outcomes across all the summaries. ' +
  'Preserve: project names, architectural decisions, configuration changes, ' +
  'problems solved, and action items. Drop low-value details. ' +
  'Format as bullet points organized by theme.'

export const ROOT_SYSTEM_PROMPT =
  'You are creating a top-level summary of an entire conversation thread from branch summaries. ' +
  'Each branch covers a significant period of discussion. ' +
  'Distill the most important decisions, outcomes, and state changes. ' +
  'This summary should give someone full context on what happened in this conversation. ' +
  'Preserve: final decisions (not deliberation), completed actions, ' +
  'current state of systems/projects, and any unresolved issues. ' +
  'Format as bullet points. Be concise but complete.'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum messages in a batch to be worth summarizing */
export const MIN_BATCH_SIZE = 5

/** Maximum conversations to compact per cycle (per level) */
export const MAX_CONVERSATIONS_PER_CYCLE = 5

/** LLM request timeout */
export const LLM_TIMEOUT_MS = 60_000

/** Max content per message in the LLM prompt (avoid blowing context) */
export const MAX_MSG_CONTENT_FOR_PROMPT = 1000

/** Max content per summary in the branch/root prompt */
export const MAX_SUMMARY_CONTENT_FOR_PROMPT = 2000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function fmtDate(d: Date | null): string {
  return d?.toISOString().split('T')[0] ?? '?'
}

/**
 * Strip lone surrogates and non-whitespace ASCII control characters
 * so the string is safe for strict JSON parsers (e.g., llama-server).
 *
 * - Removes high surrogates (U+D800..U+DBFF) not followed by a low surrogate
 * - Removes lone low surrogates (U+DC00..U+DFFF) not preceded by a high surrogate
 * - Removes ASCII control chars 0x00-0x1F except tab (0x09), newline (0x0A), CR (0x0D)
 */
export function sanitizeForJson(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\x00-\x08\x0B\x0C\x0E-\x1F]/g,
    '',
  )
}
