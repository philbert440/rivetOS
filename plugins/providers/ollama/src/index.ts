/**
 * @rivetos/provider-ollama
 *
 * Native Ollama API provider. NOT OpenAI-compat — uses Ollama's own
 * /api/chat endpoint with streaming, plus model management APIs.
 *
 * For GERTY: can also point at llama-server via the OpenAI-compat
 * provider. This plugin is specifically for Ollama instances.
 *
 * Supports:
 * - Streaming chat with tool calling
 * - /think and /no_think prefix for Qwen thinking control
 * - Model management: list, show, pull, unload, switch
 * - Keep-alive control
 * - num_ctx (context window) configuration
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OllamaProviderConfig {
  baseUrl?: string // Default: 'http://localhost:11434'
  model?: string // Default: 'llama3.1'
  numCtx?: number // Context window size (0 = model default)
  temperature?: number // Default: 0.7
  topP?: number // Default: 0.9
  keepAlive?: string // Default: '30m'
}

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Ollama uses a separate images array for base64 image data */
  images?: string[]
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
}

interface OllamaFunctionTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

interface OllamaRequestBody {
  model: string
  messages: OllamaMessage[]
  stream: boolean
  keep_alive: string
  options: {
    temperature: number
    top_p: number
    num_ctx?: number
  }
  tools?: OllamaFunctionTool[]
}

interface OllamaStreamEvent {
  message?: {
    content?: string
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
  }
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
}

interface OllamaModelInfo {
  name: string
  size: number
  modified_at: string
}

interface OllamaModelListResponse {
  models?: OllamaModelInfo[]
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/** Extract text from string | ContentPart[] */
function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** Extract base64 image data from ContentPart[] */
function extractImages(content: string | ContentPart[]): string[] {
  if (typeof content === 'string') return []
  return content
    .filter(
      (p): p is ContentPart & { type: 'image'; data: string } => p.type === 'image' && !!p.data,
    )
    .map((p) => p.data)
}

function convertMessages(messages: Message[], thinking?: ThinkingLevel): OllamaMessage[] {
  return messages.map((msg, i) => {
    const textContent = extractText(msg.content)
    const ollama: OllamaMessage = { role: msg.role, content: textContent }

    // Add images if present
    const images = extractImages(msg.content)
    if (images.length > 0) {
      ollama.images = images
    }

    // For Qwen models: prepend /think or /no_think to the first user message
    if (msg.role === 'user' && i === messages.findIndex((m) => m.role === 'user')) {
      if (thinking === 'off') {
        ollama.content = `/no_think\n${ollama.content}`
      } else if (thinking) {
        ollama.content = `/think\n${ollama.content}`
      }
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      ollama.tool_calls = msg.toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: tc.arguments },
      }))
    }

    return ollama
  })
}

