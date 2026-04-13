/**
 * Sub-agent orchestration types.
 *
 * Async-first design: spawn fires immediately, caller polls with status().
 * No synchronous blocking. Sessions persist until explicitly killed or
 * garbage-collected.
 */

import type { Message } from './message.js'

// ---------------------------------------------------------------------------
// Sub-agent Session
// ---------------------------------------------------------------------------

export interface SubagentSession {
  /** Unique session identifier */
  id: string
  /** Agent that spawned this sub-agent */
  parentAgent: string
  /** Agent running as the sub-agent */
  childAgent: string
  /** Provider backing the child agent */
  provider: string
  /** Current session status */
  status: 'running' | 'completed' | 'failed'
  /** Conversation history within this sub-agent session */
  history: Message[]
  /** When the session was created (epoch ms) */
  createdAt: number
  /** Number of tool iterations so far (updated live) */
  iterations?: number
  /** Names of tools used so far (updated live) */
  toolsUsed?: string[]
  /** Token usage from the most recent turn */
  usage?: { promptTokens: number; completionTokens: number }
  /** Wall-clock duration in milliseconds (set on completion) */
  durationMs?: number
  /** Final response text (set on completion) or partial text (during execution) */
  lastResponse?: string
  /** Error message if status is 'failed' */
  error?: string
}

// ---------------------------------------------------------------------------
// Spawn Request
// ---------------------------------------------------------------------------

export interface SubagentSpawnRequest {
  /** Agent ID to spawn (e.g., 'grok', 'opus', 'local') */
  agent: string
  /** Task description or initial message */
  task: string
  /** Optional timeout in milliseconds (no default — runs until done or killed) */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Status Response — rich progress info for polling
// ---------------------------------------------------------------------------

export interface SubagentStatusResponse {
  /** Session ID */
  id: string
  /** Child agent ID */
  agent: string
  /** Current status */
  status: 'running' | 'completed' | 'failed'
  /** Elapsed wall-clock time in ms */
  elapsedMs: number
  /** Tool iterations so far */
  iterations: number
  /** Tools used so far (deduplicated) */
  toolsUsed: string[]
  /** Final or partial response text */
  lastResponse: string
  /** Token usage */
  usage?: { promptTokens: number; completionTokens: number }
  /** Error message if failed */
  error?: string
  /** Message count in history */
  messageCount: number
}

// ---------------------------------------------------------------------------
// Sub-agent Manager Interface
// ---------------------------------------------------------------------------

export interface SubagentManager {
  /**
   * Spawn a new sub-agent. Returns immediately with the session.
   * The agent runs asynchronously in the background.
   */
  spawn(request: SubagentSpawnRequest): SubagentSession

  /**
   * Get detailed status of a sub-agent session.
   * Returns rich progress info including partial results.
   */
  status(sessionId: string): SubagentStatusResponse

  /**
   * Send a follow-up message to a sub-agent session.
   * Only works when the session is completed (starts a new turn).
   * Returns immediately — poll with status() for the result.
   */
  send(sessionId: string, message: string): void

  /** List all sub-agent sessions (all statuses). */
  list(): SubagentSession[]

  /** Kill (abort) a running sub-agent session. */
  kill(sessionId: string): void
}
