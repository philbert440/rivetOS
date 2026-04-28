/**
 * @rivetos/provider-anthropic
 *
 * Anthropic Claude provider.
 * - API key only (OAuth/subscription auth removed)
 * - Raw fetch for full control over headers, thinking, and prompt caching.
 * - Claude 4 adaptive thinking support (April 2026 spec).
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
  ThinkingLevel,
  PluginManifest,
} from '@rivetos/types'
import { ProviderError } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  apiKey: string
  model: string
  maxTokens?: number
  baseUrl?: string
  /** Context window size in tokens (0 = unknown) */
  contextWindow?: number
  /** Max output tokens (0 = unknown) */
  maxOutputTokens?: number
}

// ---------------------------------------------------------------------------
// Thinking budgets (legacy Claude 3.x only)
// ---------------------------------------------------------------------------

const THINKING_BUDGETS: Record<ThinkingLevel, number | null> = {
  off: null,
  low: 2000,
  medium: 10000,
  high: 50000,
  xhigh: 50000, // xhigh is xAI multi-agent specific — treat as high for other providers
}

// For Claude 4 family (Opus/Sonnet 4), we use the new adaptive thinking API with output_config.effort.
// Older models continue to use the legacy { type: 'enabled', budget_tokens } format.
// See Anthropic's Claude 4 Thinking API announcement for details.

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  source?: { type: string; media_type?: string; data?: string; url?: string }
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  cache_control?: { type: string }
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface AnthropicRequestBody {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  stream: boolean
  system?: AnthropicContentBlock[] | string
  tools?: AnthropicTool[]
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' }
  output_config?: {
    effort: 'low' | 'medium' | 'high' | 'xhigh'
  }
}

/** SSE event from Anthropic's streaming API */
interface AnthropicSSEEvent {
  type?: string
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  content_block?: {
    type?: string
    id?: string
    name?: string
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
  }
  usage?: {
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  error?: { message?: string; type?: string }
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/** Convert ContentPart[] to Anthropic content blocks */
function convertContentParts(parts: ContentPart[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text })
    } else {
      // ImagePart
      if (part.data) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mimeType ?? 'image/jpeg',
            data: part.data,
          },
        })
      } else if (part.url) {
        blocks.push({
          type: 'image',
          source: {
            type: 'url',
            url: part.url,
          },
        })
      }
    }
  }
  return blocks
}

/** Extract text from ContentPart[] */
function extractTextFromParts(parts: ContentPart[]): string {
  return parts
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function convertMessages(messages: Message[]): { system: string; converted: AnthropicMessage[] } {
  let system = ''
  const converted: AnthropicMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : extractTextFromParts(msg.content)
      system += (system ? '\n\n' : '') + text
      continue
    }

    if (msg.role === 'tool') {
      // Build tool result content — supports multimodal (text + images)
      let toolContent: string | AnthropicContentBlock[]
      if (typeof msg.content === 'string') {
        toolContent = msg.content
      } else {
        // Multimodal tool result — convert to Anthropic content blocks
        const blocks: AnthropicContentBlock[] = []
        for (const part of msg.content) {
          if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text })
          } else {
            // ImagePart
            if (part.data) {
              blocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: part.mimeType ?? 'image/jpeg',
                  data: part.data,
                },
              })
            } else if (part.url) {
              blocks.push({
                type: 'image',
                source: { type: 'url', url: part.url },
              })
            }
          }
        }
        toolContent = blocks.length > 0 ? blocks : ''
      }
      converted.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId ?? 'unknown',
            content: toolContent,
          },
        ],
      })
      continue
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const blocks: AnthropicContentBlock[] = []
      const textContent =
        typeof msg.content === 'string' ? msg.content : extractTextFromParts(msg.content)
      if (textContent) blocks.push({ type: 'text', text: textContent })
      for (const tc of msg.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })
      }
      converted.push({ role: 'assistant', content: blocks })
      continue
    }

    // User or plain assistant — handle multimodal content
    if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
      converted.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: convertContentParts(msg.content),
      })
    } else {
      converted.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: typeof msg.content === 'string' ? msg.content : extractTextFromParts(msg.content),
      })
    }
  }

  // Defensive: strip orphaned tool_result blocks that reference non-existent tool_use IDs.
  // This prevents 400 errors when history gets corrupted (e.g., after compaction includes
  // working tool messages that become orphaned on subsequent turns).
  const validToolUseIds = new Set<string>()
  for (const msg of converted) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type: string; id?: string }>) {
        if (block.type === 'tool_use' && block.id) {
          validToolUseIds.add(block.id)
        }
      }
    }
  }

  const sanitized = converted.filter((msg) => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const hasOrphanedToolResult = (
        msg.content as Array<{ type: string; tool_use_id?: string }>
      ).some(
        (block) => block.type === 'tool_result' && !validToolUseIds.has(block.tool_use_id ?? ''),
      )
      if (hasOrphanedToolResult) {
        console.warn(
          '[anthropic] Dropped orphaned tool_result message — tool_use_id not found in history',
        )
        return false
      }
    }
    return true
  })

  return { system, converted: sanitized }
}

function convertTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isAnthropicEvent(value: unknown): value is AnthropicSSEEvent {
  return typeof value === 'object' && value !== null
}

/** Detect Claude 4 family models that require the new adaptive thinking format */
function isClaude4Model(model: string): boolean {
  return /^claude-(opus|sonnet|haiku)-4(-\d+)?/i.test(model)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements Provider {
  id = 'anthropic'
  name = 'Anthropic Claude'
  private apiKey: string
  private model: string
  private maxTokens: number
  private baseUrl: string
  private initialized = false
  private contextWindow: number
  private outputTokenLimit: number

  constructor(config: AnthropicProviderConfig) {
    if (!config.model) {
      throw new ProviderError(
        'Model is required. Set config.model to a Claude model name (e.g. "claude-opus-4-7")',
        400,
        'anthropic',
        false,
      )
    }

    this.apiKey = config.apiKey
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com'
    this.contextWindow = config.contextWindow ?? 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0
  }

  getModel(): string {
    return this.model
  }

  setModel(model: string): void {
    this.model = model
  }

  getContextWindow(): number {
    return this.contextWindow
  }

  getMaxOutputTokens(): number {
    return this.outputTokenLimit
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }
  }

  // -----------------------------------------------------------------------
  // chatStream — raw fetch with SSE parsing
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const { system, converted } = convertMessages(messages)
    const headers = this.buildHeaders()
    const model = options?.modelOverride ?? this.model

    const body: AnthropicRequestBody = {
      model,
      max_tokens: this.maxTokens,
      messages: converted,
      stream: true,
    }

    // System prompt — with ephemeral caching for token savings (~90% cheaper on cache hits)
    if (system) {
      body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    }

    if (options?.tools?.length) {
      body.tools = convertTools(options.tools)
    }

    const thinking = options?.thinking ?? 'off'
    const budget = THINKING_BUDGETS[thinking]
    if (budget !== null) {
      const isClaude4 = isClaude4Model(model)

      if (isClaude4) {
        // Claude 4 family uses the new adaptive thinking API (Claude 4 / Opus 4.7)
        // No budget_tokens — server-managed. Use output_config.effort instead.
        // Do not send max_tokens math based on budget for Claude 4.
        const effortMap: Record<ThinkingLevel, 'low' | 'medium' | 'high' | 'xhigh'> = {
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          off: 'medium', // should not reach here
        }
        const effort = effortMap[thinking]

        body.thinking = { type: 'adaptive' }
        body.output_config = { effort }

        // For adaptive thinking on Claude 4, just use configured max_tokens directly.
        body.max_tokens = this.maxTokens
      } else {
        // Legacy behavior for Claude 3 / older models
        // max_tokens must be > budget_tokens — always ensure full response space
        body.max_tokens = budget + this.maxTokens
        body.thinking = { type: 'enabled', budget_tokens: budget }
      }
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown')
      throw new ProviderError(
        `Anthropic ${String(response.status)}: ${err.slice(0, 500)}`,
        response.status,
        'anthropic',
      )
    }

    if (!response.body) {
      throw new ProviderError('No response body', 0, 'anthropic', false)
    }

    // Parse SSE stream
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let toolCallIndex = 0
    let currentBlockType = ''
    const usage: {
      promptTokens: number
      completionTokens: number
      cacheCreationTokens?: number
      cacheReadTokens?: number
    } = { promptTokens: 0, completionTokens: 0 }

    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break

        buffer += decoder.decode(result.value, { stream: true })

        // Split on double newline (SSE event boundary)
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''

        for (const eventBlock of events) {
          const lines = eventBlock.split('\n')
          let eventType = ''
          let data = ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              data = line.slice(6)
            }
          }

          if (!data || data === '[DONE]') continue

          let parsed: AnthropicSSEEvent
          try {
            const raw: unknown = JSON.parse(data)
            if (!isAnthropicEvent(raw)) continue
            parsed = raw
          } catch {
            continue
          }

          switch (parsed.type ?? eventType) {
            case 'message_start':
              if (parsed.message?.usage) {
                usage.promptTokens = parsed.message.usage.input_tokens ?? 0
                if (parsed.message.usage.cache_creation_input_tokens !== undefined) {
                  usage.cacheCreationTokens = parsed.message.usage.cache_creation_input_tokens
                }
                if (parsed.message.usage.cache_read_input_tokens !== undefined) {
                  usage.cacheReadTokens = parsed.message.usage.cache_read_input_tokens
                }
              }
              break

            case 'content_block_start':
              currentBlockType = parsed.content_block?.type ?? ''
              if (currentBlockType === 'tool_use') {
                yield {
                  type: 'tool_call_start',
                  toolCall: {
                    index: toolCallIndex,
                    id: parsed.content_block?.id,
                    name: parsed.content_block?.name,
                  },
                }
              }
              break

            case 'content_block_delta': {
              const delta = parsed.delta
              if (delta?.type === 'text_delta' && delta.text) {
                yield { type: 'text', delta: delta.text }
              } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                yield { type: 'reasoning', delta: delta.thinking }
              } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                yield {
                  type: 'tool_call_delta',
                  delta: delta.partial_json,
                  toolCall: { index: toolCallIndex },
                }
              }
              break
            }

            case 'content_block_stop':
              if (currentBlockType === 'tool_use') {
                yield { type: 'tool_call_done', toolCall: { index: toolCallIndex } }
                toolCallIndex++
              }
              currentBlockType = ''
              break

            case 'message_delta':
              if (parsed.usage) {
                usage.completionTokens = parsed.usage.output_tokens ?? 0
                if (parsed.usage.cache_creation_input_tokens !== undefined) {
                  usage.cacheCreationTokens = parsed.usage.cache_creation_input_tokens
                }
                if (parsed.usage.cache_read_input_tokens !== undefined) {
                  usage.cacheReadTokens = parsed.usage.cache_read_input_tokens
                }
              }
              break

            case 'message_stop':
              break

            case 'ping':
              break

            case 'error': {
              const errMsg = parsed.error?.message ?? 'Stream error'
              const errType = parsed.error?.type
              // Anthropic sends 'overloaded_error' as an SSE error event on 529
              if (errType === 'overloaded_error' || errMsg.includes('overloaded')) {
                throw new ProviderError(`Anthropic 529: ${errMsg}`, 529, 'anthropic')
              }
              yield { type: 'error', error: errMsg }
              break
            }
          }
        }
      }
    } catch (err: unknown) {
      if (options?.signal?.aborted) return
      // Re-throw ProviderErrors so the loop's fallback chain can catch them
      if (err instanceof ProviderError) throw err
      const message = err instanceof Error ? err.message : String(err)
      console.error('[Anthropic] Stream error:', message)
      yield { type: 'error', error: message }
    } finally {
      reader.releaseLock()
    }

    yield { type: 'done', usage }
  }

  // -----------------------------------------------------------------------
  // chat — non-streaming convenience
  // -----------------------------------------------------------------------

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    let text = ''
    let reasoning = ''
    const toolCalls: ToolCall[] = []
    let currentToolArgs = ''
    let currentToolId = ''
    let currentToolName = ''
    let usage = { promptTokens: 0, completionTokens: 0 }

    for await (const chunk of this.chatStream(messages, options)) {
      switch (chunk.type) {
        case 'text':
          text += chunk.delta ?? ''
          break
        case 'reasoning':
          reasoning += chunk.delta ?? ''
          break
        case 'tool_call_start':
          currentToolId = chunk.toolCall?.id ?? ''
          currentToolName = chunk.toolCall?.name ?? ''
          currentToolArgs = ''
          break
        case 'tool_call_delta':
          currentToolArgs += chunk.delta ?? ''
          break
        case 'tool_call_done':
          if (currentToolName) {
            let args: Record<string, unknown>
            try {
              args = JSON.parse(currentToolArgs) as Record<string, unknown>
            } catch {
              args = { raw: currentToolArgs }
            }
            toolCalls.push({ id: currentToolId, name: currentToolName, arguments: args })
          }
          currentToolName = ''
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
      const headers = this.buildHeaders()
      const body: AnthropicRequestBody = {
        model: this.model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        // Explicitly omit thinking to avoid 400 on reasoning models for ping
      }
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      return res.ok || res.status === 429
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
  name: 'anthropic',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    const apiKey = (cfg.api_key as string | undefined) ?? ctx.env.ANTHROPIC_API_KEY ?? ''
    if (!apiKey) {
      ctx.logger.warn(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY or providers.anthropic.api_key',
      )
    }
    ctx.registerProvider(
      new AnthropicProvider({
        apiKey,
        model: cfg.model as string,
        maxTokens: cfg.max_tokens as number | undefined,
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
      }),
    )
  },
}
