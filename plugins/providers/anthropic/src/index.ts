/**
 * @rivetos/provider-anthropic
 *
 * Anthropic Claude provider.
 * - API key mode (sk-ant-api03-): uses raw fetch
 * - OAuth mode (sk-ant-oat01-): uses raw fetch (SDK doesn't handle OAuth correctly)
 *
 * The raw fetch approach matches the exact curl command proven to work.
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
} from '@rivetos/types'
import { TokenManager, detectAuthMode } from './oauth.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  apiKey: string
  model?: string
  maxTokens?: number
  baseUrl?: string
  tokenPath?: string
}

// ---------------------------------------------------------------------------
// Thinking budgets
// ---------------------------------------------------------------------------

const THINKING_BUDGETS: Record<ThinkingLevel, number | null> = {
  off: null,
  low: 2000,
  medium: 10000,
  high: 50000,
}

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
  thinking?: { type: 'enabled'; budget_tokens: number }
}

/** SSE event from Anthropic's streaming API */
interface AnthropicSSEEvent {
  type?: string
  message?: {
    usage?: { input_tokens?: number; output_tokens?: number }
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
  usage?: { output_tokens?: number }
  error?: { message?: string }
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

  return { system, converted }
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
  private authMode: 'api_key' | 'oauth'
  private tokenManager: TokenManager | null = null
  private initialized = false

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey
    this.model = config.model ?? 'claude-opus-4-6'
    this.maxTokens = config.maxTokens ?? 8192
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com'
    this.authMode = detectAuthMode(config.apiKey)

    if (this.authMode === 'oauth') {
      this.tokenManager = new TokenManager(config.tokenPath)
      this.name = 'Anthropic Claude (OAuth)'
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    if (this.tokenManager) {
      await this.tokenManager.initialize(this.apiKey)
    }
    this.initialized = true
  }

  private async getKey(): Promise<string> {
    await this.ensureInitialized()
    if (this.tokenManager) {
      return this.tokenManager.getAccessToken()
    }
    return this.apiKey
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const key = await this.getKey()

    if (this.authMode === 'oauth') {
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': 'claude-cli/1.0.17',
        'x-app': 'cli',
      }
    }

    return {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }
  }

  // -----------------------------------------------------------------------
  // chatStream — raw fetch with SSE parsing (works for both auth modes)
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const { system, converted } = convertMessages(messages)
    const headers = await this.buildHeaders()
    const model = options?.modelOverride ?? this.model

    const body: AnthropicRequestBody = {
      model,
      max_tokens: this.maxTokens,
      messages: converted,
      stream: true,
    }

    // System prompt — with ephemeral caching for token savings (~90% cheaper on cache hits)
    if (this.authMode === 'oauth') {
      const blocks: AnthropicContentBlock[] = [
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: 'ephemeral' },
        },
      ]
      if (system) blocks.push({ type: 'text', text: system, cache_control: { type: 'ephemeral' } })
      body.system = blocks
    } else if (system) {
      body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    }

    if (options?.tools?.length) {
      body.tools = convertTools(options.tools)
    }

    const thinking = options?.thinking ?? 'off'
    const budget = THINKING_BUDGETS[thinking]
    if (budget !== null) {
      // max_tokens must be > budget_tokens — always ensure full response space
      body.max_tokens = budget + this.maxTokens
      body.thinking = { type: 'enabled', budget_tokens: budget }
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown')
      console.error(`[Anthropic] API error ${String(response.status)}: ${err.slice(0, 500)}`)
      yield { type: 'error', error: `Anthropic ${String(response.status)}: ${err.slice(0, 200)}` }
      return
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' }
      return
    }

    // Parse SSE stream
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let toolCallIndex = 0
    let currentBlockType = ''
    const usage = { promptTokens: 0, completionTokens: 0 }

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
              }
              break

            case 'message_stop':
              break

            case 'ping':
              break

            case 'error':
              yield { type: 'error', error: parsed.error?.message ?? 'Stream error' }
              break
          }
        }
      }
    } catch (err: unknown) {
      if (options?.signal?.aborted) return
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
      const headers = await this.buildHeaders()
      const body: AnthropicRequestBody = {
        model: this.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      }
      if (this.authMode === 'oauth') {
        body.system = [
          {
            type: 'text',
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
          },
        ]
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

// OAuth utilities
export { loadTokens, saveTokens, detectAuthMode, generateAuthUrl, exchangeCode } from './oauth.js'
export type { OAuthTokens, AuthMode } from './oauth.js'
