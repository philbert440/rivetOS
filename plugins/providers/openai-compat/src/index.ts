/**
 * @rivetos/provider-openai-compat
 *
 * Generic OpenAI-compatible provider. Works with any endpoint that
 * speaks the OpenAI Chat Completions API:
 *
 * - llama-server (GERTY, Rivet Local)
 * - vLLM
 * - LM Studio
 * - OpenRouter
 * - Together AI
 * - Fireworks
 * - text-generation-webui
 * - LocalAI
 *
 * Streaming via SSE. Optional auth. Lenient JSON parsing for
 * llama-server's occasional malformed tool call arguments.
 * Configurable stream timeouts to prevent hanging on stalled models.
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

export interface OpenAICompatProviderConfig {
  baseUrl: string // e.g., 'http://192.168.1.50:8000/v1'
  apiKey?: string // Optional — local servers often need none
  model?: string // Default: 'default'
  maxTokens?: number // Default: 4096 (set higher for local — tokens are free)
  temperature?: number // Default: 0.6 (lower = more precise for local)
  topP?: number // Default: 0.9 (tighter = less noise)
  /** Number of context tokens (llama-server num_ctx) */
  numCtx?: number
  /** Custom provider ID (default: 'openai-compat') */
  id?: string
  /** Custom display name (default: 'OpenAI Compatible') */
  name?: string
  /** Max ms to wait for the first SSE chunk (default: 120000 = 2 min) */
  firstChunkTimeoutMs?: number
  /** Max ms to wait between subsequent SSE chunks (default: 30000 = 30s) */
  chunkTimeoutMs?: number
  /** Repetition penalty for llama-server (default: undefined — not sent) */
  repeatPenalty?: number
  /** Context window size in tokens (0 = unknown) */
  contextWindow?: number
  /** Max output tokens (0 = unknown) */
  maxOutputTokens?: number
}

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface OpenAIContentBlock {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentBlock[] | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface OAIFunctionTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

interface OAIRequestBody {
  model: string
  max_tokens: number
  temperature: number
  top_p: number
  messages: OAIMessage[]
  stream: boolean
  tools?: OAIFunctionTool[]
  repeat_penalty?: number
}

interface ChatCompletionsToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface ChatCompletionsChoice {
  delta?: {
    content?: string
    reasoning_content?: string
    tool_calls?: ChatCompletionsToolCallDelta[]
  }
  finish_reason?: string
}

interface ChatCompletionsEvent {
  choices?: ChatCompletionsChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

class ReadTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Timed out after ${seconds}s`)
    this.name = 'ReadTimeoutError'
  }
}

/** Result of ReadableStreamDefaultReader.read() — inlined to avoid DOM lib dependency */
type StreamReadResult<T> = { done: false; value: T } | { done: true; value: T | undefined }

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<StreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReadTimeoutError(timeoutMs / 1000)), timeoutMs)
    reader.read().then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
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

/** Convert ContentPart[] to OpenAI multimodal content blocks */
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

function convertMessages(messages: Message[]): OAIMessage[] {
  return messages.map((msg) => {
    // Handle multimodal user messages
    if (msg.role === 'user' && typeof msg.content !== 'string' && Array.isArray(msg.content)) {
      const oai: OAIMessage = { role: 'user', content: convertContentPartsToOpenAI(msg.content) }
      return oai
    }

    // Handle multimodal tool results — most local servers only support text in tool results
    if (msg.role === 'tool' && typeof msg.content !== 'string' && Array.isArray(msg.content)) {
      let textContent = extractText(msg.content)
      const imageCount = msg.content.filter((p) => p.type === 'image').length
      if (imageCount > 0) {
        textContent += `\n[${imageCount} image(s) returned — saved to disk]`
      }
      const oai: OAIMessage = { role: 'tool', content: textContent || null }
      if (msg.toolCallId) oai.tool_call_id = msg.toolCallId
      return oai
    }

    const textContent = extractText(msg.content)
    const oai: OAIMessage = { role: msg.role, content: textContent || null }
    if (msg.toolCalls?.length) {
      oai.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }))
    }
    if (msg.toolCallId) oai.tool_call_id = msg.toolCallId
    return oai
  })
}

function convertTools(tools: ToolDefinition[]): OAIFunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isChatCompletionsEvent(value: unknown): value is ChatCompletionsEvent {
  return typeof value === 'object' && value !== null
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OpenAICompatProvider implements Provider {
  id: string
  name: string
  private baseUrl: string
  private apiKey: string
  private model: string
  private maxTokens: number
  private temperature: number
  private topP: number
  private firstChunkTimeoutMs: number
  private chunkTimeoutMs: number
  private repeatPenalty: number | undefined
  private contextWindowSize: number
  private outputTokenLimit: number

  constructor(config: OpenAICompatProviderConfig) {
    this.id = config.id ?? 'openai-compat'
    this.name = config.name ?? 'OpenAI Compatible'
    this.baseUrl = config.baseUrl
    this.apiKey = config.apiKey ?? ''
    this.model = config.model ?? 'default'
    this.maxTokens = config.maxTokens ?? 4096
    this.temperature = config.temperature ?? 0.6
    this.topP = config.topP ?? 0.9
    this.firstChunkTimeoutMs = config.firstChunkTimeoutMs ?? 120_000
    this.chunkTimeoutMs = config.chunkTimeoutMs ?? 30_000
    this.repeatPenalty = config.repeatPenalty
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

  // -----------------------------------------------------------------------
  // chatStream
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const model = options?.modelOverride ?? this.model
    const body: OAIRequestBody = {
      model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      top_p: this.topP,
      messages: convertMessages(messages),
      stream: true,
    }

    if (options?.tools?.length) {
      body.tools = convertTools(options.tools)
    }

    // llama-server specific tuning
    if (this.repeatPenalty !== undefined) {
      body.repeat_penalty = this.repeatPenalty
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown')
      throw new ProviderError(
        `${this.name} ${String(response.status)}: ${err.slice(0, 500)}`,
        response.status,
        this.id,
      )
    }

    if (!response.body) {
      throw new ProviderError('No response body', 0, this.id, false)
    }

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const usage = { promptTokens: 0, completionTokens: 0 }
    let inThinking = false
    let isFirstChunk = true
    const startedToolCallIndices = new Set<number>()

    try {
      for (;;) {
        // Apply timeout: longer for first chunk (model may be thinking),
        // shorter between subsequent chunks (stream should be flowing)
        const timeoutMs = isFirstChunk ? this.firstChunkTimeoutMs : this.chunkTimeoutMs
        let readResult: StreamReadResult<Uint8Array>

        try {
          readResult = await readWithTimeout(reader, timeoutMs)
        } catch (err: unknown) {
          if (err instanceof ReadTimeoutError) {
            const phase = isFirstChunk ? 'first response' : 'next chunk'
            yield {
              type: 'error',
              error: `Provider timed out waiting for ${phase} (${String(timeoutMs / 1000)}s). The model may be overloaded or the context too large.`,
            }
            try {
              void reader.cancel()
            } catch {
              // intentionally empty
            }
            return
          }
          throw err // Re-throw non-timeout errors (abort, network, etc.)
        }

        if (readResult.done) break

        isFirstChunk = false
        buffer += decoder.decode(readResult.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue

          let event: ChatCompletionsEvent
          try {
            const parsed: unknown = JSON.parse(data)
            if (!isChatCompletionsEvent(parsed)) continue
            event = parsed
          } catch {
            continue
          }

          const choice = event.choices?.[0]
          if (!choice) continue

          const delta = choice.delta
          if (!delta) continue

          // Native reasoning_content field (llama-server, OpenAI o-series)
          if (delta.reasoning_content) {
            yield { type: 'reasoning', delta: delta.reasoning_content }
          }
          // Text content — detect <think> blocks (Qwen via llama-server)
          if (delta.content) {
            const text = delta.content

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

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.name) {
                startedToolCallIndices.add(tc.index)
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
            // Emit tool_call_done for ALL started tool calls.
            // Some providers (llama-server + Gemma) send an empty delta
            // on the final chunk, so we can't rely on delta.tool_calls here.
            for (const idx of startedToolCallIndices) {
              yield { type: 'tool_call_done', toolCall: { index: idx } }
            }
            startedToolCallIndices.clear()
          }

          if (event.usage) {
            usage.promptTokens = event.usage.prompt_tokens ?? 0
            usage.completionTokens = event.usage.completion_tokens ?? 0
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
              // llama-server sometimes returns malformed JSON — best effort
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

    // Safety net: flush any pending tool calls that never got a tool_call_done event.
    // This can happen if a provider sends tool_calls without a proper finish_reason.
    for (const [, pending] of pendingArgs) {
      let args: Record<string, unknown>
      try {
        args = JSON.parse(pending.args) as Record<string, unknown>
      } catch {
        args = { raw: pending.args }
      }
      toolCalls.push({ id: pending.id, name: pending.name, arguments: args })
    }
    pendingArgs.clear()

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
      const headers: Record<string, string> = {}
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
      const res = await fetch(`${this.baseUrl}/models`, { headers })
      return res.ok
    } catch {
      return false
    }
  }
}
