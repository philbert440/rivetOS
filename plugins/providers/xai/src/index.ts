/**
 * @rivetos/provider-xai
 *
 * xAI Grok provider — uses the AI SDK (`@ai-sdk/xai`) under the hood for the
 * Responses API streaming path. The class itself owns native-session state
 * (previous_response_id, last model, prompt cache key, prepareTurn decision)
 * and exposes them to the AI SDK chat-stream via a context bridge.
 *
 * Features (preserved from the legacy bespoke implementation):
 * - Native Responses API endpoint (/v1/responses)
 * - Stateful conversations via previous_response_id (server stores history)
 * - Encrypted reasoning passthrough for stateless continuity
 * - SSE streaming with full Responses API event handling
 * - Image understanding with multimodal user content blocks
 * - Server-side tools: web_search, x_search, code_interpreter
 * - Real-time status events for server-side tool activity
 * - Citations support
 * - Full usage tracking (input, output, reasoning, cached tokens)
 * - reasoning.effort support (multi-agent model only)
 * - store: true by default; images force store: false
 * - 1-hour timeout for reasoning models
 * - Prompt caching via stable prompt_cache_key
 */

import type {
  Provider,
  Message,
  ChatOptions,
  LLMChunk,
  PluginManifest,
  PreparedTurn,
  ProviderSessionCapability,
  ThinkingLevel,
} from '@rivetos/types'
import { hasImages, MODEL_DEFAULTS } from '@rivetos/types'
import type { ProviderAiSdkBridge } from '@rivetos/aisdk'
import type { JSONObject } from '@ai-sdk/provider'
import type { LanguageModel, ToolSet } from 'ai'
import { createXai, xaiTools } from '@ai-sdk/xai'
import { randomUUID } from 'node:crypto'

import { chatStreamAiSdk, type XAIAiSdkContext } from './chat-stream-aisdk.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Web search filter configuration for xAI's built-in web_search tool */
export interface WebSearchConfig {
  /** Domains to restrict search to (max 5). Mutually exclusive with excludedDomains. */
  allowedDomains?: string[]
  /** Domains to exclude from search (max 5). Mutually exclusive with allowedDomains. */
  excludedDomains?: string[]
  /** Enable image understanding in web search results */
  enableImageUnderstanding?: boolean
}

/** X/Twitter search filter configuration for xAI's built-in x_search tool */
export interface XSearchConfig {
  /** X handles to restrict search to (max 10). Mutually exclusive with excludedXHandles. */
  allowedXHandles?: string[]
  /** X handles to exclude from search (max 10). Mutually exclusive with allowedXHandles. */
  excludedXHandles?: string[]
  /** Only return posts from this date onward (ISO8601 "YYYY-MM-DD") */
  fromDate?: string
  /** Only return posts up to this date (ISO8601 "YYYY-MM-DD") */
  toDate?: string
  /** Enable image understanding in X search results */
  enableImageUnderstanding?: boolean
  /** Enable video understanding in X search results */
  enableVideoUnderstanding?: boolean
}

export interface XAIProviderConfig {
  apiKey: string
  /** Model ID. Default: 'grok-4.20-reasoning' */
  model?: string
  /** API base URL. Default: 'https://api.x.ai/v1' */
  baseUrl?: string
  /** Temperature for sampling. Not supported by reasoning models. */
  temperature?: number
  /** Whether to store conversations server-side. Default: true */
  store?: boolean
  /** Request timeout in ms. Default: 3600000 (1 hour for reasoning) */
  timeoutMs?: number
  /** Context window size in tokens (0 = unknown) */
  contextWindow?: number
  /** Max output tokens (0 = unknown) */
  maxOutputTokens?: number

  // --- Server-side tools ---

  /** Enable xAI's built-in web search. `true` = default config, object = with filters. */
  webSearch?: boolean | WebSearchConfig
  /** Enable xAI's built-in X/Twitter search. `true` = default config, object = with filters. */
  xSearch?: boolean | XSearchConfig
  /** Enable xAI's built-in code interpreter. */
  codeExecution?: boolean

  // --- Request options ---

  /** Default reasoning effort level. Overridden by ChatOptions.thinking per-request.
   *  'xhigh' is only valid for grok-4.20-multi-agent — degrades to 'high' on other models. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  /** Limit server-side agentic turns per request. Resets on client-side tool calls. */
  maxTurns?: number
  /** Control when model uses tools: 'auto' | 'required' | 'none' | specific function */
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
  /** Whether model can request multiple tool calls in one response. Default: true (API default) */
  parallelToolCalls?: boolean
  /** Server-side context truncation strategy */
  truncation?: 'auto' | 'disabled'
  /** Developer instructions (separate from system prompt, persisted server-side) */
  instructions?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapXaiReasoningEffort(
  model: string,
  thinking: ThinkingLevel | undefined,
  configured: 'low' | 'medium' | 'high' | 'xhigh' | undefined,
): 'low' | 'medium' | 'high' | undefined {
  const level = thinking ?? configured
  if (!level || level === 'off') return undefined
  if (!model.includes('multi-agent')) return undefined
  if (level === 'xhigh') return 'high' // AI SDK schema rejects xhigh
  return level
}

// ---------------------------------------------------------------------------
// XAIProvider
// ---------------------------------------------------------------------------

export class XAIProvider implements Provider {
  id = 'xai'
  name = 'xAI Grok'
  private apiKey: string
  private model: string
  private baseUrl: string
  private store: boolean
  private timeoutMs: number
  private contextWindowSize: number
  private outputTokenLimit: number

