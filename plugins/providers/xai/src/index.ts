/**
 * @rivetos/provider-xai
 *
 * xAI Grok provider using the Responses API (/v1/responses).
 * - Stateful conversations via previous_response_id (server stores history, we only send new messages)
 * - Encrypted reasoning passthrough
 * - Native SSE streaming
 * - No reasoning_effort (grok-4 always reasons)
 * - store: true (server keeps conversation, massive token savings)
 * - 1-hour timeout for reasoning models
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
import { ProviderError } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Config
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
}

// ---------------------------------------------------------------------------
// API types — Responses API + Chat Completions fallback
// ---------------------------------------------------------------------------

interface OpenAIContentBlock {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ResponsesInput =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIContentBlock[] }
  | { role: 'assistant'; content: string; tool_calls?: OpenAIToolCall[] }
  | { type: 'function_call_output'; call_id: string; output: string }

interface OpenAIFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** SSE event shape from the Responses API */
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
      prompt_tokens?: number
      completion_tokens?: number
    }
  }
  /** Chat Completions fallback fields */
  choices?: ChatCompletionsChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface ChatCompletionsChoice {
  delta?: {
    content?: string
    reasoning_content?: string
    tool_calls?: ChatCompletionsToolCallDelta[]
  }
  finish_reason?: string
}

interface ChatCompletionsToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

// ---------------------------------------------------------------------------
// Message conversion (Responses API format)
// ---------------------------------------------------------------------------

/** Convert ContentPart[] to xAI/OpenAI multimodal content blocks */
function convertContentPartsToOpenAI(parts: ContentPart[]): OpenAIContentBlock[] {
  const blocks: OpenAIContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text })
    } else {
      // ImagePart
      if (part.data) {
        blocks.push({
          type: 'image_url',
          image_url: { url: `data:${part.mimeType ?? 'image/jpeg'};base64,${part.data}` },
        })
      } else if (part.url) {
        blocks.push({
          type: 'image_url',
          image_url: { url: part.url },
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
      const toolCallsList: OpenAIToolCall[] | undefined =
        msg.toolCalls && msg.toolCalls.length > 0
          ? msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments:
                  typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
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
      result.push({ role: 'user', content: convertContentPartsToOpenAI(msg.content) })
    } else {
      // system / plain user — pass through
      result.push({ role: msg.role, content: extractText(msg.content) || '' })
    }
  }

  return result
}

function convertTools(tools: ToolDefinition[]): OpenAIFunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
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
  /** Track response IDs for stateful conversation continuity */
  private lastResponseId: string | null = null

  constructor(config: XAIProviderConfig) {
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
  }

  // -----------------------------------------------------------------------
  // chatStream — SSE streaming via Responses API
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const allMessages = convertMessages(messages)
    const model = options?.modelOverride ?? this.model

    // If we have a previous response ID AND this isn't a fresh conversation,
    // only send NEW messages (last user + any tool results).
    // Server already has the full conversation history.
    // freshConversation is set by delegation/subagent engines to prevent
    // conversation state bleed from the shared provider instance.
    const usePreviousResponse = this.store && this.lastResponseId && !options?.freshConversation
    let input: ResponsesInput[]
    if (usePreviousResponse) {
      // Find the last user message and any tool results after it
      const lastUserIdx = allMessages.findLastIndex((m) => 'role' in m && m.role === 'user')
      input = lastUserIdx >= 0 ? allMessages.slice(lastUserIdx) : allMessages
    } else {
      input = allMessages
    }

    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
      store: this.store,
      include: ['reasoning.encrypted_content'],
    }

    // Continue from previous response if available (and not a fresh conversation)
    if (usePreviousResponse) {
      body.previous_response_id = this.lastResponseId
    }

    if (this.temperature !== undefined) {
      body.temperature = this.temperature
    }

    if (options?.tools?.length) {
      // Filter out function-based web_search — we use xAI's native web_search instead
      const filteredTools = options.tools.filter((t) => t.name !== 'web_search')
      body.tools = [
        // xAI native web search — handled server-side
        { type: 'web_search' },
        ...convertTools(filteredTools),
      ]
    }

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
    const usage = { promptTokens: 0, completionTokens: 0 }

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

          // Responses API streaming: events have a `type` field
          // Handle both Responses API event format and Chat Completions delta format
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
              }
            }
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
              }
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
            yield { type: 'tool_call_done', toolCall: { index: targetIdx } }
          } else if (event.type === 'response.output_text.delta') {
            if (event.delta) {
              yield { type: 'text', delta: event.delta }
            }
          } else if (event.type === 'response.reasoning.delta') {
            if (event.delta) {
              yield { type: 'reasoning', delta: event.delta }
            }
          } else if (event.type === 'response.completed' || event.type === 'response.done') {
            // Extract usage + response ID for stateful conversation
            const resp = event.response
            if (resp?.id) {
              this.lastResponseId = resp.id
            }
            if (resp?.usage) {
              usage.promptTokens = resp.usage.input_tokens ?? resp.usage.prompt_tokens ?? 0
              usage.completionTokens = resp.usage.output_tokens ?? resp.usage.completion_tokens ?? 0
            }
          } else if (event.type === 'response.created') {
            // Also capture ID from response.created event
            if (event.response?.id) {
              this.lastResponseId = event.response.id
            }
          }

          // Fallback: Chat Completions delta format (in case xAI sends it)
          const choice = event.choices?.[0]
          if (choice) {
            const delta = choice.delta
            if (delta?.content) {
              yield { type: 'text', delta: delta.content }
            }
            if (delta?.reasoning_content) {
              yield { type: 'reasoning', delta: delta.reasoning_content }
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  yield {
                    type: 'tool_call_start',
                    toolCall: { index: tc.index, id: tc.id, name: tc.function.name },
                  }
                }
                if (tc.function?.arguments) {
                  yield {
                    type: 'tool_call_delta',
                    delta: tc.function.arguments,
                    toolCall: { index: tc.index },
                  }
                }
              }
            }
            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  yield { type: 'tool_call_done', toolCall: { index: tc.index } }
                }
              }
            }
          }

          // Usage from Chat Completions format
          if (event.usage) {
            usage.promptTokens = event.usage.prompt_tokens ?? 0
            usage.completionTokens = event.usage.completion_tokens ?? 0
          }
        }
      }
    } finally {
      clearTimeout(timeout)
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
    const pendingArgs: Map<number, { id: string; name: string; args: string }> = new Map()
    let usage = { promptTokens: 0, completionTokens: 0 }

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
