/**
 * @rivetos/provider-openai-compat
 *
 * OpenAI-compatible chat-completions provider tuned for strict servers.
 *
 * Target servers:
 *   - vLLM (`--enable-auto-tool-choice`, `--reasoning-parser`)
 *   - Text Generation Inference (TGI)
 *   - LocalAI, Together, Fireworks, Groq, or any other OpenAI-compatible API
 *
 * Key differences vs. `@rivetos/provider-llama-server`:
 *   1. **Strict message ordering** — any `system` message that arrives after a
 *      non-system message is folded into a `user` message with a
 *      `[SYSTEM NOTICE]` prefix. vLLM + Qwen/Llama chat templates reject
 *      mid-conversation system messages ("System message must be at the
 *      beginning."); RivetOS legitimately injects them for context-window
 *      warnings, steer events, and turn-timeout notices.
 *   2. **Native reasoning field first** — consumes vLLM's native reasoning
 *      delta when a `--reasoning-parser` is configured server-side. Accepts
 *      both the spec-standard `reasoning_content` and the newer `reasoning`
 *      field name (vLLM >= 0.0.3.dev10 / commit c1dce8324 renamed it), instead
 *      of regex-stripping `<think>` tags from content. Still falls back to
 *      `<think>` parsing if the server emits reasoning inline.
 *   3. **OpenAI sampling + vLLM extensions** — standard OpenAI knobs
 *      (`temperature`, `top_p`, `presence_penalty`, `frequency_penalty`,
 *      `seed`) plus `top_k` / `min_p`, which vLLM accepts and the Qwen3.6
 *      reference config explicitly recommends. They are only sent when the
 *      caller sets them, so strict OpenAI/Groq servers still see a clean
 *      request body. True llama-only knobs (`typical_p`, `mirostat`,
 *      `repeat_penalty`, `repeat_last_n`) remain excluded — those 400 on
 *      vLLM and friends.
 *   4. **Tool choice passthrough** — `tool_choice` (auto | none | required |
 *      {type, function}) is forwarded when tools are present.
 *   5. **Startup model probe** — `isAvailable()` hits `/v1/models` and (when
 *      possible) verifies the configured model id is actually served.
 *   6. **Forgiving baseUrl** — accepts either `http://host:port` or
 *      `http://host:port/v1`.
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
import { ProviderError, MODEL_DEFAULTS } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

export interface OpenAICompatProviderConfig {
  /** Base URL of the OpenAI-compatible server, e.g. 'http://localhost:8000'.
   *  The trailing '/v1' is optional — it is normalized away and re-appended. */
  baseUrl: string
  /** Bearer token. Send a placeholder like 'sk-no-key-required' for servers
   *  that do not enforce auth. If unset, no Authorization header is sent. */
  apiKey?: string
  /** Model id as exposed by `/v1/models`. Default: 'default'. */
  model?: string
  /** Max tokens to generate. Default: 4096 */
  maxTokens?: number
  /** Temperature (0.0–2.0). Default: 0.7 */
  temperature?: number
  /** top-p nucleus sampling. Default: 0.95 */
  topP?: number
  /** top-k sampling. vLLM extension — only sent when defined.
   *  Default: undefined (server default). */
  topK?: number
  /** min-p sampling. vLLM extension — only sent when defined.
   *  Default: undefined (server default). */
  minP?: number
  /** Presence penalty (-2.0–2.0). Default: undefined */
  presencePenalty?: number
  /** Frequency penalty (-2.0–2.0). Default: undefined */
  frequencyPenalty?: number
  /** RNG seed. Default: undefined (random) */
  seed?: number
  /** Default tool_choice when tools are provided. Default: 'auto' */
  defaultToolChoice?: ToolChoice
  /** Custom provider id. Default: 'openai-compat' */
  id?: string
  /** Custom display name. Default: 'OpenAI-compatible server' */
  name?: string
  /** Max ms to wait for first SSE chunk. Default: 120000 */
  firstChunkTimeoutMs?: number
  /** Max ms to wait between SSE chunks. Default: 30000 */
  chunkTimeoutMs?: number
  /** Context window size (informational, used for runtime budgeting). */
  contextWindow?: number
  /** Max output tokens (informational). */
  maxOutputTokens?: number
  /** If true, probe /v1/models in isAvailable() and reject when the
   *  configured model id is not listed. Default: false — strict servers
   *  sometimes do not list all aliases. */
  verifyModelOnInit?: boolean
}

// ---------------------------------------------------------------------------
// Request/response types
// ---------------------------------------------------------------------------