  // Server-side tools config
  private webSearch: boolean | WebSearchConfig
  private xSearch: boolean | XSearchConfig
  private codeExecution: boolean

  // Reasoning
  private reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | undefined

  /** Track response IDs for stateful conversation continuity */
  private lastResponseId: string | null = null
  /** Track which model the stored conversation belongs to */
  private lastResponseModel: string | null = null
  /** Stable prompt cache key for xAI prompt caching (persists per conversation) */
  private promptCacheKey: string | null = null

  /**
   * Set by `prepareTurn` immediately before `chatStream`. Tells the AI SDK
   * chat-stream the loop has already trimmed the message array. Cleared as
   * soon as the chat-stream consumes it.
   */
  private pendingPrepared: { isContinuation: boolean } | null = null

  /** Native session capability — exposed to the agent loop. */
  readonly sessionCapability: ProviderSessionCapability = {
    native: true,
    prepareTurn: (messages: Message[], options?: ChatOptions) =>
      this.prepareTurn(messages, options),
  }

  constructor(config: XAIProviderConfig) {
    this.apiKey = config.apiKey
    this.model = config.model ?? MODEL_DEFAULTS.xai
    this.baseUrl = config.baseUrl ?? 'https://api.x.ai/v1'
    this.store = config.store ?? true
    this.timeoutMs = config.timeoutMs ?? 3_600_000
    this.contextWindowSize = config.contextWindow ?? 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0

    this.webSearch = config.webSearch ?? false
    this.xSearch = config.xSearch ?? false
    this.codeExecution = config.codeExecution ?? false

    this.reasoningEffort = config.reasoningEffort
  }

  getModel(): string {
    return this.model
  }

  setModel(model: string): void {
    this.model = model
  }

  getContextWindow(): number {
    return this.contextWindowSize
  }

  getMaxOutputTokens(): number {
    return this.outputTokenLimit
  }

  /** Reset conversation state (called by /new and context-clear flows). */
  resetSession(): void {
    this.lastResponseId = null
    this.lastResponseModel = null
    this.promptCacheKey = null
    this.pendingPrepared = null
  }

  /** @deprecated Use {@link resetSession}. Kept for backward compatibility. */
  resetConversation(): void {
    this.resetSession()
  }

  // -----------------------------------------------------------------------
  // prepareTurn — native-session hook called by the agent loop
  // -----------------------------------------------------------------------

  prepareTurn(messages: Message[], options?: ChatOptions): PreparedTurn {
    const model = options?.modelOverride ?? this.model
    const containsImages = messages.some((m) => hasImages(m.content))
    const storeThisRequest = containsImages ? false : this.store

    const canContinue = !!(
      storeThisRequest &&
      this.lastResponseId &&
      !options?.freshConversation &&
      this.lastResponseModel === model
    )

    if (!canContinue) {
      this.pendingPrepared = { isContinuation: false }
      return { messages, isContinuation: false }
    }

    // Server has up to and including the last completed text response. Find
    // what's genuinely new since then.
    const lastAssistantWithTools = messages.findLastIndex(
      (m) => m.role === 'assistant' && !!m.toolCalls && m.toolCalls.length > 0,
    )

    let trimmed: Message[]
    if (lastAssistantWithTools >= 0) {
      trimmed = messages.slice(lastAssistantWithTools + 1)
    } else {
      const lastUserIdx = messages.findLastIndex((m) => m.role === 'user')
      trimmed = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages
    }

    this.pendingPrepared = { isContinuation: true }
    return { messages: trimmed, isContinuation: true }
  }

  /**
   * Stable prompt_cache_key for xAI prompt caching.
   * Priority: explicit conversationId > existing cached key > new random UUID.
   */
  private getPromptCacheKey(conversationId?: string): string {
    if (conversationId) {
      this.promptCacheKey = conversationId
      return conversationId
    }
    if (this.promptCacheKey) return this.promptCacheKey
    this.promptCacheKey = randomUUID()
    return this.promptCacheKey
  }

  // -----------------------------------------------------------------------
  // chatStream — delegates to AI SDK implementation
  // -----------------------------------------------------------------------