function convertTools(tools: ToolDefinition[]): OllamaFunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isOllamaEvent(value: unknown): value is OllamaStreamEvent {
  return typeof value === 'object' && value !== null
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OllamaProvider implements Provider {
  id = 'ollama'
  name = 'Ollama'
  private baseUrl: string
  private model: string
  private numCtx: number
  private temperature: number
  private topP: number
  private keepAlive: string

  constructor(config: OllamaProviderConfig = {}) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434'
    this.model = config.model ?? 'llama3.1'
    this.numCtx = config.numCtx ?? 0
    this.temperature = config.temperature ?? 0.7
    this.topP = config.topP ?? 0.9
    this.keepAlive = config.keepAlive ?? '30m'
  }

  // -----------------------------------------------------------------------
  // chatStream — Ollama's streaming /api/chat (NDJSON, not SSE)
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const model = options?.modelOverride ?? this.model
    const bodyOptions: OllamaRequestBody['options'] = {
      temperature: this.temperature,
      top_p: this.topP,
    }

    if (this.numCtx > 0) {
      bodyOptions.num_ctx = this.numCtx
    }

    const body: OllamaRequestBody = {
      model,
      messages: convertMessages(messages, options?.thinking),
      stream: true,
      keep_alive: this.keepAlive,
      options: bodyOptions,
    }

    if (options?.tools?.length) {
      body.tools = convertTools(options.tools)
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown')
      yield { type: 'error', error: `Ollama ${String(response.status)}: ${err}` }
      return
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' }
      return
    }

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const usage = { promptTokens: 0, completionTokens: 0 }
    let toolCallIndex = 0
    let inThinking = false

    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break

        buffer += decoder.decode(result.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue

          let event: OllamaStreamEvent
          try {
            const parsed: unknown = JSON.parse(line)
            if (!isOllamaEvent(parsed)) continue
            event = parsed
          } catch {
            continue
          }

          const msg = event.message

          // Text content
          if (msg?.content) {
            const text = msg.content

            // Detect Qwen <think> blocks
            if (text.includes('<think>')) {
              inThinking = true
              const before = text.split('<think>')[0]
              const after = text.split('<think>')[1] ?? ''
              if (before) yield { type: 'text', delta: before }
              if (after) yield { type: 'reasoning', delta: after }
              continue
            }
            if (text.includes('</think>')) {
              inThinking = false
              const before = text.split('</think>')[0]
              const after = text.split('</think>')[1] ?? ''
              if (before) yield { type: 'reasoning', delta: before }
              if (after) yield { type: 'text', delta: after }
              continue
            }

            if (inThinking) {
              yield { type: 'reasoning', delta: text }
            } else {
              yield { type: 'text', delta: text }
            }
          }

          // Tool calls — Ollama sends complete tool calls (not streamed)
          if (msg?.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
              yield {
                type: 'tool_call_start',
                toolCall: {
                  index: toolCallIndex,
                  id: `ollama-tc-${String(Date.now())}-${String(toolCallIndex)}`,
                  name: tc.function.name,
                },
              }
              yield {
                type: 'tool_call_delta',
                delta: JSON.stringify(tc.function.arguments),
                toolCall: { index: toolCallIndex },
              }
              yield {
                type: 'tool_call_done',
                toolCall: { index: toolCallIndex },
              }
              toolCallIndex++
            }
          }

          // Done event
          if (event.done) {
            if (event.prompt_eval_count) usage.promptTokens = event.prompt_eval_count
            if (event.eval_count) usage.completionTokens = event.eval_count
          }
        }
      }
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
    let currentArgs = ''
    let currentId = ''
    let currentName = ''
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
          currentId = chunk.toolCall?.id ?? ''
          currentName = chunk.toolCall?.name ?? ''
          currentArgs = ''
          break
        case 'tool_call_delta':
          currentArgs += chunk.delta ?? ''
          break
        case 'tool_call_done': {
          let args: Record<string, unknown>
          try {
            args = JSON.parse(currentArgs) as Record<string, unknown>
          } catch {
            args = { raw: currentArgs }
          }
          toolCalls.push({ id: currentId, name: currentName, arguments: args })
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
      const res = await fetch(`${this.baseUrl}/api/tags`)
      return res.ok
    } catch {
      return false
    }
  }

  // -----------------------------------------------------------------------
  // Ollama-specific: model management
  // -----------------------------------------------------------------------

  async listModels(): Promise<OllamaModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`)
    if (!res.ok) throw new Error(`Failed to list models: ${String(res.status)}`)
    const data = (await res.json()) as OllamaModelListResponse
    return data.models ?? []
  }

  async showModel(model?: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model ?? this.model }),
    })
    if (!res.ok) throw new Error(`Failed to show model: ${String(res.status)}`)
    return res.json()
  }

  async pullModel(model: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false }),
    })
    if (!res.ok) throw new Error(`Failed to pull: ${String(res.status)}`)
  }

  async unloadModel(model?: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model ?? this.model, messages: [], keep_alive: '0' }),
    })
  }

  switchModel(model: string): void {
    this.model = model
  }
}
