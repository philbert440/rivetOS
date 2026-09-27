import type { CaptureMessage } from '@rivetos/capture-core'

export const CAPTURE_CHANNEL = 'grokbot'
export const CAPTURE_SOURCE = 'grokbot'
export const DEFAULT_NODE_ID = 'grokbot'
export const SUBAGENT_AGENT = 'rivet-grokbot-run'
export const SESSION_SUFFIX_V3 = '-v3'
/** Row-based re-clean (--from-rows / PG) — positions do not match source transcripts. */
export const SESSION_SUFFIX_V3_ROWS = '-v3-rows'
export const STORAGE_LIMIT = 16_000
/** Stable ingest ordinal = source position * stride + per-position sub-index. */
export const ORDINAL_STRIDE = 1000

/** Strip -v3-rows, -v3, or -v2 so identity and dest-session helpers share one rule. */
export function stripSessionSuffix(session: string): string {
  if (session.endsWith(SESSION_SUFFIX_V3_ROWS)) {
    return session.slice(0, -SESSION_SUFFIX_V3_ROWS.length)
  }
  if (session.endsWith(SESSION_SUFFIX_V3)) return session.slice(0, -SESSION_SUFFIX_V3.length)
  if (session.endsWith('-v2')) return session.slice(0, -3)
  return session
}

export type HiddenKind =
  | 'first_run'
  | 'profile_update'
  | 'routine'
  | 'background_task'
  | 'skipped_prompt'
  | 'reaction'
  | 'event'
  | 'instructions_update'
  | 'agent_message'

export type InputFormat = 'ondisk' | 'page'

export interface PageHeader {
  name?: string
  id?: string
  a: number
  b: number
  total: number
  thisConversation: boolean
}

export interface ParsedInput {
  format: InputFormat
  header?: PageHeader
  records: unknown[]
  hasOlderFooter: boolean
}

export interface BotIdentity {
  id: string
  persona: string
  session: string
  agent: string
}

export interface NormalizeOptions {
  sessionKey: string
  agent: string
  /** Grok Bot roster id (UUID). Stored on every row's metadata. */
  agentId?: string
  persona?: string
  channel?: string
  format?: InputFormat
  /** Source ordinal of the first record (page header `A`, else 0). */
  startPosition?: number
  /**
   * Explicit source positions, one per record. Used when merging overlapping
   * or gapped ReadTranscript pages so `position = start + i` is not assumed.
   */
  positions?: number[]
  /** Last known message time from a prior page, as ISO-8601 UTC. */
  lastKnownTime?: string
  /**
   * Re-clean path: when a later user turn has no `<timestamp>`, keep the
   * stored row's created_at instead of inheriting or leaving the field unset.
   */
  useStoredCreatedAt?: boolean
}

export interface NormalizeStats {
  in: number
  out: number
  dropped: number
  systemEvents: number
  user: number
  assistant: number
  tool: number
  system: number
  truncated: number
  timeKnown: boolean
  lastKnownTime?: string
}

export interface NormalizeResult {
  messages: CaptureMessage[]
  stats: NormalizeStats
  lastKnownTime?: string
  timeKnown: boolean
  /** Positions where overlapping pages disagreed (set by normalizePages). */
  conflicts?: number[]
}

export interface StoredRow {
  role: string
  content: string
  tool_name?: string | null
  tool_args?: unknown
  tool_result?: string | null
  created_at?: string | Date | null
  metadata?: Record<string, unknown> | null
  ordinal?: number | null
  conversation_id?: string | null
}

export interface IngestRow {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  createdAt?: string
  toolCalls?: Array<{ id?: string; name: string; input?: unknown }>
  /** Stored on ros_messages.tool_result (not folded into content). */
  toolResult?: string
  metadata?: Record<string, unknown>
  ordinal?: number
  event_id?: string
}

export interface NoiseCounts {
  timestamp: number
  user_query: number
  SAND_HIDDEN_PROMPT: number
  SAND_TRUSTED_AUTOMATION_PROMPT: number
  system_reminder: number
  automation_status: number
  address_tag: number
  sent_from_machine: number
  profile_blob: number
  agent_profile_update: number
  memory_context: number
  user_info: number
  agent_skills: number
  dynamic_tool_catalog: number
  mcp_server_catalog: number
  instructions_update: number
  attached_files: number
  image: number
}

export const EMPTY_NOISE: NoiseCounts = {
  timestamp: 0,
  user_query: 0,
  SAND_HIDDEN_PROMPT: 0,
  SAND_TRUSTED_AUTOMATION_PROMPT: 0,
  system_reminder: 0,
  automation_status: 0,
  address_tag: 0,
  sent_from_machine: 0,
  profile_blob: 0,
  agent_profile_update: 0,
  memory_context: 0,
  user_info: 0,
  agent_skills: 0,
  dynamic_tool_catalog: 0,
  mcp_server_catalog: 0,
  instructions_update: 0,
  attached_files: 0,
  image: 0,
}
