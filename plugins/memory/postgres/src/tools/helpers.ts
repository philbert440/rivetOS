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
  metadata: Record<string, unknown> | null
}

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
  }
  if (aliases[s]) return aliases[s]
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
    throw new Error(
      `Invalid window="" — expected one of: ${formatWindowChoices()}`,
    )
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

  if (normalized === 'today' || normalized === 'this_morning') {
    // "this morning" shares today's lower bound; agents narrow the result set.
    return { since: todayLocal.toISOString(), before: null }
  }
  if (normalized === 'yesterday') {
    const yest = new Date(todayLocal.getTime())
    yest.setDate(yest.getDate() - 1)
    return {
      since: yest.toISOString(),
      before: todayLocal.toISOString(),
    }
  }
  if (normalized === 'this_week') {
    // ISO week — Monday start. JS getDay(): 0=Sun..6=Sat.
    const monday = new Date(todayLocal.getTime())
    const day = monday.getDay()
    const daysFromMonday = day === 0 ? 6 : day - 1
    monday.setDate(monday.getDate() - daysFromMonday)
    return { since: monday.toISOString(), before: null }
  }
  if (normalized === 'last_24h') {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    return { since: since.toISOString(), before: null }
  }
  // Exhaustiveness guard — isWindowChoice already filtered.
  throw new Error(`Unknown window="${window}". Expected one of: ${formatWindowChoices()}`)
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

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function fmtDate(d: Date | null): string {
  return d?.toISOString().split('T')[0] ?? '?'
}

export function timeSince(d: Date): string {
  const ms = Date.now() - d.getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${String(Math.floor(ms / 60_000))}m ago`
  if (ms < MS_PER_DAY) return `${String(Math.floor(ms / 3_600_000))}h ago`
  return `${String(Math.floor(ms / MS_PER_DAY))}d ago`
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
