/**
 * @rivetos/provider-xai
 *
 * xAI Grok provider — first-class native implementation of the Responses API.
 *
 * Features:
 * - Native Responses API endpoint (/v1/responses)
 * - Stateful conversations via previous_response_id (server stores history)
 * - Encrypted reasoning passthrough for stateless continuity
 * - Native SSE streaming with full Responses API event handling
 * - Image understanding with input_image content blocks
 * - Server-side tools: web_search, x_search, code_interpreter
 * - Real-time status events for server-side tool activity
 * - Citations support (inline + URL list)
 * - Full usage tracking (input, output, reasoning, cached tokens)
 * - reasoning.effort support (multi-agent model only; grok-4.20 and grok-4-1-fast reason automatically)
 * - store: true by default; images force store: false
 * - 1-hour timeout for reasoning models
 * - Prompt caching via stable prompt_cache_key + x-grok-conv-id header
 */

import type {
  Provider,
  Message,
  ContentPart,
  ToolCall,
  ToolDefinition,
  ChatOptions,
  LLMChunk,
  LLMResponse,
  LLMUsage,
  ThinkingLevel,
  PluginManifest,
  PreparedTurn,
  ProviderSessionCapability,
} from '@rivetos/types'
import { ProviderError, hasImages, MODEL_DEFAULTS } from '@rivetos/types'
import { randomUUID } from 'node:crypto'

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
   *  'xhigh' is only valid for grok-4.20-multi-agent — will be downgraded to 'high' on other models. */
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
// API types — xAI Responses API
// ---------------------------------------------------------------------------

type XAIContentBlock =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: string }

type ResponsesInput =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | XAIContentBlock[] }
  | { role: 'assistant'; content: string }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

interface XAIFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Built-in tool definitions for the request body */
type XAIBuiltInTool =
  | {
      type: 'web_search'
      search_parameters?: { filters?: Record<string, unknown> }
      enable_image_understanding?: boolean
    }
  | {
      type: 'x_search'
      allowed_x_handles?: string[]
      excluded_x_handles?: string[]
      from_date?: string
      to_date?: string
      enable_image_understanding?: boolean
      enable_video_understanding?: boolean
    }
  | { type: 'code_interpreter' }

/** SSE event shape from the xAI Responses API */
interface ResponsesEvent {
  type?: string
  // output_item.added / output_item.done
  item?: {
    type?: string // 'function_call' | 'web_search_call' | 'x_search_call' | 'code_interpreter_call' | 'file_search_call' | 'mcp_call' | 'message'
    call_id?: string
    id?: string
    name?: string
    arguments?: string // for function_call items, full args in non-streaming
    status?: string // 'completed' | 'failed' | 'in_progress'
    content?: Array<{
      type?: string // 'output_text'
      text?: string
      annotations?: Array<{
        type?: string // 'url_citation'
        url?: string
        start_index?: number
        end_index?: number
        title?: string
      }>
    }>
  }
  // function_call_arguments.delta / .done
  call_id?: string
  item_id?: string
  delta?: string
  // response.completed / response.done / response.created / response.failed / response.incomplete
  response?: {
    id?: string
    status?: string // 'completed' | 'failed' | 'incomplete'
    usage?: {
      input_tokens?: number
      output_tokens?: number
      completion_tokens_details?: {
        reasoning_tokens?: number
      }
      prompt_tokens_details?: {
        cached_tokens?: number
      }
    }
    citations?: string[]
  }
  // error events
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

// Server-side tool types — events we observe but don't execute
const SERVER_SIDE_TOOL_TYPES = new Set([
  'web_search_call',
  'x_search_call',
  'code_interpreter_call',
  'file_search_call',
  'mcp_call',
])

// reasoning.effort is ONLY supported by grok-4.20-multi-agent (controls agent count).
// grok-4.20 and grok-4-1-fast reason automatically — sending reasoning.effort causes a 400 error.

// ---------------------------------------------------------------------------
// Message conversion (xAI Responses API format)
// ---------------------------------------------------------------------------

/** Convert ContentPart[] to xAI native multimodal content blocks */
function convertContentPartsToXAI(parts: ContentPart[]): XAIContentBlock[] {
  const blocks: XAIContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'input_text', text: part.text })
    } else {
      // ImagePart — xAI expects image_url as a flat string
      if (part.data) {
        blocks.push({
          type: 'input_image',
          image_url: `data:${part.mimeType ?? 'image/jpeg'};base64,${part.data}`,
        })
      } else if (part.url) {
        blocks.push({
          type: 'input_image',
          image_url: part.url,
        })
      }
    }
  }
  return blocks
}

