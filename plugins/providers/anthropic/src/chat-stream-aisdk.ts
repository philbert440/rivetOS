/**
 * AI SDK-backed implementation of Anthropic `chatStream`.
 *
 * Delegates to shared adapters in `@rivetos/core` for fullStream-part →
 * LLMChunk translation. This file owns Anthropic-specific concerns:
 * - System message extraction (Anthropic puts system separately, with optional
 *   ephemeral cache_control on the system block).
 * - Orphaned tool_result sanitization (defensive — strips tool messages whose
 *   tool_use_id has no matching tool_use in the converted history).
 * - Thinking mode mapping: Claude 4 family uses adaptive { type: 'adaptive' }
 *   + effort level; older models use { type: 'enabled', budgetTokens }.
 * - Provider-side image conversion (legacy used `source.type` shapes; AI SDK
 *   uses ModelMessage `image-url` / `image-data` parts via shared adapter).
 *
 * Known gaps vs. the legacy path:
 * - `xhigh` reasoning effort: AI SDK's effort enum accepts 'xhigh' for Claude 4
 *   adaptive thinking — fully supported.
 * - Per-message ephemeral cache_control on individual user/assistant turns is
 *   not exposed (legacy only set it on the system block, which IS preserved).
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import {
  buildDoneChunk,
  convertMessagesToAiSdk,
  createLlmChunkAccumulator,
  translateAiSdkPart,
} from '@rivetos/core'
import { streamText, stepCountIs, jsonSchema, APICallError, type ToolSet } from 'ai'
import type { JSONObject } from '@ai-sdk/provider'
import type {
  ChatOptions,
  ContentPart,
  LLMChunk,
  Message,
  ThinkingLevel,
  ToolDefinition,
} from '@rivetos/types'
import { ProviderError } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Context bridge
// ---------------------------------------------------------------------------

export interface AnthropicAiSdkContext {
  apiKey: string
  baseUrl: string
  defaultModel: string
  maxTokens: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFromParts(parts: ContentPart[]): string {
  return parts
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function isClaude4Model(model: string): boolean {
  return /^claude-(opus|sonnet|haiku)-4(-\d+)?/i.test(model)
}

const CLAUDE3_BUDGET_TOKENS: Record<ThinkingLevel, number | null> = {
  off: null,
  low: 2000,
  medium: 10000,
  high: 50000,
  xhigh: 50000,
}

/**
 * Pull leading system messages out into a single concatenated string.
 * Returns the remaining (non-system) Message[] for AI SDK conversion.
 */
function splitSystem(messages: Message[]): { system: string; rest: Message[] } {
  let system = ''
  const rest: Message[] = []
  for (const msg of messages) {
    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string' ? msg.content : extractTextFromParts(msg.content)
      system += (system ? '\n\n' : '') + text
      continue
    }
    rest.push(msg)
  }
  return { system, rest }
}

/**
 * Defensive: remove tool messages whose toolCallId doesn't correspond to a
 * tool_use in any prior assistant message. Compaction can leave orphans that
 * trigger 400 from Anthropic's API.
 */
function stripOrphanedToolResults(messages: Message[]): Message[] {
  const validIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) validIds.add(tc.id)
    }
  }
  const out: Message[] = []
  for (const msg of messages) {
    if (msg.role === 'tool') {
      if (!msg.toolCallId || !validIds.has(msg.toolCallId)) {
        console.warn(
          '[anthropic-aisdk] Dropped orphaned tool_result message — toolCallId not found in history',
        )
        continue
      }
    }
    out.push(msg)
  }
  return out
}

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

// ---------------------------------------------------------------------------
// chatStreamAiSdk
// ---------------------------------------------------------------------------

export async function* chatStreamAiSdk(
  ctx: AnthropicAiSdkContext,
  messages: Message[],
  options?: ChatOptions,
): AsyncIterable<LLMChunk> {
  const model = options?.modelOverride ?? ctx.defaultModel
  const { system, rest } = splitSystem(messages)
  const sanitized = stripOrphanedToolResults(rest)
  const aiSdkMessages = convertMessagesToAiSdk(sanitized)

  const tools = buildToolSet(options?.tools)
  const thinking = options?.thinking ?? 'off'

  const provider = createAnthropic({ apiKey: ctx.apiKey, baseURL: `${ctx.baseUrl}/v1` })

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
    const anthropicProviderOptions: JSONObject = {}

    // System prompt — preserve legacy ephemeral caching for ~90% savings on hits.
    if (system) {
      anthropicProviderOptions.cacheControl = { type: 'ephemeral' }
    }

    let maxOutputTokens = ctx.maxTokens

    if (thinking !== 'off') {
      if (isClaude4Model(model)) {
        // Claude 4 — adaptive thinking with effort level
        anthropicProviderOptions.thinking = { type: 'adaptive' }
        anthropicProviderOptions.effort = thinking
      } else {
        // Claude 3.x — legacy budget-tokens form
        const budget = CLAUDE3_BUDGET_TOKENS[thinking]
        if (budget !== null) {
          anthropicProviderOptions.thinking = { type: 'enabled', budgetTokens: budget }
          // max_tokens must exceed budget for legacy thinking models
          maxOutputTokens = budget + ctx.maxTokens
        }
      }
    }

    // Surface reasoning back to the application layer.
    anthropicProviderOptions.sendReasoning = true

    const result = streamText({
      model: provider(model),
      ...(system ? { system } : {}),
      messages: aiSdkMessages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      stopWhen: stepCountIs(1),
      abortSignal: controller.signal,
      maxOutputTokens,
      providerOptions: { anthropic: anthropicProviderOptions },
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
        `Anthropic ${String(err.statusCode ?? 0)}: ${(err.responseBody ?? err.message).slice(0, 500)}`,
        err.statusCode ?? 0,
        'anthropic',
      )
    }
    if (controller.signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    console.error('[anthropic-aisdk] Stream error:', message)
    yield { type: 'error', error: message }
  }
}
