/**
 * @rivetos/provider-llama-server
 *
 * Native llama.cpp server (llama-server) provider.
 *
 * Speaks llama-server's chat-completions endpoint (`POST /v1/chat/completions`)
 * with llama-native sampling knobs and reasoning semantics. Not a generic
 * OpenAI-compat shim — this is built for one server.
 *
 * Features:
 * - Streaming SSE with `<think>` block parsing and native `reasoning_content`
 *   (llama-server's `--reasoning-format deepseek`)
 * - Tool/function calling with lenient JSON parsing for malformed args
 * - Configurable stream timeouts to prevent hanging on stalled models
 * - Full llama-native sampling: top_k, min_p, typical_p, repeat_penalty, etc.
 * - Optional API key (llama-server `--api-key`)
 *
 * Docs: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
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
  PluginManifest,
} from '@rivetos/types'
import { ProviderError, MODEL_DEFAULTS } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LlamaServerProviderConfig {
  /** Base URL of the llama-server, e.g. 'http://localhost:8080' */
  baseUrl: string
  /** Optional API key (llama-server `--api-key`). If unset, no Authorization header is sent. */
  apiKey?: string
  /** Model alias (llama-server `--alias`). Default: 'default' */
  model?: string
  /** Max tokens to generate (`max_tokens` / `n_predict`). Default: 4096 */
  maxTokens?: number
  /** Temperature (0.0–2.0). Default: 0.8 (llama-server default) */
  temperature?: number
  /** top-p nucleus sampling. Default: 0.95 (llama-server default) */
  topP?: number
  /** top-k sampling. Default: undefined (not sent; server default = 40) */
  topK?: number
  /** min-p sampling. Default: undefined (not sent; server default = 0.05) */
  minP?: number
  /** Locally typical sampling p. Default: undefined (not sent) */
  typicalP?: number
  /** Repetition penalty. Default: undefined (not sent; server default = 1.0) */
  repeatPenalty?: number
  /** Number of tokens to penalize for repetition. Default: undefined (not sent) */
  repeatLastN?: number
  /** Presence penalty. Default: undefined (not sent) */
  presencePenalty?: number
  /** Frequency penalty. Default: undefined (not sent) */
  frequencyPenalty?: number
  /** Mirostat mode: 0=off, 1=v1, 2=v2. Default: undefined (not sent) */
  mirostat?: 0 | 1 | 2
  /** Mirostat tau (target entropy). Default: undefined */
  mirostatTau?: number
  /** Mirostat eta (learning rate). Default: undefined */
  mirostatEta?: number
  /** RNG seed (-1 = random). Default: undefined */
  seed?: number
  /** Custom provider ID. Default: 'llama-server' */
  id?: string
  /** Custom display name. Default: 'llama.cpp server' */
  name?: string
  /** Max ms to wait for first SSE chunk. Default: 120000 (2 min) */
  firstChunkTimeoutMs?: number
  /** Max ms to wait between chunks. Default: 30000 (30s) */
  chunkTimeoutMs?: number
  /** Context window size (informational, for runtime budgeting). Default: 0 = unknown */
  contextWindow?: number
  /** Max output tokens (informational). Default: 0 = unknown */
  maxOutputTokens?: number
}

// ---------------------------------------------------------------------------
// Request/response types (chat-completions shape used by llama-server)
// ---------------------------------------------------------------------------

interface LlamaContentBlock {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

interface LlamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LlamaContentBlock[] | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface LlamaFunctionTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

interface LlamaRequestBody {
  model: string
  max_tokens: number
  temperature: number
  top_p: number
  messages: LlamaMessage[]
  stream: boolean
  tools?: LlamaFunctionTool[]
  // llama-native sampling knobs (all optional)
  top_k?: number
  min_p?: number
  typical_p?: number
  repeat_penalty?: number
  repeat_last_n?: number
  presence_penalty?: number
  frequency_penalty?: number
  mirostat?: number
  mirostat_tau?: number
  mirostat_eta?: number
  seed?: number
  // llama-server always emits reasoning_content when using deepseek reasoning format
}

interface LlamaToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface LlamaStreamChoice {
  delta?: {
    content?: string
    reasoning_content?: string
    tool_calls?: LlamaToolCallDelta[]
  }
  finish_reason?: string
}

interface LlamaStreamEvent {
  choices?: LlamaStreamChoice[]
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

function convertContentParts(parts: ContentPart[]): LlamaContentBlock[] {
  const blocks: LlamaContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text })
    } else {
      // ImagePart — llama-server mmproj via image_url
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

function convertMessages(messages: Message[]): LlamaMessage[] {
  return messages.map((msg) => {
    // Multimodal user messages
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return { role: 'user', content: convertContentParts(msg.content) }
    }

    // Tool results — llama-server expects string content for tool role
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      let text = extractText(msg.content)
      const imgCount = msg.content.filter((p) => p.type === 'image').length
      if (imgCount > 0) text += `\n[${String(imgCount)} image(s) returned — saved to disk]`
      const out: LlamaMessage = { role: 'tool', content: text || null }
      if (msg.toolCallId) out.tool_call_id = msg.toolCallId
      return out
    }

    const text = extractText(msg.content)
    const out: LlamaMessage = { role: msg.role, content: text || null }
    if (msg.toolCalls?.length) {
      out.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }))
    }
    if (msg.toolCallId) out.tool_call_id = msg.toolCallId
    return out
  })
}

function convertTools(tools: ToolDefinition[]): LlamaFunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

