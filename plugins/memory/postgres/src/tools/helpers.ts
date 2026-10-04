/**
 * Shared helpers for memory tools — types, config, formatting, LLM queries.
 */

import pg from 'pg'
import type { SearchHit, SearchSnippet } from '../search.js'
import type { SummaryNode } from '../expand.js'

// ---------------------------------------------------------------------------
// Row interfaces for pg query results
// ---------------------------------------------------------------------------

export interface MessageRow {
  id: string
  role: string
  agent: string
  content: string
  created_at: Date
  conversation_id: string
  tool_name: string | null
  /** Present when the row is a tool call; often holds the real payload while
   *  `content` is only a short placeholder like `[tool] search_tool`. */
  tool_result: string | null
  metadata: Record<string, unknown> | null
}

/** Default display caps for browse rows. Capture still stores up to 16K; these
 *  only limit what we put in the agent-facing browse response. */
export const BROWSE_CONTENT_LIMIT = 500
export const BROWSE_TOOL_RESULT_LIMIT = 800

/** One-line marker appended to recall output when a row was truncated at
 *  capture time — carries the original length and the memory_get_full handle
 *  (issue #197). Empty string for complete rows. */
export function truncationHint(
  meta: Record<string, unknown> | null | undefined,
  id: string,
): string {
  if (!meta || meta.truncated !== true) return ''
  const full = meta.full_content_length ?? meta.full_tool_result_length
  const len = typeof full === 'number' ? `${String(full)} chars` : 'unknown length'
  return `\n⚠ truncated at capture (full: ${len}) → memory_get_full id=${id}`
}

/**
 * Format the body of one `memory_browse` row: content preview + optional
 * tool_result preview + recovery handles.
 *
 * Daily-use footgun (2026-08): browse selected only `content`, so tool rows
 * rendered as `[tool] search_tool` with no payload. Agents then re-ran tools
 * or trusted incomplete chronology. When the stored row is complete (not
 * capture-truncated), display cuts still point at `memory_get_full` which
 * returns the full DB payload.
 */
export function formatBrowseMessageBody(
  row: {
    id: string
    content: string
    tool_name: string | null
    tool_result: string | null
    metadata: Record<string, unknown> | null
  },
  opts?: { contentLimit?: number; toolResultLimit?: number },
): string {
  const contentLimit = opts?.contentLimit ?? BROWSE_CONTENT_LIMIT
  const toolResultLimit = opts?.toolResultLimit ?? BROWSE_TOOL_RESULT_LIMIT
  const captureTrunc = row.metadata?.truncated === true
  const parts: string[] = []

  const content = row.content
  if (content.length > contentLimit) {
    parts.push(content.slice(0, contentLimit) + '…')
    if (!captureTrunc) {
      parts.push(
        `…[display-truncated content ${String(content.length)} chars → memory_get_full id=${row.id}]`,
      )
    }
  } else {
    parts.push(content)
  }

  const toolResult = row.tool_result
  if (typeof toolResult === 'string' && toolResult.length > 0) {
    const label = row.tool_name ? `tool_result (${row.tool_name})` : 'tool_result'
    if (toolResult.length > toolResultLimit) {
      parts.push(
        `[${label} ${String(toolResult.length)} chars]\n${toolResult.slice(0, toolResultLimit)}…`,
      )
      if (!captureTrunc) {
        parts.push(`…[display-truncated tool_result → memory_get_full id=${row.id}]`)
      }
    } else {
      parts.push(`[${label}]\n${toolResult}`)
    }
  }

  const captureHint = truncationHint(row.metadata, row.id)
  if (captureHint) parts.push(captureHint.replace(/^\n/, ''))

  return parts.join('\n')
}

/** Display caps for memory_search message snippets (slightly tighter than browse). */
export const SEARCH_CONTENT_LIMIT = 400
export const SEARCH_TOOL_RESULT_LIMIT = 500
/**
 * Display cap for a matched chunk. Real chunks are `EMBED_CHARS_PER_CHUNK`
 * (6000); slicing them to {@link SEARCH_CONTENT_LIMIT} (400) drops ~93% of the
 * window — usually including the sentence that matched.
 */
