/**
 * Provider interface — talks to an LLM.
 */

import type { Message, ToolCall } from './message.js'
import type { ToolDefinition } from './tool.js'

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
