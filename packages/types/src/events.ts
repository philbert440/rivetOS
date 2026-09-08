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
  /** Number of compactions performed in this session */
  compactionCount: number
  /** Whether a compaction nudge is pending for the next turn */
  compactionPending?: 'soft-40' | 'soft-70' | 'hard' | undefined
  /** Which nudge tiers have fired this compaction cycle (reset after compaction). Uses array for clean JSON serialization. */
  nudgesFired: number[]
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
  /** When true, the delegate will NOT receive a delegate_task tool.
   *  Set automatically for mesh-received delegations so agents do the
   *  work instead of re-delegating. */
  noDelegation?: boolean
  /** Per-call model override. When set, the delegate runs with this model
   *  instead of the agent's configured default. Useful for picking between
   *  model tiers (fast vs. reasoning) without creating separate agents.
   *  Works across the mesh — remote nodes honor this on inbound delegations. */
  model?: string
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
