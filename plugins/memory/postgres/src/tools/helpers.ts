/**
 * Shared helpers for memory tools — types, config, formatting, LLM queries.
 */

import pg from 'pg'
import type { SearchHit } from '../search.js'
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
  },
  opts?: { contentLimit?: number; toolResultLimit?: number },
): string {
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

export const MS_PER_DAY = 86_400_000

// ---------------------------------------------------------------------------
// Time-window shortcuts (parity with Hermes rivet-memory v0.3)
// ---------------------------------------------------------------------------

/**
 * Named `window=` values for memory_browse / memory_search.
 * Resolve to UTC ISO bounds anchored at the process local timezone midnight,
 * so agents avoid the "UTC midnight = previous evening local" trap.
 */
export const WINDOW_CHOICES = [
  'today',
  'yesterday',
  'this_morning',
  'this_week',
  'last_24h',
  // Rolling multi-day ranges (not calendar weeks). Critical on Mon/Tue when
  // this_week is almost empty — "what did we do last week / recently" needs
  // these instead of inventing since= bare dates (UTC midnight trap).
  'last_7d',
  'last_14d',
] as const

export type WindowChoice = (typeof WINDOW_CHOICES)[number]

export function isWindowChoice(value: string): value is WindowChoice {
  return (WINDOW_CHOICES as readonly string[]).includes(value)
}

/**
 * Normalize free-form window strings agents commonly invent:
 * spaces/hyphens → underscores, lower-case, strip punctuation noise.
 * Also maps a few natural-language synonyms onto WINDOW_CHOICES.
 *
 * Returns null when the input is empty after cleanup.
 */
export function normalizeWindowInput(raw: string): string | null {
  let s = raw.trim().toLowerCase()
  if (!s) return null

  // Common multi-word / hyphen forms → snake_case tokens first.
  s = s
    .replace(/\blast\s*24\s*(?:h(?:ours?)?)?\b/g, 'last_24h')
    .replace(/\blast\s+day\b/g, 'last_24h')
    .replace(/\blast\s*(?:7|seven)\s*d(?:ays?)?\b/g, 'last_7d')
    .replace(/\blast\s*(?:14|fourteen)\s*d(?:ays?)?\b/g, 'last_14d')
    .replace(/\bpast\s*(?:7|seven)\s*d(?:ays?)?\b/g, 'last_7d')
    .replace(/\bpast\s*(?:14|fourteen)\s*d(?:ays?)?\b/g, 'last_14d')
    .replace(/\blast\s+week\b/g, 'last_7d')
    .replace(/\bpast\s+week\b/g, 'last_7d')
    .replace(/\blast\s+two\s+weeks?\b/g, 'last_14d')
    .replace(/\bpast\s+two\s+weeks?\b/g, 'last_14d')
    .replace(/\bthis\s+morning\b/g, 'this_morning')
    .replace(/\bthis\s+week\b/g, 'this_week')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')

  if (!s) return null

  // Synonyms that still differ after cleanup.
  const aliases: Record<string, WindowChoice> = {
    last24h: 'last_24h',
    last_24_hours: 'last_24h',
    last_24hours: 'last_24h',
    last_day: 'last_24h',
    past_24h: 'last_24h',
    morning: 'this_morning',
    week: 'this_week',
    // Rolling 7d — not "previous calendar Mon–Sun". Agents invent these
    // constantly for "what did we do last week / recently".
    last_week: 'last_7d',
    past_week: 'last_7d',
    last7d: 'last_7d',
    last_7_days: 'last_7d',
    last_7days: 'last_7d',
    past_7d: 'last_7d',
    past_7_days: 'last_7d',
    last14d: 'last_14d',
    last_14_days: 'last_14d',
    last_14days: 'last_14d',
    past_14d: 'last_14d',
    past_14_days: 'last_14d',
    last_two_weeks: 'last_14d',
    past_two_weeks: 'last_14d',
  }
  // Prefer explicit key list over `aliases[s]` truthiness — without
  // noUncheckedIndexedAccess, indexed access is typed as always-defined.
  for (const [key, value] of Object.entries(aliases)) {
    if (key === s) return value
  }
  return s
}

/** Human-readable list of valid window= values for error messages. */
export function formatWindowChoices(): string {
  return WINDOW_CHOICES.map((c) => `"${c}"`).join(', ')
}

/**
 * Convert a window name to `(since, before)` UTC ISO timestamps.
 *
 * Anchoring uses the process local timezone (or the local TZ of `now` when
 * injected for tests). Matches Hermes `resolve_window` semantics:
 * - today / this_morning → local midnight → now
 * - yesterday → local yesterday midnight → local today midnight
 * - this_week → local Monday midnight → now (ISO week, Mon=start)
 * - last_24h → rolling 24h from now
 * - last_7d / last_14d → rolling N×24h from now (not calendar weeks)
 *
 * Unknown names after {@link normalizeWindowInput} throw — silent no-op was
 * a daily-use footgun (agents thought they time-bounded, got full history).
 */
export function resolveWindow(
  window: string,
  now: Date = new Date(),
): { since: string | null; before: string | null } {
  const normalized = normalizeWindowInput(window)
  if (!normalized) {
    throw new Error(`Invalid window="" — expected one of: ${formatWindowChoices()}`)
  }
  if (!isWindowChoice(normalized)) {
    throw new Error(
      `Unknown window="${window}"` +
        (normalized !== window.trim().toLowerCase() ? ` (normalized to "${normalized}")` : '') +
        `. Expected one of: ${formatWindowChoices()}`,
    )
  }

  const startOfLocalDay = (d: Date): Date => {
    const x = new Date(d.getTime())
    x.setHours(0, 0, 0, 0)
    return x
  }

  const todayLocal = startOfLocalDay(now)

  switch (normalized) {
    case 'today':
    case 'this_morning':
      // "this morning" shares today's lower bound; agents narrow the result set.
      return { since: todayLocal.toISOString(), before: null }
    case 'yesterday': {
      const yest = new Date(todayLocal.getTime())
      yest.setDate(yest.getDate() - 1)
      return {
        since: yest.toISOString(),
        before: todayLocal.toISOString(),
      }
    }
    case 'this_week': {
      // ISO week — Monday start. JS getDay(): 0=Sun..6=Sat.
      // On Mon/Tue this is almost empty — prefer last_7d for "recent work".
      const monday = new Date(todayLocal.getTime())
      const day = monday.getDay()
      const daysFromMonday = day === 0 ? 6 : day - 1
      monday.setDate(monday.getDate() - daysFromMonday)
      return { since: monday.toISOString(), before: null }
    }
    case 'last_24h': {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      return { since: since.toISOString(), before: null }
    }
    case 'last_7d': {
      const since = new Date(now.getTime() - 7 * MS_PER_DAY)
      return { since: since.toISOString(), before: null }
    }
    case 'last_14d': {
      const since = new Date(now.getTime() - 14 * MS_PER_DAY)
      return { since: since.toISOString(), before: null }
    }
    default: {
      // Exhaustiveness — isWindowChoice already filtered.
      const _exhaustive: never = normalized
      throw new Error(
        `Unknown window="${String(_exhaustive)}". Expected one of: ${formatWindowChoices()}`,
      )
    }
  }
}

/**
 * Apply `window=` when neither explicit `since` nor `before` was supplied.
 * Explicit bounds always win (Hermes parity).
 *
 * Throws on unknown `window` values (see {@link resolveWindow}) so tools
 * surface a clear error instead of silently dropping the time filter.
 */
export function applyWindowArgs(args: { window?: unknown; since?: unknown; before?: unknown }): {
  since: string | undefined
  before: string | undefined
} {
  const explicitSince = typeof args.since === 'string' && args.since ? args.since : undefined
  const explicitBefore = typeof args.before === 'string' && args.before ? args.before : undefined
  if (explicitSince || explicitBefore) {
    return { since: explicitSince, before: explicitBefore }
  }
  if (typeof args.window === 'string' && args.window) {
    const { since, before } = resolveWindow(args.window)
    return {
      since: since ?? undefined,
      before: before ?? undefined,
    }
  }
  return { since: undefined, before: undefined }
}

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
