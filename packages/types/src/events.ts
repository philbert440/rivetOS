/**
 * Stream events and runtime control types.
 */

import type { Message } from './message.js'
import type { ThinkingLevel } from './provider.js'
import type { InboundMessage } from './channel.js'

// ---------------------------------------------------------------------------
// Stream Events — runtime → channel for live updates
// ---------------------------------------------------------------------------

export interface StreamEvent {
  type:
    | 'text'
    | 'reasoning'
    | 'tool_start'
    | 'tool_result'
    | 'status'
    | 'interrupt'
    | 'done'
    | 'error'
  content: string
  metadata?: Record<string, unknown>
}

export type StreamHandler = (event: StreamEvent) => void

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

export interface SessionState {
  id: string
  thinking: ThinkingLevel
  reasoningVisible: boolean
  toolsVisible: boolean
  history: Message[]
  /** System prompt — built once on session init, reused every turn */
  systemPrompt?: string
  /** Count of user messages since last compaction (or session start) */
  userMessageCount: number
  /** Number of compactions performed in this session */
  compactionCount: number
  /** Whether a compaction nudge is pending for the next turn */
  compactionPending?: 'soft-40' | 'soft-70' | 'hard' | undefined
  /** Which nudge tiers have fired this compaction cycle (reset after compaction) */
  nudgesFired: Set<40 | 70 | 90>
}

// ---------------------------------------------------------------------------
// Message Queue
// ---------------------------------------------------------------------------

export interface QueuedMessage {
  message: InboundMessage
  receivedAt: number
}

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

export interface DelegationRequest {
  fromAgent: string
  toAgent: string
  task: string
  context?: string[]
  timeoutMs?: number
}

export interface DelegationResult {
  status: 'completed' | 'failed' | 'timeout'
  response: string
  iterations?: number
  usage?: TokenUsage
  /** Names of tools the delegate called during execution */
  toolsUsed?: string[]
  /** Wall-clock duration of the delegation in milliseconds */
  durationMs?: number
}

// ---------------------------------------------------------------------------
// Token Tracking
// ---------------------------------------------------------------------------

export interface TokenUsage {
  agent: string
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  timestamp: number
}

// ---------------------------------------------------------------------------
// Silent Replies
// ---------------------------------------------------------------------------

/** Response strings that the runtime should swallow (not send to channel) */
export type SilentResponse = 'NO_REPLY' | 'HEARTBEAT_OK'

// ---------------------------------------------------------------------------
// Runtime Commands — defined in commands.ts (single source of truth)
// ---------------------------------------------------------------------------
