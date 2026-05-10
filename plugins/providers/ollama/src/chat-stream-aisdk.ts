/**
 * AI SDK-backed implementation of Ollama `chatStream`.
 *
 * Delegates to shared adapters in `@rivetos/core` for fullStream-part →
 * LLMChunk translation. This file owns Ollama-specific concerns:
 *
 * - **Native thinking** — `providerOptions.ollama.think` toggles the Ollama
 *   server's first-class reasoning channel (Qwen, DeepSeek-R1, etc). The
 *   legacy `/think` / `/no_think` prefix-injection and inline `<think>...
 *   </think>` text parsing are gone — the server surfaces reasoning natively.
 * - **`num_ctx` / sampling** — exposed via `providerOptions.ollama.options.*`
 *   (the typed shape exposed by `ollama-ai-provider-v2`). Standard sampling
 *   knobs (`temperature`, `topP`) flow through `streamText` itself.
 * - **`keep_alive`** is intentionally not configurable per-request: the typed
 *   provider-options surface doesn't expose it on the chat model. Operators
 *   should use `OLLAMA_KEEP_ALIVE` on the daemon if a non-default is needed.
 */

import {
  buildDoneChunk,
  convertMessagesToAiSdk,
  createLlmChunkAccumulator,
  translateAiSdkPart,
} from '@rivetos/core'
import { streamText, stepCountIs, jsonSchema, APICallError, type ToolSet } from 'ai'
import type { JSONObject } from '@ai-sdk/provider'
import { createOllama } from 'ollama-ai-provider-v2'
import type {
  ChatOptions,
  LLMChunk,
  Message,
  ThinkingLevel,
  ToolDefinition,
} from '@rivetos/types'
import { ProviderError } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Context bridge
// ---------------------------------------------------------------------------

export interface OllamaAiSdkContext {
  /** Bare baseUrl (e.g. http://localhost:11434). `/api` is appended. */
  baseUrl: string
  defaultModel: string
  numCtx: number
  temperature: number
  topP: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildToolSet(toolDefs: ToolDefinition[] | undefined): ToolSet {
  const set: ToolSet = {}
  if (!toolDefs?.length) return set
  for (const def of toolDefs) {
    set[def.name] = {
      description: def.description,
      inputSchema: jsonSchema(def.parameters as Record<string, unknown>),
    }
  }
  return set
}

function thinkFlag(thinking: ThinkingLevel | undefined): boolean | undefined {
  if (thinking === undefined) return undefined
  return thinking !== 'off'
}

// ---------------------------------------------------------------------------
// chatStreamAiSdk
// ---------------------------------------------------------------------------

export async function* chatStreamAiSdk(
  ctx: OllamaAiSdkContext,
  messages: Message[],
  options?: ChatOptions,
): AsyncIterable<LLMChunk> {
  const model = options?.modelOverride ?? ctx.defaultModel
  const aiSdkMessages = convertMessagesToAiSdk(messages)

  const tools = buildToolSet(options?.tools)
  const hasTools = Object.keys(tools).length > 0

  const provider = createOllama({ baseURL: `${ctx.baseUrl}/api` })

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
    const ollamaOpts: JSONObject = {}
    if (ctx.numCtx > 0) ollamaOpts.num_ctx = ctx.numCtx

    const ollamaProviderOptions: JSONObject = {}
    if (Object.keys(ollamaOpts).length > 0) ollamaProviderOptions.options = ollamaOpts
    const think = thinkFlag(options?.thinking)
    if (think !== undefined) ollamaProviderOptions.think = think

    const result = streamText({
      model: provider.chat(model),
      messages: aiSdkMessages,
      tools: hasTools ? tools : undefined,
      stopWhen: stepCountIs(1),
      abortSignal: controller.signal,
      temperature: ctx.temperature,
      topP: ctx.topP,
      ...(Object.keys(ollamaProviderOptions).length > 0
        ? { providerOptions: { ollama: ollamaProviderOptions } }
        : {}),
    })

    for await (const part of result.fullStream) {
      const chunks = translateAiSdkPart(part as never, acc)
      for (const chunk of chunks) yield chunk
    }

    yield buildDoneChunk(acc)
  } catch (err) {
    if (err instanceof ProviderError) throw err
    if (APICallError.isInstance(err)) {
      throw new ProviderError(
        `Ollama ${String(err.statusCode ?? 0)}: ${(err.responseBody ?? err.message).slice(0, 500)}`,
        err.statusCode ?? 0,
        'ollama',
      )
    }
    if (controller.signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ollama-aisdk] Stream error:', message)
    yield { type: 'error', error: message }
  }
}