/** Extract text from string | ContentPart[] */
function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function convertMessages(messages: Message[]): ResponsesInput[] {
  const result: ResponsesInput[] = []

  for (const msg of messages) {
    if (msg.role === 'tool') {
      // Tool results → function_call_output items
      // Note: xAI function_call_output only supports text — images are described as references
      let output = extractText(msg.content) || ''
      if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
        const imageCount = msg.content.filter((p) => p.type === 'image').length
        if (imageCount > 0) {
          output += `\n[${imageCount} image(s) returned — see image content in context]`
        }
      }
      result.push({
        type: 'function_call_output',
        call_id: msg.toolCallId ?? '',
        output,
      })
    } else if (msg.role === 'assistant') {
      const content = extractText(msg.content) || ''

      // Emit text content as a plain assistant message
      if (content) {
        result.push({ role: 'assistant', content })
      }

      // Emit tool calls as separate function_call items (Responses API format)
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          result.push({
            type: 'function_call',
            id: tc.id,
            call_id: tc.id,
            name: tc.name,
            arguments:
              typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
          })
        }
      }
    } else if (
      msg.role === 'user' &&
      typeof msg.content !== 'string' &&
      Array.isArray(msg.content)
    ) {
      // Multimodal user message — use xAI native content blocks
      const blocks = convertContentPartsToXAI(msg.content)
      if (blocks.length > 0) {
        result.push({ role: 'user', content: blocks })
      } else {
        // Fallback: extract text if multimodal conversion produced no blocks
        const text = extractText(msg.content)
        if (text) {
          result.push({ role: 'user', content: text })
        }
      }
    } else {
      // system / plain user — pass through (skip empty content)
      const text = extractText(msg.content) || ''
      if (text) {
        result.push({ role: msg.role, content: text })
      }
    }
  }

  return result
}

function convertTools(tools: ToolDefinition[]): XAIFunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
}

// ---------------------------------------------------------------------------
// Built-in tool construction
// ---------------------------------------------------------------------------

function buildWebSearchTool(config: boolean | WebSearchConfig): XAIBuiltInTool {
  if (config === true || typeof config === 'boolean') {
    return { type: 'web_search' }
  }
  const tool: XAIBuiltInTool & { type: 'web_search' } = { type: 'web_search' }
  if (config.enableImageUnderstanding) {
    tool.enable_image_understanding = true
  }
  if (config.allowedDomains?.length || config.excludedDomains?.length) {
    const filters: Record<string, unknown> = {}
    if (config.allowedDomains?.length) {
      filters.allowed_domains = config.allowedDomains
    }
    if (config.excludedDomains?.length) {
      filters.excluded_domains = config.excludedDomains
    }
    tool.search_parameters = { filters }
  }
  return tool
}

function buildXSearchTool(config: boolean | XSearchConfig): XAIBuiltInTool {
  if (config === true || typeof config === 'boolean') {
    return { type: 'x_search' }
  }
  const tool: Record<string, unknown> = { type: 'x_search' }
  if (config.allowedXHandles?.length) tool.allowed_x_handles = config.allowedXHandles
  if (config.excludedXHandles?.length) tool.excluded_x_handles = config.excludedXHandles
  if (config.fromDate) tool.from_date = config.fromDate
  if (config.toDate) tool.to_date = config.toDate
  if (config.enableImageUnderstanding) tool.enable_image_understanding = true
  if (config.enableVideoUnderstanding) tool.enable_video_understanding = true
  return tool as XAIBuiltInTool
}

// ---------------------------------------------------------------------------
// Type guard for SSE events
// ---------------------------------------------------------------------------