export const SEARCH_SNIPPET_LIMIT = 1500

/**
 * Format one memory_search message hit for agent-facing output.
 *
 * Same footgun as browse: tool rows often have content=`[tool] name` while the
 * real payload lives in tool_result. After search begins matching tool_result
 * (migration 0008 + quality floor), display must surface it or agents still
 * only see the placeholder in the hit list.
 */
export function formatSearchMessageBody(
  hit: {
    id: string
    content: string
    toolName?: string | null
    toolResult?: string | null
    truncated?: boolean
    fullLength?: number
    snippet?: SearchSnippet
  },
  opts?: { contentLimit?: number; toolResultLimit?: number },
): string {
  // A chunk hit: the matched excerpt is the answer, the message head usually is
  // not. Render the chunk instead of content + tool_result — the composed embed
  // text the chunk came from already spans both.
  if (hit.snippet) {
    return formatSnippetBody(hit.id, hit.snippet, opts?.contentLimit ?? SEARCH_SNIPPET_LIMIT)
  }
  const meta =
    hit.truncated === true
      ? {
          truncated: true as const,
          full_content_length: hit.fullLength,
          full_tool_result_length: hit.fullLength,
        }
      : null
  return formatBrowseMessageBody(
    {
      id: hit.id,
      content: hit.content,
      tool_name: hit.toolName ?? null,
      tool_result: hit.toolResult ?? null,
      metadata: meta,
    },
    {
      contentLimit: opts?.contentLimit ?? SEARCH_CONTENT_LIMIT,
      toolResultLimit: opts?.toolResultLimit ?? SEARCH_TOOL_RESULT_LIMIT,
    },
  )
}

/**
 * Render one chunk hit: a `…[chunk 3/7]…` marker so the agent knows it is
 * looking at an excerpt of a long message, then the chunk text.
 *
 * The text is `ros_message_chunks.content` verbatim. `charStart`/`charEnd` are
 * offsets into the *composed embed text* (content + tool_result), so they are
 * shown as provenance only and never used to re-slice `ros_messages.content`.
 */
export function formatSnippetBody(
  id: string,
  snippet: SearchSnippet,
  contentLimit: number = SEARCH_SNIPPET_LIMIT,
): string {
  const position =
    snippet.chunkCount && snippet.chunkCount > 0
      ? `${String(snippet.chunkIdx + 1)}/${String(snippet.chunkCount)}`
      : String(snippet.chunkIdx + 1)
  const marker =
    `…[chunk ${position} · chars ${String(snippet.charStart)}-${String(snippet.charEnd)}` +
    ` → memory_get_full id=${id}]…`
  const text =
    snippet.text.length > contentLimit ? snippet.text.slice(0, contentLimit) + '…' : snippet.text
  return `${marker}\n${text}`
}

export interface CountRow {
  total: string
  oldest: Date | null
  newest: Date | null
}

export interface AgentCountRow {
  agent: string
  count: string
}

export interface RoleCountRow {
  role: string
  count: string
}

export interface ConversationTotalRow {
  total: string
  active: string
}

export interface SummaryKindRow {
  kind: string
  count: string
  max_depth: number
}

export interface EmbedQueueRow {
  msg_queue: string
  sum_queue: string
  unembeddable: string
}

export interface EmbedCoverageRow {
  total: string
  embedded: string
}

export interface UnsummarizedRow {
  count: string
}

export interface CompactionRow {
  conversation_id: string
  agent: string
  unsummarized: string
}

export interface UnsummarizedBucketRow {
  eligible_msgs: string
  eligible_convs: string
  active_tail_msgs: string
  active_tail_convs: string
  below_floor_msgs: string
  below_floor_convs: string
}

export interface EligibleConvRow {
  conversation_id: string
  agent: string
  unsummarized: string
  trigger: string
}

export interface StuckJobRow {
  task: string
  count: string
  oldest_run_at: Date | null
  sample_error: string | null
}

/**
 * Per-task graphile-worker queue state for the memory_stats queue block.
 * dead = attempts >= max_attempts (won't retry until rescheduled; most are
 * keyless corpses on graphile 0.17, not a job_key blockage);
 * pending = not-dead, stealable, run_at due; oldest_pending_age_min is NULL
 * when nothing is pending under that filter.
 */
