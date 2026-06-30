/**
 * AI SDK-backed implementation of OpenAI-compatible `chatStream`.
 *
 * Delegates to shared adapters in `@rivetos/aisdk` for fullStream-part →
 * LLMChunk translation. This file owns OpenAI-compat-specific concerns:
 *
 * - **Strict message ordering** — any `system` message that appears AFTER a
 *   non-system message is folded into a `user` message with a `[SYSTEM NOTICE]`
 *   prefix. vLLM + Qwen/Llama chat templates reject mid-conversation system
 *   messages; RivetOS legitimately injects them for context-window warnings,
 *   steer events, and turn-timeout notices.
 * - **vLLM sampling extensions** — `top_k` and `min_p` are sent via
 *   `transformRequestBody`. Standard OpenAI knobs (`temperature`, `top_p`,
 *   `frequency_penalty`, `presence_penalty`, `seed`) flow through `streamText`.
 * - **Reasoning** — relies on the AI SDK's first-class reasoning surface which
 *   maps from vLLM's `reasoning_content` field (per OpenAI-compat spec) when
 *   `--reasoning-parser` is configured server-side. The legacy inline
 *   `<think>...</think>` content fallback was dropped — operators should
 *   configure `--reasoning-parser` on the server instead.
 * - **Per-call URL routing** — the chat completions endpoint is normalized
 *   from a forgiving baseUrl that accepts either `http://host:port` or
 *   `http://host:port/v1`.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  buildDoneChunk,
  convertMessagesToAiSdk,
  createLlmChunkAccumulator,
  translateAiSdkPart,
} from '@rivetos/aisdk'
import { streamText, stepCountIs, jsonSchema, APICallError, type ToolSet } from 'ai'
import type { ChatOptions, ContentPart, LLMChunk, Message, ToolDefinition } from '@rivetos/types'
import { ProviderError } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolChoice =
  'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }

export interface VllmAiSdkContext {
  /** Bare baseUrl (no /v1 suffix). */
  baseUrl: string
  apiKey: string
  defaultModel: string
  providerName: string
  providerId: string
  maxTokens: number
  temperature: number
  topP: number
  topK: number | undefined
  minP: number | undefined
  presencePenalty: number | undefined
  frequencyPenalty: number | undefined
  seed: number | undefined
  defaultToolChoice: ToolChoice
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/**
 * Pre-process RivetOS messages so the shared converter sees a clean shape:
 *   - The first contiguous run of `role: 'system'` is preserved (and merged
 *     into a single concatenated string).
 *   - Any `role: 'system'` after the first non-system message is rewritten
 *     to a `role: 'user'` message with a `[SYSTEM NOTICE]` prefix.
 *
 * Returns { system, rest } — the converter uses `system` for AI SDK's `system`
 * option and `rest` for the messages array.
 */
export function splitAndFoldSystem(messages: Message[]): { system: string; rest: Message[] } {
  let system = ''
  let seenNonSystem = false
  const rest: Message[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractText(msg.content)
      if (!seenNonSystem) {
        system += (system ? '\n\n' : '') + text
        continue
      }
      // Mid-conversation system → fold into user
      const noticeText = text
        ? `[SYSTEM NOTICE]\n${text}`
        : '[SYSTEM NOTICE]\n(empty system message)'
      rest.push({ role: 'user', content: noticeText })
      continue
    }
    seenNonSystem = true
    rest.push(msg)
  }

  return { system, rest }
}

function buildToolSet(toolDefs: ToolDefinition[] | undefined): ToolSet {
  const set: ToolSet = {}
  if (!toolDefs?.length) return set
  for (const def of toolDefs) {
    set[def.name] = {
      description: def.description,
      inputSchema: jsonSchema(def.parameters),
    }
  }
  return set
}

// ---------------------------------------------------------------------------
// chatStreamAiSdk
// ---------------------------------------------------------------------------

export async function* chatStreamAiSdk(
  ctx: VllmAiSdkContext,
  messages: Message[],
  options?: ChatOptions,
): AsyncIterable<LLMChunk> {
  const model = options?.modelOverride ?? ctx.defaultModel
  const { system, rest } = splitAndFoldSystem(messages)
  const aiSdkMessages = convertMessagesToAiSdk(rest)

  const tools = buildToolSet(options?.tools)
  const hasTools = Object.keys(tools).length > 0

  // Inject vLLM extensions via transformRequestBody. Standard sampling fields
  // are passed through streamText() options below.
  const provider = createOpenAICompatible({
    baseURL: `${ctx.baseUrl}/v1`,
    name: ctx.providerName,
    apiKey: ctx.apiKey || undefined,
    includeUsage: true,
    transformRequestBody: (body) => {
      const out = { ...body } as Record<string, unknown>
      if (ctx.topK !== undefined) out.top_k = ctx.topK
      if (ctx.minP !== undefined) out.min_p = ctx.minP
      if (hasTools && ctx.defaultToolChoice !== 'auto') {
        out.tool_choice = ctx.defaultToolChoice
      }
      return out
    },
  })

  // Abort wiring
  const controller = new AbortController()
  if (options?.signal) {
    if (options.signal.aborted) {
      yield { type: 'error', error: 'Aborted' }
      return
    }
    options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const acc = createLlmChunkAccumulator()

  try {
    const result = streamText({
      model: provider.chatModel(model),
      ...(system ? { system } : {}),
      messages: aiSdkMessages,
      tools: hasTools ? tools : undefined,
      stopWhen: stepCountIs(1),
      abortSignal: controller.signal,
      maxOutputTokens: ctx.maxTokens,
      temperature: ctx.temperature,
      topP: ctx.topP,
      ...(ctx.presencePenalty !== undefined ? { presencePenalty: ctx.presencePenalty } : {}),
      ...(ctx.frequencyPenalty !== undefined ? { frequencyPenalty: ctx.frequencyPenalty } : {}),
      ...(ctx.seed !== undefined ? { seed: ctx.seed } : {}),
    })

    for await (const part of result.fullStream) {
      const chunks = translateAiSdkPart(part, acc)
      for (const chunk of chunks) yield chunk
    }

    yield buildDoneChunk(acc)
  } catch (err) {
    if (err instanceof ProviderError) throw err
    if (APICallError.isInstance(err)) {
      throw new ProviderError(
        `${ctx.providerName} ${String(err.statusCode ?? 0)}: ${(err.responseBody ?? err.message).slice(0, 500)}`,
        err.statusCode ?? 0,
        ctx.providerId,
      )
    }
    if (controller.signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${ctx.providerId}-aisdk] Stream error:`, message)
    yield { type: 'error', error: message }
  }
}