  private buildAiSdkContext(): XAIAiSdkContext {
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      defaultModel: this.model,
      store: this.store,
      timeoutMs: this.timeoutMs,
      outputTokenLimit: this.outputTokenLimit,
      webSearch: this.webSearch,
      xSearch: this.xSearch,
      codeExecution: this.codeExecution,
      reasoningEffort: this.reasoningEffort,
      getLastResponseId: () => this.lastResponseId,
      getLastResponseModel: () => this.lastResponseModel,
      setLastResponseId: (id) => {
        this.lastResponseId = id
      },
      setLastResponseModel: (model) => {
        this.lastResponseModel = model
      },
      getPromptCacheKey: (conversationId) => this.getPromptCacheKey(conversationId),
      consumePendingPrepared: () => {
        const p = this.pendingPrepared
        this.pendingPrepared = null
        return p
      },
    }
  }

  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    return chatStreamAiSdk(this.buildAiSdkContext(), messages, options)
  }

  // -----------------------------------------------------------------------
  // aiSdkBridge — AI SDK loop adapter (consumed by the AI SDK loop)
  // -----------------------------------------------------------------------

  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride, conversationId }): LanguageModel => {
        const cacheKey = this.getPromptCacheKey(conversationId)
        const provider = createXai({
          apiKey: this.apiKey,
          baseURL: this.baseUrl,
          headers: { 'x-grok-conv-id': cacheKey },
        })
        return provider.responses(modelOverride ?? this.model)
      },

      buildProviderOptions: (messages, options): JSONObject | undefined => {
        const model = options?.modelOverride ?? this.model
        const containsImages = messages.some((m) => hasImages(m.content))
        const storeThisRequest = containsImages ? false : this.store

        // prepareTurn (called by the loop) latches a one-shot decision;
        // consume it here so the next chatStream/bridge call sees fresh state.
        const pending = this.pendingPrepared
        this.pendingPrepared = null

        const canContinue = pending
          ? pending.isContinuation
          : !!(
              storeThisRequest &&
              this.lastResponseId &&
              !options?.freshConversation &&
              this.lastResponseModel === model
            )

        const xaiOptions: JSONObject = { store: storeThisRequest }
        if (canContinue && this.lastResponseId) {
          xaiOptions.previousResponseId = this.lastResponseId
        }
        const effort = mapXaiReasoningEffort(model, options?.thinking, this.reasoningEffort)
        if (effort) xaiOptions.reasoningEffort = effort

        return { xai: xaiOptions }
      },

      captureStepResult: (stepResult, options): void => {
        const model = options?.modelOverride ?? this.model
        const containsImages =
          stepResult.request.body && JSON.stringify(stepResult.request.body).includes('"image')
        const storeThisRequest = containsImages ? false : this.store

        const xaiMeta = stepResult.providerMetadata?.xai as { responseId?: unknown } | undefined
        const responseId = typeof xaiMeta?.responseId === 'string' ? xaiMeta.responseId : null

        // Mirror legacy chat-stream save semantics: only persist response ID
        // when text was emitted; tool-call-only responses can poison state.
        const hadTextContent = stepResult.text.length > 0

        if (responseId && storeThisRequest && hadTextContent) {
          this.lastResponseId = responseId
          this.lastResponseModel = model
        } else if (responseId && storeThisRequest && !hadTextContent) {
          this.lastResponseId = null
        }
      },

      getServerSideTools: (): ToolSet => {
        const set: ToolSet = {}
        if (this.webSearch) {
          if (typeof this.webSearch === 'object') {
            const cfg = this.webSearch
            const args: Record<string, unknown> = {}
            if (cfg.allowedDomains?.length || cfg.excludedDomains?.length) {
              const filters: Record<string, unknown> = {}
              if (cfg.allowedDomains?.length) filters.allowed_domains = cfg.allowedDomains
              if (cfg.excludedDomains?.length) filters.excluded_domains = cfg.excludedDomains
              args.searchParameters = { filters }
            }
            if (cfg.enableImageUnderstanding) args.enableImageUnderstanding = true
            set.web_search = xaiTools.webSearch(args)
          } else {
            set.web_search = xaiTools.webSearch()
          }
        }
        if (this.xSearch) {
          if (typeof this.xSearch === 'object') {
            const cfg = this.xSearch
            const args: Record<string, unknown> = {}
            if (cfg.allowedXHandles?.length) args.allowedXHandles = cfg.allowedXHandles
            if (cfg.excludedXHandles?.length) args.excludedXHandles = cfg.excludedXHandles
            if (cfg.fromDate) args.fromDate = cfg.fromDate
            if (cfg.toDate) args.toDate = cfg.toDate
            if (cfg.enableImageUnderstanding) args.enableImageUnderstanding = true
            if (cfg.enableVideoUnderstanding) args.enableVideoUnderstanding = true
            set.x_search = xaiTools.xSearch(args)
          } else {
            set.x_search = xaiTools.xSearch()
          }
        }
        if (this.codeExecution) {
          set.code_execution = xaiTools.codeExecution()
        }
        return set
      },
    }
  }

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      })
      return res.ok
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export const manifest: PluginManifest = {
  type: 'provider',
  name: 'xai',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new XAIProvider({
        apiKey: (cfg.api_key as string | undefined) ?? ctx.env.XAI_API_KEY ?? '',
        model: cfg.model as string | undefined,
        temperature: cfg.temperature as number | undefined,
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
      }),
    )
  },
}
