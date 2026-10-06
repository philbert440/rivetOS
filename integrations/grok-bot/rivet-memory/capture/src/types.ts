import type { CaptureMessage } from '@rivetos/capture-core'

export const CAPTURE_CHANNEL = 'grokbot'
export const CAPTURE_SOURCE = 'grokbot'
export const DEFAULT_NODE_ID = 'grokbot'
/** Agent-tag prefix when none is set via GROKBOT_AGENT_PREFIX. */
export const DEFAULT_AGENT_PREFIX = 'grokbot'
/** Fallback agent tag for unknown / subagent transcripts: `<prefix>-run`. */
export const SUBAGENT_AGENT = `${DEFAULT_AGENT_PREFIX}-run`
export const SESSION_SUFFIX_V3 = '-v3'
/** Row-based re-clean (--from-rows / PG) — positions do not match source transcripts. */
export const SESSION_SUFFIX_V3_ROWS = '-v3-rows'
/**
 * agents/<id>/store.db transcript_entries.seq — not the on-disk line index.
 * Never mix into -v3.
 */
export const SESSION_SUFFIX_V3_STORE = '-v3-store'
/**
 * voice-calls/*.json turn index — not the on-disk line index.
 * Never mix into -v3. Per-call files append `-<stem>` after this suffix.
 */
export const SESSION_SUFFIX_V3_VOICE = '-v3-voice'
export const STORAGE_LIMIT = 16_000
/**
 * Transcript content / toolResult bound (256 KiB). Image payloads are stubbed
 * first; this cap then keeps shell dumps off the trigram GIN index and the
 * embedding queue. Pointer + full_*_length recover the rest.
 */
export const CONTENT_LIMIT = 262_144
/** After the last real stamp, space inherited rows by this many ms. */
export const INHERIT_STEP_MS = 1_000
/** Stable ingest ordinal = source position * stride + per-position sub-index. */
export const ORDINAL_STRIDE = 1000

export type TimeSource =
  'tag' | 'tool_epoch' | 'stored' | 'inherited' | 'interpolated' | 'lookahead' | 'mtime'

/**
 * Strip `-vN-voice*`, `-vN-store`, `-vN-rows`, `-vN`, or `-v2` so identity
 * helpers share one rule across -v3 / -v4 / later suffixes.
 *
 * `-vN-backfill` and `-vN-live` are NOT cosmetic. Stripping them would let
 * reclean rebuild a plain `-vN` session from those sibling rows. See
 * `isBackfillSession` / `isLiveSession`.
 */
export function stripSessionSuffix(session: string): string {
  const voice = /-v\d+-voice(?:-|$)/.exec(session)
  if (voice) return session.slice(0, voice.index)
  return session.replace(/-v\d+(?:-store|-rows)?$/, '')
}

/** True for `…-vN-backfill` (optionally followed by another suffix). */
export function isBackfillSession(session: string): boolean {
  return /-v\d+-backfill(?:-|$)/.test(session)
}

/** True for `…-vN-live` (hourly ReadTranscript capture). */
export function isLiveSession(session: string): boolean {
  return /-v\d+-live(?:-|$)/.test(session)
}

export function sessionStoreSuffix(sessionSuffix = SESSION_SUFFIX_V3): string {
  return `${sessionSuffix}-store`
}

export function sessionVoiceSuffix(sessionSuffix = SESSION_SUFFIX_V3): string {
  return `${sessionSuffix}-voice`
}

export function sessionRowsSuffix(sessionSuffix = SESSION_SUFFIX_V3): string {
  return `${sessionSuffix}-rows`
}

/** ReadTranscript page backfill. Never folds into plain `-v4`. */
export const SESSION_SUFFIX_V4_BACKFILL = '-v4-backfill'
export const SESSION_SUFFIX_V4 = '-v4'
/** Hourly ReadTranscript live capture. Sibling of `-v4` / `-v4-backfill`. */
export const SESSION_SUFFIX_V4_LIVE = '-v4-live'
/**
 * Default overlap window for ingest-pages. 0 does not read live `-v4` and
 * does not suppress by content hash. A positive `--overlap-hours` or
 * `GROKBOT_BACKFILL_OVERLAP_HOURS` opts into that suppression.
 */
export const DEFAULT_BACKFILL_OVERLAP_HOURS = 0

export function sessionBackfillSuffix(liveSuffix = SESSION_SUFFIX_V4, revision?: string): string {
  const base = `${liveSuffix}-backfill`
  return revision ? `${base}-${revision}` : base
}

export function sessionLiveSuffix(liveSuffix = SESSION_SUFFIX_V4): string {
  return `${liveSuffix}-live`
}

export function isRowShapedSession(session: string): boolean {
  return /-v\d+-rows(?:-|$)/.test(session)
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

export type InputFormat = 'ondisk' | 'page' | 'store' | 'voice'

export interface PageHeader {
  name?: string
  id?: string
  a: number
  b: number
  total: number
  thisConversation: boolean
  /** Raw header target (`agent "Name" (id)`, `this conversation`, or a slug). */
  target?: string
}

export interface ParsedInput {
  format: InputFormat
  header?: PageHeader
  records: unknown[]
  hasOlderFooter: boolean
  /** 0-based file line of each record (blank / header lines skipped). */
  sourceLines?: number[]
  /** Page file this parse came from. Merged into per-record pointer paths. */
  sourcePath?: string
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
  /**
   * Source file mtime in ms. Used when a session has no inline stamps so
   * every row still gets a monotonic createdAt (last row = mtime, earlier
   * rows step back by INHERIT_STEP_MS). Birthtime→mtime interpolate only
   * when mtime − birth covers (rows − 1) × INHERIT_STEP_MS.
   */
  fileMtimeMs?: number
  /** Source file birthtime in ms when it is finite, > 0, and earlier than mtime. */
  fileBirthtimeMs?: number
  /** Absolute source transcript / page path for memory_get_full pointers. */
  sourcePath?: string
  /**
   * Per-record source path when a merged page list spans files. Wins over
   * `sourcePath` for that record. Empty string means "no path".
   */
  sourcePaths?: string[]
  /** 0-based source file line per record. Falls back to position. */
  sourceLines?: number[]
  /** Live session suffix (`-v3`, `-v4`) for reclean targets. */
  sessionSuffix?: string
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
