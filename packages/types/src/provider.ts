/**
 * Provider interface — talks to an LLM.
 */

import type { Message, ToolCall } from './message.js'
import type { Tool, ToolDefinition } from './tool.js'

// ---------------------------------------------------------------------------
// Thinking / Reasoning Control
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ChatOptions {
  tools?: ToolDefinition[]
  signal?: AbortSignal
  thinking?: ThinkingLevel
  /** Override the provider's default model for this request (used by fallback chains) */
  modelOverride?: string
  /** Start a fresh conversation — don't reuse stateful conversation context (e.g. xAI previous_response_id).
   *  Used by delegation and subagent engines to prevent conversation state bleed. */
  freshConversation?: boolean
  /** Stable conversation identifier for prompt caching (xAI prompt_cache_key, etc.).
   *  Providers that support prompt caching use this for consistent cache hits. */
  conversationId?: string
  /**
   * Executable RivetOS tools for this turn — same set the agent loop dispatches
   * locally, including their `execute` callbacks. Optional and intentionally
   * separate from `tools` (which carries only definitions for the wire).
   *
   * Used by providers that host an out-of-process tool runner (claude-cli MCP
   * bridge): the provider stands up an embedded MCP server, registers these
   * tools dynamically, and lets the external client (e.g. claude-cli) call
   * them — the `execute` closure runs in the agent process so runtime context
   * (DelegationEngine, channel handle, conversation buffer) is automatically
   * available, no separate adapter required.
   *
   * Most providers ignore this field; the LLM-only path (Anthropic/xAI/...)
   * relies on `tools` (definitions) and the loop's own dispatcher.
   */
  executableTools?: Tool[]
  /**
   * Logical agent identity for this turn. Used by providers that need to
   * scope per-spawn auth artifacts or session metadata back to a specific
   * agent (e.g. claude-cli bridge labels its embedded MCP socket / config).
   * Mirrors `AgentLoopConfig.agentId`.
   */
  agentId?: string
}

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

/** Token usage from a provider response */
export interface LLMUsage {
  promptTokens: number
  completionTokens: number
  /** Tokens used for reasoning/thinking (xAI, OpenAI o-series) */
  reasoningTokens?: number
  /** Tokens served from prompt cache */
  cachedTokens?: number
  /** Anthropic prompt cache write tokens (additive, optional) */
  cacheCreationTokens?: number
  /** Anthropic prompt cache read tokens (additive, optional) */
  cacheReadTokens?: number
}

export interface LLMResponse {
  type: 'text' | 'tool_calls'
  content?: string
  toolCalls?: ToolCall[]
  usage?: LLMUsage
}

export interface LLMChunk {
  type:
    | 'text'
    | 'reasoning'
    | 'tool_call_start'
    | 'tool_call_delta'
    | 'tool_call_done'
    | 'status'
    | 'done'
    | 'error'
  delta?: string
  toolCall?: Partial<ToolCall> & { index?: number }
  usage?: LLMUsage
  /** Citations (URLs) from server-side search tools — populated on 'done' chunks */
  citations?: string[]
  error?: string
}

// ---------------------------------------------------------------------------
// Provider session capability
// ---------------------------------------------------------------------------

/**
 * Result returned by `prepareTurn` — what the provider actually wants on the
 * wire for this call.
 */
export interface PreparedTurn {
  /** Messages the provider wants to receive (may be a slice of the full history). */
  messages: Message[]
  /** True when the provider is continuing from prior server-side state
   *  (e.g. xAI previous_response_id). False = full replay. */
  isContinuation: boolean
}

/**
 * Capability descriptor for providers that own their own session/continuation
 * state on the server side. Absent capability = stateless replay (default).
 */
export interface ProviderSessionCapability {
  /** Provider manages its own server-side session continuity. */
  native: true
  /**
   * Called by the agent loop before each `chatStream` invocation. Lets the
   * provider decide whether it can continue from prior state (and trim the
   * messages array) or needs a full replay. Return `null` to fall back to
   * full-history replay.
   */
  prepareTurn?(messages: Message[], options?: ChatOptions): PreparedTurn | null
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface Provider {
  id: string
  name: string
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk>
  chat?(messages: Message[], options?: ChatOptions): Promise<LLMResponse>
  isAvailable(): Promise<boolean>
  /** Get the current default model ID */
  getModel(): string
  /** Change the default model at runtime */
  setModel(model: string): void
  /** Context window size in tokens (0 = unknown/unlimited) */
  getContextWindow(): number
  /** Max output tokens (0 = unknown/unlimited) */
  getMaxOutputTokens(): number
  /**
   * Optional. When set, the agent loop will call `prepareTurn` (if provided)
   * to let the provider trim messages to what it actually needs on the wire.
   * Providers without this field receive full history every turn (current
   * stateless behavior).
   */
  sessionCapability?: ProviderSessionCapability
  /**
   * Optional. Reset provider-side session state (called by /new and any
   * context-clear flow). Sync or async. No-op if absent.
   */
  resetSession?(): void | Promise<void>
}

// ---------------------------------------------------------------------------
// Provider Error Codes
// ---------------------------------------------------------------------------

export type ProviderErrorCode =
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_REQUEST_FAILED'

// ---------------------------------------------------------------------------
// ProviderError — thrown by providers for retryable failures
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS_CODES = new Set([429, 503, 529])

/**
 * Error thrown by providers for HTTP failures. Retryable errors trigger fallback chains.
 *
 * Backward compatible — original (message, statusCode, providerId, retryable) constructor
 * still works. New code can use the richer options form.
 */
export class ProviderError extends Error {
  readonly statusCode: number
  readonly providerId: string
  readonly retryable: boolean
  readonly severity: 'fatal' | 'error' | 'warning' | 'transient'
  readonly timestamp: number
  readonly context: Record<string, unknown>

  constructor(
    message: string,
    statusCode: number,
    providerId: string,
    retryable: boolean = RETRYABLE_STATUS_CODES.has(statusCode),
    options?: {
      severity?: 'fatal' | 'error' | 'warning' | 'transient'
      context?: Record<string, unknown>
      cause?: Error
    },
  ) {
    super(message)
    this.name = 'ProviderError'
    this.statusCode = statusCode
    this.providerId = providerId
    this.retryable = retryable
    this.timestamp = Date.now()
    this.context = options?.context ?? {}

    // Derive severity from status code if not provided
    if (options?.severity) {
      this.severity = options.severity
    } else if (statusCode === 401 || statusCode === 403) {
      this.severity = 'fatal'
    } else if (statusCode === 429) {
      this.severity = 'transient'
    } else if (statusCode >= 500) {
      this.severity = 'transient'
    } else {
      this.severity = 'error'
    }

    if (options?.cause) {
      this.cause = options.cause
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: `PROVIDER_HTTP_${this.statusCode}`,
      message: this.message,
      statusCode: this.statusCode,
      providerId: this.providerId,
      severity: this.severity,
      retryable: this.retryable,
      timestamp: this.timestamp,
      context: this.context,
      ...(this.cause instanceof Error ? { cause: this.cause.message } : {}),
      stack: this.stack,
    }
  }
}