interface OAIContentBlock {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OAIContentBlock[] | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
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
  stream_options?: { include_usage: boolean }
  tools?: OAIFunctionTool[]
  tool_choice?: ToolChoice
  presence_penalty?: number
  frequency_penalty?: number
  seed?: number
  top_k?: number
  min_p?: number
}

interface OAIToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OAIStreamChoice {
  delta?: {
    content?: string
    reasoning_content?: string
    // Some vLLM builds (>= 0.0.3.dev10 / c1dce8324) emit reasoning under the
    // shorter key `reasoning` instead of `reasoning_content`. Accept both.
    reasoning?: string
    tool_calls?: OAIToolCallDelta[]
  }
  finish_reason?: string
}

interface OAIStreamEvent {
  choices?: OAIStreamChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface OAIModelsResponse {
  data?: Array<{ id?: string }>
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

class ReadTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Timed out after ${String(seconds)}s`)
    this.name = 'ReadTimeoutError'
  }
}

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

function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function convertContentParts(parts: ContentPart[]): OAIContentBlock[] {
  const blocks: OAIContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text })
    } else {
      if (part.data) {
        blocks.push({
          type: 'image_url',
          image_url: { url: `data:${part.mimeType ?? 'image/jpeg'};base64,${part.data}` },
        })
      } else if (part.url) {
        blocks.push({ type: 'image_url', image_url: { url: part.url } })
      }
    }
  }
  return blocks
}

/**
 * Convert RivetOS messages to OpenAI-compat wire format, enforcing strict
 * message ordering:
 *
 * - The first contiguous run of `role: 'system'` messages at the head of the
 *   conversation is passed through as-is.
 * - Any `role: 'system'` that appears AFTER a non-system message is folded
 *   into a `role: 'user'` message with a `[SYSTEM NOTICE]` prefix. The text
 *   still reaches the model; the chat template is happy.
 *
 * vLLM + Qwen/Llama chat templates reject mid-conversation system messages
 * with "System message must be at the beginning." RivetOS legitimately
 * injects mid-conversation system messages (context-window warnings, steer
 * events, turn-timeout notices); this shim bridges the gap.
 */
function convertMessages(messages: Message[]): OAIMessage[] {
  const out: OAIMessage[] = []
  let seenNonSystem = false

  for (const msg of messages) {
    // Multimodal user
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      seenNonSystem = true
      out.push({ role: 'user', content: convertContentParts(msg.content) })
      continue
    }

    // Tool results — strings only
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      seenNonSystem = true
      let text = extractText(msg.content)
      const imgCount = msg.content.filter((p) => p.type === 'image').length
      if (imgCount > 0) text += `\n[${String(imgCount)} image(s) returned — saved to disk]`
      const toolMsg: OAIMessage = { role: 'tool', content: text || null }
      if (msg.toolCallId) toolMsg.tool_call_id = msg.toolCallId
      out.push(toolMsg)
      continue
    }

    const text = extractText(msg.content)

    if (msg.role === 'system') {
      if (!seenNonSystem) {
        // Head-of-conversation system message — pass through, merging with
        // any immediately-preceding system message so strict templates
        // (vLLM) that require exactly one head system block don't reject.
        const prev = out[out.length - 1]
        if (prev && prev.role === 'system') {
          const prevText = typeof prev.content === 'string' ? prev.content : ''
          prev.content = prevText && text ? `${prevText}\n\n${text}` : prevText || text || null
        } else {
          out.push({ role: 'system', content: text || null })
        }
      } else {
        // Mid-conversation system message — fold into a user message so
        // strict chat templates don't reject the request.
        out.push({
          role: 'user',
          content: text ? `[SYSTEM NOTICE]\n${text}` : '[SYSTEM NOTICE]\n(empty system message)',
        })
      }
      continue
    }

    // assistant, user (string), tool (string)
    seenNonSystem = true
    const converted: OAIMessage = { role: msg.role, content: text || null }
    if (msg.toolCalls?.length) {
      converted.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }))
    }
    if (msg.toolCallId) converted.tool_call_id = msg.toolCallId
    out.push(converted)
  }

  return out
}

function convertTools(tools: ToolDefinition[]): OAIFunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

function isStreamEvent(value: unknown): value is OAIStreamEvent {
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
  private topK: number | undefined
  private minP: number | undefined
  private presencePenalty: number | undefined
  private frequencyPenalty: number | undefined
  private seed: number | undefined
  private defaultToolChoice: ToolChoice
  private firstChunkTimeoutMs: number
  private chunkTimeoutMs: number
  private contextWindowSize: number
  private outputTokenLimit: number
  private verifyModelOnInit: boolean

  constructor(config: OpenAICompatProviderConfig) {
    this.id = config.id ?? 'openai-compat'
    this.name = config.name ?? 'OpenAI-compatible server'

    // Normalize baseUrl — accept either 'http://host:port' or
    // 'http://host:port/v1'. We always append '/v1/...' later.
    let base = config.baseUrl.replace(/\/+$/, '')
    if (base.endsWith('/v1')) base = base.slice(0, -3)
    this.baseUrl = base

    this.apiKey = config.apiKey ?? ''
    this.model = config.model ?? MODEL_DEFAULTS['openai-compat']
    this.maxTokens = config.maxTokens ?? 4096
    this.temperature = config.temperature ?? 0.7
    this.topP = config.topP ?? 0.95
    this.topK = config.topK
    this.minP = config.minP
    this.presencePenalty = config.presencePenalty
    this.frequencyPenalty = config.frequencyPenalty
    this.seed = config.seed
    this.defaultToolChoice = config.defaultToolChoice ?? 'auto'
    this.firstChunkTimeoutMs = config.firstChunkTimeoutMs ?? 120_000
    this.chunkTimeoutMs = config.chunkTimeoutMs ?? 30_000
    this.contextWindowSize = config.contextWindow ?? 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0
    this.verifyModelOnInit = config.verifyModelOnInit ?? false
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

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    return headers
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
      stream_options: { include_usage: true },
    }

    if (options?.tools?.length) {
      body.tools = convertTools(options.tools)
      body.tool_choice = this.defaultToolChoice
    }

    if (this.presencePenalty !== undefined) body.presence_penalty = this.presencePenalty
    if (this.frequencyPenalty !== undefined) body.frequency_penalty = this.frequencyPenalty
    if (this.seed !== undefined) body.seed = this.seed
    if (this.topK !== undefined) body.top_k = this.topK
    if (this.minP !== undefined) body.min_p = this.minP

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
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
        const timeoutMs = isFirstChunk ? this.firstChunkTimeoutMs : this.chunkTimeoutMs
        let readResult: StreamReadResult<Uint8Array>

        try {
          readResult = await readWithTimeout(reader, timeoutMs)
        } catch (err: unknown) {
          if (err instanceof ReadTimeoutError) {
            const phase = isFirstChunk ? 'first response' : 'next chunk'
            yield {
              type: 'error',
              error: `${this.name} timed out waiting for ${phase} (${String(timeoutMs / 1000)}s). The model may be overloaded or the context too large.`,
            }
            try {
              void reader.cancel()
            } catch {
              // intentionally empty
            }
            return
          }
          throw err
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

          let event: OAIStreamEvent
          try {
            const parsed: unknown = JSON.parse(data)
            if (!isStreamEvent(parsed)) continue
            event = parsed
          } catch {
            continue
          }

          const choice = event.choices?.[0]

          if (choice) {
            const delta = choice.delta
            if (delta) {
              // Native reasoning field (vLLM --reasoning-parser).
              // Accept both `reasoning_content` (vLLM <= 0.0.3.dev9, spec)
              // and `reasoning` (vLLM >= 0.0.3.dev10 / c1dce8324 renamed it).
              const reasoningDelta = delta.reasoning_content ?? delta.reasoning
              if (reasoningDelta) {
                yield { type: 'reasoning', delta: reasoningDelta }
              }
              // Text content — parse inline <think> blocks as fallback for
              // servers that emit reasoning inside content
              if (delta.content) {
                const text = delta.content

                if (text.includes('<think>')) {
                  inThinking = true
                  const before = text.split('<think>')[0]
                  const after = text.split('<think>')[1] ?? ''
                  if (before) yield { type: 'text', delta: before }
                  if (after) yield { type: 'reasoning', delta: after }
                } else if (text.includes('</think>')) {
                  inThinking = false
                  const before = text.split('</think>')[0]
                  const after = text.split('</think>')[1] ?? ''
                  if (before) yield { type: 'reasoning', delta: before }
                  if (after) yield { type: 'text', delta: after }
                } else if (inThinking) {
                  yield { type: 'reasoning', delta: text }
                } else {
                  yield { type: 'text', delta: text }
                }
              }

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
            }

            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
              for (const idx of startedToolCallIndices) {
                yield { type: 'tool_call_done', toolCall: { index: idx } }
              }
              startedToolCallIndices.clear()
            }
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
    const pendingArgs = new Map<number, { id: string; name: string; args: string }>()
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
  // isAvailable — GET /v1/models, optionally verify configured model id
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { headers: this.authHeaders() })
      if (!res.ok) return false

      if (!this.verifyModelOnInit) return true

      const body = (await res.json()) as OAIModelsResponse
      const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id)
      return ids.includes(this.model)
    } catch {
      return false
    }
  }
}
