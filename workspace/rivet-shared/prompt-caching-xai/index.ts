/**
 * @rivetos/provider-xai
 *
 * xAI Grok provider using the Responses API (/v1/responses).
 * - Proper native Responses API implementation (no Chat Completions fallback)
 * - Stateful conversations via previous_response_id + store: true (only new messages sent)
 * - When images present: store: false + full history (per xAI recommendation to avoid failures)
 * - Encrypted reasoning passthrough
 * - Native SSE streaming with response.* events
 * - Full 2026 xAI Responses API support: web_search, x_search, code_interpreter, MCP servers,
 *   tool_choice, parallel_tool_calls, max_turns, configurable include[], output_tokens_details.reasoning_tokens,
 *   server_tool SSE events, citations logging.
 * - **Prompt caching support** per xAI best practices (stable prompt_cache_key, x-grok-conv-id header,
 *   cached_tokens parsing, front-loaded static content guidance).
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
} from '@rivetos/types'
import { hasImages } from '@rivetos/types'
import { ProviderError } from '@rivetos/types'
import { v4 as uuidv4 } from 'uuid' // For stable key generation fallback

// ---------------------------------------------------------------------------
  // Config — expanded per spec for full xAI support (as of April 2026)
  // ---------------------------------------------------------------------------

export interface XAIProviderConfig {
  apiKey: string
  model?: string // Default: 'grok-4.20-reasoning'
  baseUrl?: string // Default: 'https://api.x.ai/v1'
  temperature?: number // Default: not set (reasoning models don't use it)
  store?: boolean // Default: true (server stores conversation, only new messages sent)
  timeoutMs?: number // Default: 3600000 (1 hour for reasoning)
  /** Context window size in tokens (0 = unknown) */
  contextWindow?: number
  /** Max output tokens (0 = unknown) */
  maxOutputTokens?: number
  /** Enable xAI's built-in web search tool (default: true — already done today, keep it) */
  webSearch?: boolean | {
    allowed_domains?: string[]
    excluded_domains?: string[]
    enable_image_understanding?: boolean
  }
  /** Enable xAI's built-in X/Twitter search tool (default: false) */
  xSearch?: boolean | {
    allowed_x_handles?: string[]
    excluded_x_handles?: string[]
    from_date?: string  // ISO8601 "YYYY-MM-DD"
    to_date?: string    // ISO8601 "YYYY-MM-DD"
    enable_image_understanding?: boolean
    enable_video_understanding?: boolean
  }
  /** Enable xAI's code interpreter (sandboxed Python) (default: false) */
  codeInterpreter?: boolean
  /** Remote MCP servers to connect (default: none) */
  mcpServers?: Array<{
    server_url: string
    server_label: string
    server_description?: string
    allowed_tools?: string[]
    authorization?: string
    headers?: Record<string, string>
  }>
  /** tool_choice — controls when model uses tools. 'auto' (default), 'required', 'none', or {type:'function', function:{name:'...'}} */
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
  /** Allow parallel tool calls (default: true — xAI default) */
  parallelToolCalls?: boolean
  /** max_turns — limits server-side agentic tool turns per request */
  maxTurns?: number
  /** Extra include values beyond reasoning.encrypted_content. Options: 'no_inline_citations', 'verbose_streaming' */
  include?: string[]
}

// ---------------------------------------------------------------------------
  // Extended types for prompt caching
  // ---------------------------------------------------------------------------

export interface XAIExtendedChatOptions extends ChatOptions {
  /** Stable conversation identifier for prompt caching. Highly recommended for cache hits. */
  conversationId?: string
}

// ---------------------------------------------------------------------------
  // API types — xAI Responses API (expanded for new events/fields + caching)
  // ---------------------------------------------------------------------------

type XAIContentBlock =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: string }

interface XAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ResponsesInput =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | XAIContentBlock[] }
  | { role: 'assistant'; content: string; tool_calls?: XAIToolCall[] }
  | { type: 'function_call_output'; call_id: string; output: string }

interface XAIFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** SSE event shape from the xAI Responses API (expanded for caching) */
interface ResponsesEvent {
  type?: string
  item?: { type?: string; call_id?: string; id?: string; name?: string }
  call_id?: string
  item_id?: string
  delta?: string
  response?: {
    id?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cached_tokens?: number  // New: prompt caching support
      output_tokens_details?: {
        reasoning_tokens?: number
      }
    }
    citations?: unknown[]
  }
}