function isResponsesEvent(value: unknown): value is ResponsesEvent {
  return typeof value === 'object' && value !== null
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class XAIProvider implements Provider {
  id = 'xai'
  name = 'xAI Grok'
  private apiKey: string
  private model: string
  private baseUrl: string
  private temperature: number | undefined
  private store: boolean
  private timeoutMs: number
  private contextWindowSize: number
  private outputTokenLimit: number

  // Server-side tools config
  private webSearch: boolean | WebSearchConfig
  private xSearch: boolean | XSearchConfig
  private codeExecution: boolean

  // Request options
  private reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | undefined
  private maxTurns: number | undefined
  private toolChoice:
    | 'auto'
    | 'required'
    | 'none'
    | { type: 'function'; function: { name: string } }
    | undefined
  private parallelToolCalls: boolean | undefined
  private truncation: 'auto' | 'disabled' | undefined
  private instructions: string | undefined

  /** Track response IDs for stateful conversation continuity */
  private lastResponseId: string | null = null
  /** Track which model the stored conversation belongs to */
  private lastResponseModel: string | null = null
  /** Stable prompt cache key for xAI prompt caching (persists per conversation) */
  private promptCacheKey: string | null = null

  /**
   * Set by `prepareTurn` immediately before `chatStream`. Tells chatStream
   * the loop has already trimmed the message array — don't re-slice in
   * buildRequestBody. Cleared as soon as chatStream consumes it.
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
    this.temperature = config.temperature
    this.store = config.store ?? true
    this.timeoutMs = config.timeoutMs ?? 3_600_000
    this.contextWindowSize = config.contextWindow ?? 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0

    // Server-side tools
    this.webSearch = config.webSearch ?? false
    this.xSearch = config.xSearch ?? false
    this.codeExecution = config.codeExecution ?? false

    // Request options
    this.reasoningEffort = config.reasoningEffort
    this.maxTurns = config.maxTurns
    this.toolChoice = config.toolChoice
    this.parallelToolCalls = config.parallelToolCalls
    this.truncation = config.truncation
    this.instructions = config.instructions
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

  /**
   * Decide whether this turn can continue from prior server-side state, and
   * trim the message array to just what the server doesn't already have.
   *
   * Returns the (possibly sliced) Message[] the loop should pass to
   * `chatStream`, plus an `isContinuation` flag. Stashes the decision on the
   * instance so the upcoming `chatStream` call knows not to re-slice.
   */
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
    //
    // Tool-call continuations: server's last response output included
    // `function_call` items (encoded on `assistant` messages with `toolCalls`).
    // Everything *after* that assistant message is new (tool results + any
    // subsequent steer/system/user messages).
    //
    // New user turns (no recent tool calls): trim from the last user message
    // onward — the server already has everything before it.
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

  // -----------------------------------------------------------------------
  // Prompt cache key management
  // -----------------------------------------------------------------------

  /**
   * Get or generate a stable prompt_cache_key for xAI prompt caching.
   * Priority: conversationId from options > existing cached key > new random UUID.
   * Stable keys ensure cache hits across turns in the same conversation.
   */
  private getPromptCacheKey(conversationId?: string): string {
    if (conversationId) {
      this.promptCacheKey = conversationId
      return conversationId
    }
    if (this.promptCacheKey) {
      return this.promptCacheKey
    }
    this.promptCacheKey = randomUUID()
    return this.promptCacheKey
  }

  // -----------------------------------------------------------------------
  // Build include array
  // -----------------------------------------------------------------------

  private buildIncludeArray(): string[] {
    const include: string[] = ['reasoning.encrypted_content']
    // Future: add 'verbose_streaming', 'web_search_call.action.sources', etc. based on config
    return include
  }

  // -----------------------------------------------------------------------
  // Build tools array (built-in + function tools)
  // -----------------------------------------------------------------------

  private buildToolsArray(
    functionTools?: ToolDefinition[],
  ): (XAIBuiltInTool | XAIFunctionTool)[] | undefined {
    const tools: (XAIBuiltInTool | XAIFunctionTool)[] = []

    // Add configured built-in tools
    if (this.webSearch) {
      tools.push(buildWebSearchTool(this.webSearch))
    }
    if (this.xSearch) {
      tools.push(buildXSearchTool(this.xSearch))
    }
    if (this.codeExecution) {
      tools.push({ type: 'code_interpreter' })
    }

    // Add function tools from the agent loop
    if (functionTools?.length) {
      tools.push(...convertTools(functionTools))
    }

    return tools.length > 0 ? tools : undefined
  }

  // -----------------------------------------------------------------------
  // Resolve reasoning effort (config default + per-request override)
  // -----------------------------------------------------------------------

  private resolveReasoningEffort(
    model: string,
    thinking?: ThinkingLevel,
  ): { effort: 'low' | 'medium' | 'high' | 'xhigh' } | undefined {
    // Per-request override takes precedence
    const level = thinking ?? this.reasoningEffort
    if (!level || level === 'off') return undefined

    // Only grok-4.20-multi-agent supports reasoning.effort (controls agent count).
    // grok-4.20 and grok-4-1-fast reason automatically — sending reasoning.effort errors.
    if (!model.includes('multi-agent')) {
      return undefined
    }

    // 'xhigh' is only valid for multi-agent models — but we're already gated to multi-agent
    return { effort: level }
  }

  // -----------------------------------------------------------------------
  // Build request body (extracted for continuation fallback retry)
  // -----------------------------------------------------------------------

  private buildRequestBody(
    allMessages: ResponsesInput[],
    model: string,
    storeThisRequest: boolean,
    canContinue: boolean,
    skipInternalSlicing: boolean,
    options?: ChatOptions,
  ): { input: ResponsesInput[]; body: Record<string, unknown>; promptCacheKey: string } {
    let input: ResponsesInput[]
    if (canContinue && !skipInternalSlicing) {
      // Server has everything up to + including its last response.
      // Find what's genuinely NEW since that response.
      //
      // Tool call continuations: the server's response output included the
      // function_call items. Everything AFTER the last function_call is new
      // (function_call_output items, steer/system messages, etc.).
      //
      // New user turns: no function_call items in the current input, so
      // the new content starts at the last user message.
      const lastFnCallIdx = allMessages.findLastIndex(
        (m) => 'type' in m && m.type === 'function_call',
      )

      if (lastFnCallIdx >= 0) {
        // Tool call continuation — send only what's after the last function_call.
        // The server already has the user message, assistant response, and
        // function_call items from its stored conversation.
        input = allMessages.slice(lastFnCallIdx + 1)
      } else {
        // New user turn — send from the last user message forward.
        const lastUserIdx = allMessages.findLastIndex((m) => 'role' in m && m.role === 'user')
        input = lastUserIdx >= 0 ? allMessages.slice(lastUserIdx) : allMessages
      }
    } else {
      input = allMessages
    }

    // Safety: filter out any messages with empty content to prevent
    // "Each message must have at least one content element" errors
    input = input.filter((item) => {
      if (!('role' in item)) return true // function_call, function_call_output — always keep
      const content = (item as Record<string, unknown>).content
      if (content === undefined || content === null || content === '') return false
      if (Array.isArray(content) && content.length === 0) return false
      return true
    })

    // Prompt caching: get or generate a stable cache key
    const promptCacheKey = this.getPromptCacheKey(options?.conversationId)

    // Build request body
    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
      store: storeThisRequest,
      include: this.buildIncludeArray(),
      prompt_cache_key: promptCacheKey,
    }

    // Continue from previous response if available
    if (canContinue) {
      body.previous_response_id = this.lastResponseId
    }

    // Temperature (not supported by reasoning models, but pass if configured)
    if (this.temperature !== undefined) {
      body.temperature = this.temperature
    }

    // Tools array (built-in + function tools)
    const tools = this.buildToolsArray(options?.tools)
    if (tools) {
      body.tools = tools
    }

    // Tool choice
    if (this.toolChoice !== undefined) {
      body.tool_choice = this.toolChoice
    }

    // Parallel tool calls
    if (this.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = this.parallelToolCalls
    }

    // Max turns (server-side agentic loop limit)
    if (this.maxTurns !== undefined) {
      body.max_turns = this.maxTurns
    }

    // Max output tokens
    if (this.outputTokenLimit > 0) {
      body.max_output_tokens = this.outputTokenLimit
    }

    // Reasoning effort (model-gated)
    const reasoning = this.resolveReasoningEffort(model, options?.thinking)
    if (reasoning) {
      body.reasoning = reasoning
    }

    // Truncation
    if (this.truncation !== undefined) {
      body.truncation = this.truncation
    }

    // Developer instructions
    if (this.instructions !== undefined) {
      body.instructions = this.instructions
    }

    return { input, body, promptCacheKey }
  }

  // -----------------------------------------------------------------------
  // chatStream — SSE streaming via xAI Responses API
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const allMessages = convertMessages(messages)
    const model = options?.modelOverride ?? this.model

    // xAI docs: "When sending images, it is advised to not store request/response
    // history on the server. Otherwise the request may fail."
    const containsImages = messages.some((m) => hasImages(m.content))

    // Determine store for this request — force false when images present
    const storeThisRequest = containsImages ? false : this.store

    // If the agent loop called `prepareTurn` first, trust its decision and
    // do NOT re-slice in buildRequestBody (the messages were already trimmed
    // at the Message[] layer). Otherwise — legacy callers — fall back to the
    // existing internal slicing logic.
    let canContinue: boolean
    let skipInternalSlicing: boolean
    if (this.pendingPrepared) {
      canContinue = this.pendingPrepared.isContinuation
      skipInternalSlicing = true
      this.pendingPrepared = null
    } else {
      canContinue = !!(
        storeThisRequest &&
        this.lastResponseId &&
        !options?.freshConversation &&
        this.lastResponseModel === model
      )
      skipInternalSlicing = false
    }

    // --- Build input & request body ---
    const { input, body, promptCacheKey } = this.buildRequestBody(
      allMessages,
      model,
      storeThisRequest,
      canContinue,
      skipInternalSlicing,
      options,
    )

    // --- Fetch (with continuation fallback on 400) ---

    const controller = new AbortController()
    const signal = options?.signal

    // Wire up external abort signal
    if (signal) {
      if (signal.aborted) {
        yield { type: 'error', error: 'Aborted' }
        return
      }
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    // Timeout for reasoning models
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'x-grok-conv-id': promptCacheKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err: unknown) {
      clearTimeout(timeout)
      // Invalidate continuation state on failure — next turn starts fresh
      this.lastResponseId = null
      if (err instanceof ProviderError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`xAI fetch failed: ${message}`, 0, 'xai', false)
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unknown')
      clearTimeout(timeout)

      // Log response body + input shape for debugging 400 errors
      if (response.status === 400) {
        const inputSummary = input.map((item) => {
          if ('role' in item) {
            const c = (item as Record<string, unknown>).content
            const contentDesc = Array.isArray(c)
              ? `array(${(c as unknown[]).length})`
              : typeof c === 'string'
                ? `string(${c.length})`
                : typeof c
            return `${(item as Record<string, unknown>).role as string}:${contentDesc}`
          }
          return ((item as Record<string, unknown>).type as string | undefined) ?? 'unknown'
        })
        console.error(
          `[xAI] 400 error — response: ${errBody.slice(0, 1000)}\n` +
            `  input shape: [${inputSummary.join(', ')}], ` +
            `canContinue=${String(canContinue)}, prevResponseId=${this.lastResponseId ?? 'none'}`,
        )
      }

      // Invalidate continuation state on any non-OK response — next turn starts fresh
      this.lastResponseId = null
      throw new ProviderError(
        `xAI ${String(response.status)}: ${errBody.slice(0, 500)}`,
        response.status,
        'xai',
      )
    }

    if (!response.body) {
      clearTimeout(timeout)
      throw new ProviderError('No response body', 0, 'xai', false)
    }

    // --- Stream parsing ---

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const usage: LLMUsage = { promptTokens: 0, completionTokens: 0 }
    let citations: string[] | undefined

    // Track tool calls being assembled (client-side function calls only)
    const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map()
    let toolCallIndex = 0

    // Track whether we got a successful completion (for response ID management)
    let completedSuccessfully = false
    // Track whether the response included actual text content (not just tool calls).
    // We only save the response ID for continuation when text was emitted — tool-call-only
    // responses can create poisoned server-side state where xAI stores an assistant message
    // with empty content, which then fails validation on the next continuation attempt.
    let hadTextContent = false

    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break

        buffer += decoder.decode(result.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue

          let event: ResponsesEvent
          try {
            const parsed: unknown = JSON.parse(data)
            if (!isResponsesEvent(parsed)) continue
            event = parsed
          } catch {
            continue
          }

          // ----- xAI Responses API streaming events -----

          if (event.type === 'response.output_item.added') {
            const item = event.item
            if (!item?.type) continue

            if (item.type === 'function_call') {
              // Client-side tool call — yield to agent loop for execution
              const idx = toolCallIndex++
              pendingToolCalls.set(idx, {
                id: item.call_id ?? item.id ?? `tc-${String(idx)}`,
                name: item.name ?? '',
                args: '',
              })
              yield {
                type: 'tool_call_start',
                toolCall: { index: idx, id: item.call_id ?? item.id, name: item.name },
              }
            } else if (SERVER_SIDE_TOOL_TYPES.has(item.type)) {
              // Server-side tool — xAI executes this, we just observe
              const toolType = item.type.replace('_call', '')
              const name = item.name ?? toolType
              const args = item.arguments ? `(${item.arguments})` : ''
              yield { type: 'status', delta: `${toolType}: ${name}${args}` }
            }
            // 'message' type items — text/reasoning will come via delta events
          } else if (event.type === 'response.function_call_arguments.delta') {
            // Client-side function call argument streaming
            let targetIdx = toolCallIndex - 1
            const matchId = event.call_id ?? event.item_id
            if (matchId) {
              for (const [idx, tc] of pendingToolCalls.entries()) {
                if (tc.id === matchId) {
                  targetIdx = idx
                  break
                }
              }
            }
            const pending = pendingToolCalls.get(targetIdx)
            if (pending) {
              pending.args += event.delta ?? ''
              yield {
                type: 'tool_call_delta',
                delta: event.delta ?? '',
                toolCall: { index: targetIdx },
              }
            }
          } else if (event.type === 'response.function_call_arguments.done') {
            // Client-side function call complete
            let targetIdx = toolCallIndex - 1
            const matchId = event.call_id ?? event.item_id
            if (matchId) {
              for (const [idx, tc] of pendingToolCalls.entries()) {
                if (tc.id === matchId) {
                  targetIdx = idx
                  break
                }
              }
            }
            yield { type: 'tool_call_done', toolCall: { index: targetIdx } }
          } else if (event.type === 'response.output_text.delta') {
            // Text content (may include inline citations as [[N]](url) markdown)
            if (event.delta) {
              hadTextContent = true
              yield { type: 'text', delta: event.delta }
            }
          } else if (event.type === 'response.reasoning.delta') {
            // Reasoning/thinking content
            if (event.delta) {
              yield { type: 'reasoning', delta: event.delta }
            }
          } else if (event.type === 'response.output_item.done') {
            // An output item finished. Check for server-side tool completion status.
            const item = event.item
            if (item?.type && SERVER_SIDE_TOOL_TYPES.has(item.type)) {
              const toolType = item.type.replace('_call', '')
              const status = item.status ?? 'done'
              yield { type: 'status', delta: `${toolType}: ${status}` }
            }
          } else if (event.type === 'response.completed') {
            // Full response complete — extract usage, citations, response ID
            completedSuccessfully = true
            const resp = event.response
            if (resp?.id && storeThisRequest && hadTextContent) {
              // Only save response ID for continuation when the response had text content.
              // Tool-call-only responses create poisoned server-side state: xAI stores an
              // assistant message with empty content, and continuation against it fails with
              // "Each message must have at least one content element".
              this.lastResponseId = resp.id
              this.lastResponseModel = model
            } else if (resp?.id && storeThisRequest && !hadTextContent) {
              // Tool-call-only response — don't continue from this state.
              // Next request will send the full conversation, which we control.
              console.log(
                `[xAI] Skipping continuation save — tool-call-only response (id=${resp.id})`,
              )
              this.lastResponseId = null
            }
            if (resp?.usage) {
              usage.promptTokens = resp.usage.input_tokens ?? 0
              usage.completionTokens = resp.usage.output_tokens ?? 0
              if (resp.usage.completion_tokens_details?.reasoning_tokens) {
                usage.reasoningTokens = resp.usage.completion_tokens_details.reasoning_tokens
              }
              if (resp.usage.prompt_tokens_details?.cached_tokens) {
                usage.cachedTokens = resp.usage.prompt_tokens_details.cached_tokens
                if (resp.usage.prompt_tokens_details.cached_tokens > 0) {
                  console.log(
                    `[xAI] Prompt cache hit: ${String(resp.usage.prompt_tokens_details.cached_tokens)} cached tokens (key=${promptCacheKey})`,
                  )
                }
              }
            }
            if (resp?.citations?.length) {
              citations = resp.citations
            }
          } else if (event.type === 'response.done') {
            // Alias for response.completed in some API versions
            if (!completedSuccessfully) {
              completedSuccessfully = true
              const resp = event.response
              if (resp?.id && storeThisRequest && hadTextContent) {
                this.lastResponseId = resp.id
                this.lastResponseModel = model
              } else if (resp?.id && storeThisRequest && !hadTextContent) {
                console.log(
                  `[xAI] Skipping continuation save — tool-call-only response (id=${resp.id})`,
                )
                this.lastResponseId = null
              }
              if (resp?.usage) {
                usage.promptTokens = resp.usage.input_tokens ?? 0
                usage.completionTokens = resp.usage.output_tokens ?? 0
                if (resp.usage.completion_tokens_details?.reasoning_tokens) {
                  usage.reasoningTokens = resp.usage.completion_tokens_details.reasoning_tokens
                }
                if (resp.usage.prompt_tokens_details?.cached_tokens) {
                  usage.cachedTokens = resp.usage.prompt_tokens_details.cached_tokens
                  if (resp.usage.prompt_tokens_details.cached_tokens > 0) {
                    console.log(
                      `[xAI] Prompt cache hit: ${String(resp.usage.prompt_tokens_details.cached_tokens)} cached tokens (key=${promptCacheKey})`,
                    )
                  }
                }
              }
              if (resp?.citations?.length) {
                citations = resp.citations
              }
            }
          } else if (event.type === 'response.created') {
            // Request accepted — do NOT save response ID here.
            // Wait for response.completed to confirm success.
          } else if (event.type === 'response.failed') {
            // Request failed mid-stream
            const errMsg =
              event.response?.status === 'failed'
                ? `xAI response failed${event.error?.message ? `: ${event.error.message}` : ''}`
                : 'xAI response failed'
            yield { type: 'error', error: errMsg }
            // Don't save response ID on failure
          } else if (event.type === 'response.incomplete') {
            // Response truncated — model hit limits. Yield what we have.
            // Don't save response ID for incomplete responses — state may be inconsistent
            yield { type: 'status', delta: 'Response truncated (hit output limits)' }
          } else if (event.type === 'error') {
            // SSE-level error
            const errMsg = event.error?.message ?? 'Unknown xAI stream error'
            yield { type: 'error', error: errMsg }
          }
        }
      }
    } finally {
      clearTimeout(timeout)
      reader.releaseLock()
    }

    // Yield final done chunk with usage and citations
    const doneChunk: LLMChunk = { type: 'done', usage }
    if (citations?.length) {
      doneChunk.citations = citations
    }
    yield doneChunk
  }

  // -----------------------------------------------------------------------
  // chat — non-streaming convenience
  // -----------------------------------------------------------------------

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    let text = ''
    let reasoning = ''
    const toolCalls: ToolCall[] = []
    const pendingArgs: Map<number, { id: string; name: string; args: string }> = new Map()
    let usage: LLMUsage = { promptTokens: 0, completionTokens: 0 }

    for await (const chunk of this.chatStream(messages, options)) {
      switch (chunk.type) {
        case 'text':
          text += chunk.delta ?? ''
          break
        case 'reasoning':
          reasoning += chunk.delta ?? ''
          break
        case 'tool_call_start': {
          const idx = chunk.toolCall?.index ?? 0
          pendingArgs.set(idx, {
            id: chunk.toolCall?.id ?? `tc-${String(idx)}`,
            name: chunk.toolCall?.name ?? '',
            args: '',
          })
          break
        }
        case 'tool_call_delta': {
          const idx = chunk.toolCall?.index ?? 0
          const pending = pendingArgs.get(idx)
          if (pending) pending.args += chunk.delta ?? ''
          break
        }
        case 'tool_call_done': {
          const idx = chunk.toolCall?.index ?? 0
          const pending = pendingArgs.get(idx)
          if (pending) {
            let args: Record<string, unknown>
            try {
              args = JSON.parse(pending.args) as Record<string, unknown>
            } catch {
              args = { raw: pending.args }
            }
            toolCalls.push({ id: pending.id, name: pending.name, arguments: args })
            pendingArgs.delete(idx)
          }
          break
        }
        case 'status':
          // Server-side tool activity — informational, not actionable in non-streaming mode
          break
        case 'done':
          if (chunk.usage) usage = chunk.usage
          break
        case 'error':
          throw new Error(chunk.error)
      }
    }

    if (toolCalls.length > 0) {
      return { type: 'tool_calls', toolCalls, content: text, usage }
    }

    const fullContent = reasoning ? `<thinking>${reasoning}</thinking>\n\n${text}` : text
    return { type: 'text', content: fullContent, usage }
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
