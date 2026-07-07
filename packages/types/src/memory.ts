/**
 * Memory interface — persistent storage and retrieval.
 *
 * Core defines this. Plugins implement it.
 * Core never knows if it's postgres, sqlite, or /dev/null.
 */

import type { Message } from './message.js'

export interface MemoryEntry {
  id?: string
  sessionId: string
  agent: string
  channel: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  metadata?: Record<string, unknown>
  createdAt?: Date
}

export interface MemorySearchResult {
  id: string
  content: string
  role: string
  agent: string
  relevanceScore: number
  createdAt: Date
}

/** One captured conversation, for the harness-session drawer (seamless modes). */
export interface MemorySessionSummary {
  /** the RIVETOS_SESSION_KEY the transcript is keyed on */
  sessionId: string
  lastActive: Date
  messageCount: number
}

export interface Memory {
  /** Append a message/response/tool call to the transcript */
  append(entry: MemoryEntry): Promise<string>

  /** Search the transcript store */
  search(
    query: string,
    options?: {
      agent?: string
      limit?: number
      scope?: 'messages' | 'summaries' | 'both'
    },
  ): Promise<MemorySearchResult[]>

  /** Build context for the current turn (recent + relevant) */
  getContextForTurn(query: string, agent: string, options?: { maxTokens?: number }): Promise<string>

  /** Restore session history from persistent storage */
  getSessionHistory(sessionId: string, options?: { limit?: number }): Promise<Message[]>

  /** List distinct captured conversations, most-recent first (seamless-modes
   *  harness-session discovery). Optional: a store that can't enumerate
   *  sessions simply omits it and discovery is empty. */
  listSessions?(options?: { limit?: number }): Promise<MemorySessionSummary[]>

  /** Persist session settings (thinking level, visibility toggles) */
  saveSessionSettings?(sessionId: string, settings: Record<string, unknown>): Promise<void>

  /** Restore session settings */
  loadSessionSettings?(sessionId: string): Promise<Record<string, unknown> | null>
}