function isStreamEvent(value: unknown): value is LlamaStreamEvent {
  return typeof value === 'object' && value !== null
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class LlamaServerProvider implements Provider {
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
  private typicalP: number | undefined
  private repeatPenalty: number | undefined
  private repeatLastN: number | undefined
  private presencePenalty: number | undefined
  private frequencyPenalty: number | undefined
  private mirostat: 0 | 1 | 2 | undefined
  private mirostatTau: number | undefined
  private mirostatEta: number | undefined
  private seed: number | undefined
  private firstChunkTimeoutMs: number
  private chunkTimeoutMs: number
  private contextWindowSize: number
  private outputTokenLimit: number

  constructor(config: LlamaServerProviderConfig) {
    this.id = config.id ?? 'llama-server'
    this.name = config.name ?? 'llama.cpp server'
    // Normalize baseUrl — llama-server mounts chat completions at /v1/chat/completions.
    // Accept both 'http://host:8080' and 'http://host:8080/v1'; strip trailing slash
    // and trailing '/v1' so we can consistently append '/v1/...'.
    let base = config.baseUrl.replace(/\/$/, '')
    if (base.endsWith('/v1')) base = base.slice(0, -3)
    this.baseUrl = base
    this.apiKey = config.apiKey ?? ''
    this.model = config.model ?? MODEL_DEFAULTS['llama-server']
    this.maxTokens = config.maxTokens ?? 4096
    this.temperature = config.temperature ?? 0.8
    this.topP = config.topP ?? 0.95
    this.topK = config.topK
    this.minP = config.minP
    this.typicalP = config.typicalP
    this.repeatPenalty = config.repeatPenalty
    this.repeatLastN = config.repeatLastN
    this.presencePenalty = config.presencePenalty
    this.frequencyPenalty = config.frequencyPenalty
    this.mirostat = config.mirostat
    this.mirostatTau = config.mirostatTau
    this.mirostatEta = config.mirostatEta
    this.seed = config.seed
    this.firstChunkTimeoutMs = config.firstChunkTimeoutMs ?? 120_000
    this.chunkTimeoutMs = config.chunkTimeoutMs ?? 30_000
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
    const body: LlamaRequestBody = {
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

    // llama-native sampling knobs — only sent when configured
    if (this.topK !== undefined) body.top_k = this.topK
    if (this.minP !== undefined) body.min_p = this.minP
    if (this.typicalP !== undefined) body.typical_p = this.typicalP
    if (this.repeatPenalty !== undefined) body.repeat_penalty = this.repeatPenalty
    if (this.repeatLastN !== undefined) body.repeat_last_n = this.repeatLastN
    if (this.presencePenalty !== undefined) body.presence_penalty = this.presencePenalty
    if (this.frequencyPenalty !== undefined) body.frequency_penalty = this.frequencyPenalty
    if (this.mirostat !== undefined) body.mirostat = this.mirostat
    if (this.mirostatTau !== undefined) body.mirostat_tau = this.mirostatTau
    if (this.mirostatEta !== undefined) body.mirostat_eta = this.mirostatEta
    if (this.seed !== undefined) body.seed = this.seed

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
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

          let event: LlamaStreamEvent
          try {
            const parsed: unknown = JSON.parse(data)
            if (!isStreamEvent(parsed)) continue
            event = parsed
          } catch {
            continue
          }

          const choice = event.choices?.[0]
          if (!choice) continue

          const delta = choice.delta
          // llama-server sometimes emits empty delta objects (especially on the
          // final chunk accompanying finish_reason). Keep going to process
          // finish_reason/usage on the same event.
          if (delta) {
            // Native reasoning field (llama-server --reasoning-format deepseek)
            if (delta.reasoning_content) {
              yield { type: 'reasoning', delta: delta.reasoning_content }
            }
            // Text content — parse <think> blocks inline (deepseek-legacy format
            // or models that emit <think> inside content regardless of server flag)
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
          }

          if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
            // Emit tool_call_done for all started tool calls — llama-server can
            // send an empty delta on the final chunk, so we can't rely on
            // delta.tool_calls being present here.
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
              // llama-server tool-call args can be malformed JSON — best effort
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

    // Flush any pending tool calls that never got tool_call_done
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
  // isAvailable — llama-server exposes /health
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {}
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
      const res = await fetch(`${this.baseUrl}/health`, { headers })
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
  name: 'llama-server',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new LlamaServerProvider({
        baseUrl: cfg.base_url as string,
        apiKey: cfg.api_key as string | undefined,
        model: cfg.model as string | undefined,
        maxTokens: cfg.max_tokens as number | undefined,
        temperature: cfg.temperature as number | undefined,
        topP: cfg.top_p as number | undefined,
        topK: cfg.top_k as number | undefined,
        minP: cfg.min_p as number | undefined,
        typicalP: cfg.typical_p as number | undefined,
        repeatPenalty: cfg.repeat_penalty as number | undefined,
        repeatLastN: cfg.repeat_last_n as number | undefined,
        presencePenalty: cfg.presence_penalty as number | undefined,
        frequencyPenalty: cfg.frequency_penalty as number | undefined,
        mirostat: cfg.mirostat as 0 | 1 | 2 | undefined,
        mirostatTau: cfg.mirostat_tau as number | undefined,
        mirostatEta: cfg.mirostat_eta as number | undefined,
        seed: cfg.seed as number | undefined,
        id: 'llama-server',
        name: (cfg.name as string | undefined) ?? 'llama-server',
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
      }),
    )
  },
}
