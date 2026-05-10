/**
 * AI SDK-backed implementation of Google `chatStream`.
 *
 * Delegates to shared adapters in `@rivetos/aisdk` for fullStream-part →
 * LLMChunk translation. This file owns Google-specific concerns:
 * - System message extraction (Gemini takes systemInstruction separately).
 * - Thinking budget mapping (low/medium/high → token budgets).
 * - thoughtSignature passthrough on assistant tool-call parts (reasoning
 *   continuity across multi-turn agentic flows). The shared converter doesn't
 *   carry this Google-specific field, so we post-process the ModelMessage[]
 *   to attach providerOptions.google.thoughtSignature where the source
 *   ToolCall had one.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google'
import {
  buildDoneChunk,
  convertMessagesToAiSdk,
  createLlmChunkAccumulator,
  translateAiSdkPart,
} from '@rivetos/aisdk'
import {
  streamText,
  stepCountIs,
  jsonSchema,
  APICallError,
  type ModelMessage,
  type ToolSet,
} from 'ai'
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

export interface GoogleAiSdkContext {
  apiKey: string
  baseUrl: string
  defaultModel: string
  maxTokens: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THINKING_BUDGETS: Record<ThinkingLevel, number | null> = {
  off: 0,
  low: 1024,
  medium: 8192,
  high: 32768,
  xhigh: 32768,
}

function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is ContentPart & { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function splitSystem(messages: Message[]): { system: string; rest: Message[] } {
  let system = ''
  const rest: Message[] = []
  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + extractText(msg.content)
      continue
    }
    rest.push(msg)
  }
  return { system, rest }
}

/**
 * Walk ModelMessage[] (already converted via shared adapter) and attach
 * providerOptions.google.thoughtSignature to tool-call parts whose source
 * ToolCall in `original` had one. Mutates in place; returns same array.
 */
function attachThoughtSignatures(converted: ModelMessage[], original: Message[]): ModelMessage[] {
  const sigByCallId = new Map<string, string>()
  for (const m of original) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.thoughtSignature) sigByCallId.set(tc.id, tc.thoughtSignature)
      }
    }
  }
  if (sigByCallId.size === 0) return converted

  for (const msg of converted) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
    for (const part of msg.content) {
      if (part.type === 'tool-call') {
        const sig = sigByCallId.get(part.toolCallId)
        if (sig) {
          part.providerOptions = {
            ...(part.providerOptions ?? {}),
            google: { thoughtSignature: sig },
          }
        }
      }
    }
  }
  return converted
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
  ctx: GoogleAiSdkContext,
  messages: Message[],
  options?: ChatOptions,
): AsyncIterable<LLMChunk> {
  const model = options?.modelOverride ?? ctx.defaultModel
  const { system, rest } = splitSystem(messages)
  const aiSdkMessages = attachThoughtSignatures(convertMessagesToAiSdk(rest), rest)

  const tools = buildToolSet(options?.tools)
  const thinking = options?.thinking ?? 'off'
  const thinkingBudget = THINKING_BUDGETS[thinking]

  const provider = createGoogleGenerativeAI({ apiKey: ctx.apiKey, baseURL: ctx.baseUrl })

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
    const googleProviderOptions: JSONObject = {}
    if (thinkingBudget !== null && thinkingBudget > 0) {
      googleProviderOptions.thinkingConfig = {
        thinkingBudget,
        includeThoughts: true,
      }
    }

    const result = streamText({
      model: provider(model),
      ...(system ? { system } : {}),
      messages: aiSdkMessages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      stopWhen: stepCountIs(1),
      abortSignal: controller.signal,
      maxOutputTokens: ctx.maxTokens,
      providerOptions: { google: googleProviderOptions },
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
        `Google ${String(err.statusCode ?? 0)}: ${(err.responseBody ?? err.message).slice(0, 500)}`,
        err.statusCode ?? 0,
        'google',
      )
    }
    if (controller.signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    console.error('[google-aisdk] Stream error:', message)
    yield { type: 'error', error: message }
  }
}