// ---------------------------------------------------------------------------
  // Conversion helpers (unchanged from PR #67 baseline)
  // ---------------------------------------------------------------------------

/** Convert ContentPart[] to xAI Responses API multimodal content blocks */
function convertContentPartsToXAI(parts: ContentPart[]): XAIContentBlock[] {
  const blocks: XAIContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'input_text', text: part.text })
    } else {
      // ImagePart
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
      const toolCallsList: XAIToolCall[] | undefined =
        msg.toolCalls && msg.toolCalls.length > 0
          ? msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments:
                  typeof tc.arguments === 'string'
                    ? tc.arguments
                    : JSON.stringify(tc.arguments),
              },
            }))
          : undefined

      if (content || toolCallsList) {
        const assistantMsg: ResponsesInput = toolCallsList
          ? { role: 'assistant', content, tool_calls: toolCallsList }
          : { role: 'assistant', content }
        result.push(assistantMsg)
      }
    } else if (
      msg.role === 'user' &&
      typeof msg.content !== 'string' &&
      Array.isArray(msg.content)
    ) {
      // Multimodal user message
      result.push({ role: 'user', content: convertContentPartsToXAI(msg.content) })
    } else {
      // system / plain user — pass through
      result.push({ role: msg.role, content: extractText(msg.content) || '' })
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

/**
 * Builds the array of xAI server-side built-in tools from config.
 * Exactly follows the expanded XAIProviderConfig fields and xAI Responses API shape.
 * - webSearch defaults to enabled (with optional domain filters + image understanding)
 * - xSearch, codeInterpreter, mcpServers are opt-in
 * - Clean, production-ready, no side effects.
 */
function buildBuiltInTools(config: XAIProviderConfig): unknown[] {
  const tools: unknown[] = []

  // web_search (default: true)
  if (config.webSearch !== false) {
    const wsConfig =
      typeof config.webSearch === 'object' && config.webSearch !== null
        ? config.webSearch
        : {}
    tools.push({
      type: 'web_search',
      ...wsConfig,
    })
  }

  // x_search / X (Twitter) search (default: false)
  if (config.xSearch) {
    const xsConfig =
      typeof config.xSearch === 'object' && config.xSearch !== null
        ? config.xSearch
        : {}
    tools.push({
      type: 'x_search',
      ...xsConfig,
    })
  }

  // code_interpreter (sandboxed Python)
  if (config.codeInterpreter === true) {
    tools.push({ type: 'code_interpreter' })
  }

  // Remote MCP servers
  if (Array.isArray(config.mcpServers) && config.mcpServers.length > 0) {
    for (const server of config.mcpServers) {
      tools.push({
        type: 'mcp',
        mcp: {
          server_url: server.server_url,
          server_label: server.server_label,
          server_description: server.server_description,
          allowed_tools: server.allowed_tools,
          authorization: server.authorization,
          headers: server.headers,
        },
      })
    }
  }

  return tools
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
  private configFull: XAIProviderConfig
  /** Track response IDs for stateful conversation continuity */
  private lastResponseId: string | null = null
  /** Stable cache key per conversation (generated once) */
  private promptCacheKey: string | null = null

  constructor(config: XAIProviderConfig) {
    this.configFull = config
    this.apiKey = config.apiKey
    this.model = config.model ?? 'grok-4.20-reasoning'
    this.baseUrl = config.baseUrl ?? 'https://api.x.ai/v1'
    this.temperature = config.temperature
    this.store = config.store ?? true // Server-side storage = no re-sending history
    this.timeoutMs = config.timeoutMs ?? 3_600_000
    this.contextWindowSize = config.contextWindow ?? 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0
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

  /** Reset conversation state (called by /new) */
  resetConversation(): void {
    this.lastResponseId = null
    this.promptCacheKey = null
  }

  /**
   * Generates or retrieves a stable prompt_cache_key.
   * Priority: conversationId from options > existing cached key > new UUID.
   * This ensures cache stability across chatStream/chat calls for the same conversation.
   */
  private getPromptCacheKey(options?: XAIExtendedChatOptions): string {
    if (options?.conversationId) {
      return options.conversationId
    }
    if (this.promptCacheKey) {
      return this.promptCacheKey
    }
    // Fallback: stable per-instance key (UUIDv4 for uniqueness)
    this.promptCacheKey = uuidv4()
    return this.promptCacheKey
  }

  // -----------------------------------------------------------------------
  // chatStream — SSE streaming via Responses API + prompt caching
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: XAIExtendedChatOptions): AsyncIterable<LLMChunk> {
    const containsImages = messages.some((m) => hasImages(m.content))
    const allMessages = convertMessages(messages)
    const model = options?.modelOverride ?? this.model

    // effectiveStore respects the image+store warning from xAI docs.
    // When images present we must send full history and cannot use previous_response_id.
    const effectiveStore = containsImages ? false : this.store
    const usePreviousResponse =
      effectiveStore && this.lastResponseId && !options?.freshConversation

    let input: ResponsesInput[]
    if (usePreviousResponse) {
      // Find the last user message and any tool results after it.
      // Server already has prior assistant messages.
      const lastUserIdx = allMessages.findLastIndex(
        (m) => 'role' in m && m.role === 'user'
      )
      input = lastUserIdx >= 0 ? allMessages.slice(lastUserIdx) : allMessages
    } else {
      input = allMessages
    }

    // === Prompt Caching Best Practices ===
    // 1. Front-load static content (system prompts, few-shot, references) — they form stable prefix.
    //    Current convertMessages preserves original order; system messages naturally come first.
    //    If reordering is safe in future (no tool results in prefix), sort static items to front.
    // 2. Use stable conversation ID via getPromptCacheKey().
    const promptCacheKey = this.getPromptCacheKey(options)

    const cfg = this.configFull
    const include: string[] = ['reasoning.encrypted_content', ...(cfg.include ?? [])]

    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
      store: effectiveStore,
      include,
      prompt_cache_key: promptCacheKey,  // Per xAI Responses API best practices
    }

    if (usePreviousResponse) {
      body.previous_response_id = this.lastResponseId
    }

    if (this.temperature !== undefined) {
      body.temperature = this.temperature
    }

    // Replaced tools section with buildBuiltInTools + else branch for no options.tools (per spec)
    const builtInTools = buildBuiltInTools(cfg)
    if (options?.tools?.length) {
      // Filter out function-based web_search (we use native built-in instead)
      const filteredTools = options.tools.filter((t) => t.name !== 'web_search')
      body.tools = [
        ...builtInTools,
        ...convertTools(filteredTools),
      ]
    } else if (builtInTools.length > 0) {
      body.tools = builtInTools
    }

    // New config-driven fields (per spec)
    if (cfg.toolChoice !== undefined) {
      body.tool_choice = cfg.toolChoice
    }
    if (cfg.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = cfg.parallelToolCalls
    }
    if (cfg.maxTurns !== undefined) {
      body.max_turns = cfg.maxTurns
    }

    const controller = new AbortController()
    const signal = options?.signal

    // Wire up external abort signal
    if (signal) {
      if (signal.aborted) {
        yield { type: 'error', error: 'Aborted' } as LLMChunk
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
          'x-grok-conv-id': promptCacheKey,  // Maximum compatibility per xAI docs
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err: unknown) {
      clearTimeout(timeout)
      if (err instanceof ProviderError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`xAI fetch failed: ${message}`, 0, 'xai', false)
    }

    if (!response.ok) {
      clearTimeout(timeout)
      const err = await response.text().catch(() => 'unknown')
      throw new ProviderError(
        `xAI ${String(response.status)}: ${err.slice(0, 500)}`,
        response.status,
        'xai',
      )
    }

    if (!response.body) {
      clearTimeout(timeout)
      throw new ProviderError('No response body', 0, 'xai', false)
    }

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const usage: any = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 }

    // Track tool calls being assembled
    const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map()
    let toolCallIndex = 0

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

          // Responses API streaming events — expanded for server-side tools
          if (event.type === 'response.output_item.added') {
            const item = event.item
            if (item?.type === 'function_call') {
              const idx = toolCallIndex++
              pendingToolCalls.set(idx, {
                id: item.call_id ?? item.id ?? `tc-${String(idx)}`,
                name: item.name ?? '',
                args: '',
              })
              yield {
                type: 'tool_call_start',
                toolCall: { index: idx, id: item.call_id ?? item.id, name: item.name },
              } as LLMChunk
            } else if (
              item?.type &&
              ['web_search_call', 'x_search_call', 'code_interpreter_call', 'mcp_call'].includes(item.type)
            ) {
              // New server-side tool handling (web_search_call etc.)
              yield {
                type: 'server_tool' as const,
                delta: `[${item.type}] ${item.name ?? item.type}`,
              } as LLMChunk
            }
          } else if (event.type === 'response.output_item.done') {
            // no-op (per spec)
          } else if (event.type === 'response.function_call_arguments.delta') {
            // Match by call_id/item_id, fallback to last created
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
              } as LLMChunk
            }
          } else if (event.type === 'response.function_call_arguments.done') {
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
            yield { type: 'tool_call_done', toolCall: { index: targetIdx } } as LLMChunk
          } else if (event.type === 'response.output_text.delta') {
            if (event.delta) {
              yield { type: 'text', delta: event.delta } as LLMChunk
            }
          } else if (event.type === 'response.reasoning.delta') {
            if (event.delta) {
              yield { type: 'reasoning', delta: event.delta } as LLMChunk
            }
          } else if (event.type === 'response.completed' || event.type === 'response.done') {
            // Extract usage + response ID for stateful conversation.
            // Do NOT update lastResponseId when images were sent (store: false).
            const resp = event.response
            if (resp?.id && !containsImages) {
              this.lastResponseId = resp.id
            }
            if (resp?.usage) {
              usage.promptTokens = resp.usage.input_tokens ?? 0
              usage.completionTokens = resp.usage.output_tokens ?? 0
              if (resp.usage.output_tokens_details?.reasoning_tokens !== undefined) {
                usage.reasoningTokens = resp.usage.output_tokens_details.reasoning_tokens
              }
              // === Prompt Caching: capture cached_tokens ===
              if (typeof resp.usage.cached_tokens === 'number') {
                usage.cachedTokens = resp.usage.cached_tokens
                if (resp.usage.cached_tokens > 0) {
                  console.log(`[xAI Prompt Cache Hit] cached_tokens=${resp.usage.cached_tokens} (key=${promptCacheKey})`)
                }
              }
            }
            if (resp?.citations && Array.isArray(resp.citations) && resp.citations.length > 0) {
              console.log('xAI citations:', resp.citations)
            }
          } else if (event.type === 'response.created') {
            // Also capture ID from response.created event (only in stateful mode)
            if (!containsImages && event.response?.id) {
              this.lastResponseId = event.response.id
            }
          }
        }
      }
    } finally {
      clearTimeout(timeout)
      reader.releaseLock()
    }

    yield { type: 'done', usage } as LLMChunk
  }

  // -----------------------------------------------------------------------
  // chat — non-streaming convenience (updated to handle cachedTokens)
  // -----------------------------------------------------------------------

  async chat(messages: Message[], options?: XAIExtendedChatOptions): Promise<LLMResponse> {
    let text = ''
    let reasoning = ''
    const toolCalls: ToolCall[] = []
    const pendingArgs: Map<number, { id: string; name: string; args: string }> = new Map()
    let usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 }

    for await (const chunk of this.chatStream(messages, options)) {
      switch (chunk.type) {
        case 'text':
          text += (chunk as any).delta ?? ''
          break
        case 'reasoning':
          reasoning += (chunk as any).delta ?? ''
          break
        case 'tool_call_start': {
          const idx = (chunk as any).toolCall?.index ?? 0
          pendingArgs.set(idx, {
            id: (chunk as any).toolCall?.id ?? `tc-${String(idx)}`,
            name: (chunk as any).toolCall?.name ?? '',
            args: '',
          })
          break
        }
        case 'tool_call_delta': {
          const idx = (chunk as any).toolCall?.index ?? 0
          const pending = pendingArgs.get(idx)
          if (pending) pending.args += (chunk as any).delta ?? ''
          break
        }
        case 'tool_call_done': {
          const idx = (chunk as any).toolCall?.index ?? 0
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
        case 'server_tool':
          // New: server-side tool started (web_search_call, etc.). Loop.ts will emit 🌐 status.
          console.log(`[xAI server_tool] ${(chunk as any).delta}`)
          break
        case 'done':
          if (chunk.usage) usage = chunk.usage as any
          break
        case 'error':
          throw new Error((chunk as any).error)
      }
    }

    if (toolCalls.length > 0) {
      return { type: 'tool_calls', toolCalls, content: text, usage } as LLMResponse
    }

    const fullContent = reasoning ? `<thinking>${reasoning}</thinking>\n\n${text}` : text
    return { type: 'text', content: fullContent, usage } as LLMResponse
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