export interface QueueHealthRow {
  recent_dead?: string
  running?: string
  scheduled?: string
  task: string
  pending: string
  dead: string
  oldest_pending_age_min: number | null
  last_error: string | null
}

/**
 * Scheduled heartbeat conversations use `session_key = 'heartbeat:<agent>'`.
 * They are operational noise (HEARTBEAT_OK + tool chatter), not user work.
 *
 * getContextForTurn and extract-wiki already skip them. Compaction enqueue
 * and memory_stats eligibility must too — otherwise heartbeats look like a
 * compaction backlog and burn the compactor LLM (then fail as "dead jobs"
 * when the LLM is down).
 */
export const HEARTBEAT_SESSION_PREFIX = 'heartbeat:'

export function isHeartbeatSessionKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(HEARTBEAT_SESSION_PREFIX)
}

/** True when a conversation session_key was minted by Codex capture / backfill. */
export function isCodexSessionKey(key: string | null | undefined): boolean {
  return (
    typeof key === 'string' &&
    /^codex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
  )
}

/** SQL predicate: conversation alias `c` is not a heartbeat session. */
export function sqlNotHeartbeatConversation(alias = 'c'): string {
  return `(${alias}.session_key IS NULL OR ${alias}.session_key NOT LIKE '${HEARTBEAT_SESSION_PREFIX}%')`
}

export interface TreeDepthRow {
  max_depth: number | null
  root_count: string
  child_count: string
}

export interface FreshnessRow {
  newest_message: Date | null
  newest_summary: Date | null
}

export interface LlmResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MemoryToolsConfig {
  /** Rivet Local endpoint for LLM-synthesized answers (e.g., http://192.168.1.50:8000/v1) */
  compactorEndpoint?: string
  /** Model name for synthesis (default: rivet-v0.1) */
  compactorModel?: string
  /** API key for authenticated endpoints (e.g., xAI, Google) */
  compactorApiKey?: string
  /** pg.Pool — required for memory_browse and memory_stats */
  pool?: pg.Pool
}

// ---------------------------------------------------------------------------
// Expanded summary type (used by search tool)
// ---------------------------------------------------------------------------

