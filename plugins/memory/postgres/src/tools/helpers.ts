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