export interface ExpandedSummary {
  hit: SearchHit
  children: SummaryNode[]
  sourceMessages: Array<{ role: string; content: string; createdAt: Date }>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export {
  MS_PER_DAY,
  WINDOW_CHOICES,
  isWindowChoice,
  normalizeWindowInput,
  formatWindowChoices,
  resolveWindow,
  applyWindowArgs,
} from '@rivetos/memory-core'
export type { WindowChoice } from '@rivetos/memory-core'
import { MS_PER_DAY } from '@rivetos/memory-core'

/** Agent-facing banner when the vector arm was dropped. Always the first line. */
export function formatVectorArmUnavailable(
  reason: string,
  mode?: 'hybrid' | 'fts' | 'trigram' | 'regex' | 'vector',
  hitCount = 0,
): string {
  if (mode === 'trigram' || mode === 'regex') return ''
  if (mode === 'vector') {
    const suffix = hitCount > 0 ? 'showing fts fallback results' : 'no results'
    return `⚠ vector arm unavailable (${reason}) — ${suffix}`
  }
  return `⚠ vector arm unavailable (${reason}) — results are fts/trigram only`
}

/** Agent-facing banner when the chunk arm was skipped; parents were still searched. */
export function formatChunkArmUnavailable(reason: string): string {
  return `⚠ chunk arm unavailable (${reason}) — searching parent embeddings only`
}

/**
 * Hermes-parity empty-result guidance for `memory_search`.
 *
 * Bare `"No results found."` is a daily-use footgun: agents treat it as
 * "memory has nothing" and skip the retries that actually recover hits
 * (trigram for literal tokens, multi-angle re-query, or `memory_browse`
 * when the caller was really trying to scan a time window).
 */
export function formatEmptySearchResult(opts: {
  query: string
  since?: string
  before?: string
  /** Original `window=` value when that was what the caller passed. */
  window?: string
}): string {
  const { query, since, before, window } = opts
  if (since || before) {
    const parts: string[] = []
    if (typeof window === 'string' && window) {
      parts.push(`window="${window}"`)
    } else {
      if (since) parts.push(`since="${since}"`)
      if (before) parts.push(`before="${before}"`)
    }
    const windowStr = parts.join(', ')
    return (
      `No results found for query "${query}" with ${windowStr}.\n\n` +
      `For chronological browsing of a date window without a topic filter, ` +
      `call \`memory_browse(${windowStr})\` instead — that returns every message ` +
      `in the window, no FTS match required.`
    )
  }
  return (
    `No results found for query "${query}".\n\n` +
    `If you expected a hit: retry with \`mode="trigram"\` for literal ` +
    `tokens (IPs, hostnames, error strings), or vary the angle ` +
    `(service / host / subnet / role) and try two more queries before ` +
    `trusting the empty result. For time-bounded questions ("today", ` +
    `"yesterday", "last week"), prefer \`memory_browse\` with window= — ` +
    `search ANDs the query with any date filter and returns empty when FTS misses.`
  )
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function fmtDate(d: Date | null): string {
  return d?.toISOString().split('T')[0] ?? '?'
}

/**
 * Local calendar date `YYYY-MM-DD` in the process timezone.
 *
 * Prefer this over `fmtDate` (UTC date-only) for agent-facing period ranges —
 * a hit at 2026-07-29 01:00 UTC is still "yesterday" evening in US Eastern,
 * and UTC `split('T')[0]` mislabels the day.
 */
export function fmtLocalDate(d: Date | null): string {
  if (!d) return '?'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Format a timestamp in the process local timezone with a short zone label
 * (e.g. `2026-05-23 13:34:38 EDT`).
 *
 * `memory_browse` used to render `toISOString().slice(...)` — UTC wall-clock
 * with the `Z` stripped — so agents routinely mis-read 00:10 UTC as "early
 * local morning" when the real local time was the previous evening. Hermes
 * rivet-memory already labels local TZ; this is the same fix for the
 * in-process / MCP postgres tools path.
 */
export function fmtLocalTs(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const y = d.getFullYear()
  const mo = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const h = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const s = pad(d.getSeconds())
  const tz =
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  return tz ? `${y}-${mo}-${day} ${h}:${mi}:${s} ${tz}` : `${y}-${mo}-${day} ${h}:${mi}:${s}`
}

export function timeSince(d: Date): string {
  const ms = Date.now() - d.getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${String(Math.floor(ms / 60_000))}m ago`
  if (ms < MS_PER_DAY) return `${String(Math.floor(ms / 3_600_000))}h ago`
  return `${String(Math.floor(ms / MS_PER_DAY))}d ago`
}

/**
 * Search-hit when-label: relative age + absolute local timestamp.
 *
 * `memory_search` used to emit only floor-day ages (`0d ago`, `3d ago`) with
 * no absolute time — same-day hits looked timeless, and period ranges used
 * unlabeled UTC dates. Pairing relative + local-TZ absolute matches browse
 * (#413) so agents can place hits on a real timeline.
 *
 * Example: `3h ago · 2026-07-29 11:01:30 EDT`
 */
export function fmtHitWhen(d: Date): string {
  return `${timeSince(d)} · ${fmtLocalTs(d)}`
}

// ---------------------------------------------------------------------------
// LLM call for synthesized answers
// ---------------------------------------------------------------------------

export async function queryLlm(
  endpoint: string,
  model: string,
  query: string,
  context: string,
  maxTokens: number,
  apiKey?: string,
): Promise<string> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a memory assistant. Answer the question using ONLY the provided context. ' +
              'Be concise and specific. If the context does not contain enough information, say so.',
          },
          {
            role: 'user',
            content: `## Context from conversation history:\n\n${context}\n\n## Question:\n${query}`,
          },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      return `LLM synthesis failed: ${String(response.status)} ${response.statusText}`
    }

    const data = (await response.json()) as LlmResponse
    return data.choices?.[0]?.message?.content ?? 'No answer generated.'
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    return `Failed to synthesize answer: ${msg}`
  }
}
