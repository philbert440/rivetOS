/**
 * Test fixture: build a `Provider` whose `aiSdkBridge()` returns a
 * `MockLanguageModelV3` driven by ergonomic `LLMChunk[]` input.
 *
 * Tests can specify per-call chunk arrays; the helper translates them into
 * V3 stream parts that AI SDK consumes naturally (drives tool execution,
 * usage accumulation, etc.).
 *
 * Used by loop, delegation, subagent, runtime, hooks, and router tests.
 */

import type { ChatOptions, LLMChunk, Message, Provider } from '@rivetos/types'
import { MockLanguageModelV3 } from 'ai/test'
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MockProviderOptions {
  /**
   * Per-call chunk arrays. If a flat `LLMChunk[]` is given, the same chunks
   * are emitted on every call. If a `LLMChunk[][]` is given, the i-th array
   * is used for the i-th call; calls past the end repeat the last array.
   */
  chunks: LLMChunk[] | LLMChunk[][]
  /** Optional capture of each call's prompt and call index. */
  onCall?: (info: { callIndex: number; prompt: LanguageModelV3CallOptions['prompt'] }) => void
  /** Optional override of provider id (default: 'mock'). */
  id?: string
  /** Optional override of provider name (default: 'Mock Provider'). */
  name?: string
  /** Optional override of model id (default: 'mock-model'). */
  modelId?: string
  /** Optional context window override (default: 0). */
  contextWindow?: number
  /** Optional max output tokens override (default: 0). */
  maxOutputTokens?: number
  /** Optional override of `isAvailable` (default: returns true). */
  isAvailable?: () => Promise<boolean>
}

/**
 * Build a `Provider` mock driven by ergonomic LLMChunk input. The provider
 * exposes the new `aiSdkBridge()` surface required by the AI SDK loop.
 */
export function makeMockProvider(input: MockProviderOptions | LLMChunk[]): Provider {
  const opts: MockProviderOptions = Array.isArray(input) ? { chunks: input } : input
  const id = opts.id ?? 'mock'
  const name = opts.name ?? 'Mock Provider'
  const modelId = opts.modelId ?? 'mock-model'
  const contextWindow = opts.contextWindow ?? 0
  const maxOutputTokens = opts.maxOutputTokens ?? 0
  const isAvailable = opts.isAvailable ?? (async () => true)

  let callIndex = 0

  const provider: Provider = {
    id,
    name,
    isAvailable,
    getModel() {
      return modelId
    },
    setModel() {
      /* no-op */
    },
    getContextWindow() {
      return contextWindow
    },
    getMaxOutputTokens() {
      return maxOutputTokens
    },
    aiSdkBridge() {
      return {
        getModel() {
          return new MockLanguageModelV3({
            provider: id,
            modelId,
            doStream: async (options: LanguageModelV3CallOptions) => {
              const idx = callIndex++
              opts.onCall?.({ callIndex: idx, prompt: options.prompt })
              const chunks = pickChunks(opts.chunks, idx)
              const parts = translateLlmChunksToV3(chunks)
              return {
                stream: arrayToReadableStream(parts),
              }
            },
          })
        },
        buildProviderOptions() {
          return undefined
        },
      }
    },
  }

  return provider
}

// ---------------------------------------------------------------------------
// Convenience: explicit two-call provider (call 1 = first array, call 2+ = second array)
// ---------------------------------------------------------------------------

export function makeMockProviderSequence(sequences: LLMChunk[][]): Provider {
  return makeMockProvider({ chunks: sequences })
}

// ---------------------------------------------------------------------------
// Internal: chunk picker
// ---------------------------------------------------------------------------

function pickChunks(
  input: LLMChunk[] | LLMChunk[][],
  callIndex: number,
): LLMChunk[] {
  if (input.length === 0) return []
  if (!Array.isArray(input[0])) {
    return input as LLMChunk[]
  }
  const sequences = input as LLMChunk[][]
  if (callIndex < sequences.length) return sequences[callIndex]
  return sequences[sequences.length - 1]
}

// ---------------------------------------------------------------------------
// Internal: LLMChunk[] → V3 stream parts
// ---------------------------------------------------------------------------

interface PendingToolCall {
  id: string
  toolName: string
  argsBuffer: string
  emittedStart: boolean
}

/**
 * Translate `LLMChunk[]` → V3 stream parts.
 *
 * Mapping:
 *   text         → text-delta { id, delta }
 *   reasoning    → reasoning-delta { id, delta }
 *   tool_call_*  → tool-input-{start,delta,end} + tool-call (with parsed input)
 *   done         → finish { usage, finishReason: 'tool-calls' if tool calls, else 'stop' }
 *   error        → error { error }
 *   citation     → source { sourceType: 'url', url, id }
 *   status       → (skipped — no V3 equivalent; emit as reasoning-delta if needed)
 */
export function translateLlmChunksToV3(chunks: LLMChunk[]): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = []
  parts.push({ type: 'stream-start', warnings: [] })

  let textStarted = false
  const textId = 'mock-text-1'
  let reasoningStarted = false
  const reasoningId = 'mock-reasoning-1'
  const toolCallsByIndex = new Map<number, PendingToolCall>()
  let hadToolCalls = false
  let usage = { inputTokens: 0, outputTokens: 0 }
  let citationCount = 0

  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'text': {
        if (chunk.delta) {
          if (!textStarted) {
            parts.push({ type: 'text-start', id: textId })
            textStarted = true
          }
          parts.push({ type: 'text-delta', id: textId, delta: chunk.delta })
        }
        break
      }
      case 'reasoning': {
        if (chunk.delta) {
          if (!reasoningStarted) {
            parts.push({ type: 'reasoning-start', id: reasoningId })
            reasoningStarted = true
          }
          parts.push({ type: 'reasoning-delta', id: reasoningId, delta: chunk.delta })
        }
        break
      }
      case 'tool_call_start': {
        const tc = chunk.toolCall
        if (tc?.index !== undefined && tc.id && tc.name) {
          const pending: PendingToolCall = {
            id: tc.id,
            toolName: tc.name,
            argsBuffer: '',
            emittedStart: true,
          }
          toolCallsByIndex.set(tc.index, pending)
          parts.push({
            type: 'tool-input-start',
            id: tc.id,
            toolName: tc.name,
          })
          hadToolCalls = true
        }
        break
      }
      case 'tool_call_delta': {
        const idx = chunk.toolCall?.index
        if (idx !== undefined && chunk.delta) {
          const pending = toolCallsByIndex.get(idx)
          if (pending) {
            pending.argsBuffer += chunk.delta
            parts.push({
              type: 'tool-input-delta',
              id: pending.id,
              delta: chunk.delta,
            })
          }
        }
        break
      }
      case 'tool_call_done': {
        const idx = chunk.toolCall?.index
        if (idx !== undefined) {
          const pending = toolCallsByIndex.get(idx)
          if (pending) {
            parts.push({ type: 'tool-input-end', id: pending.id })
            // The tool-call part triggers AI SDK's tool execution.
            parts.push({
              type: 'tool-call',
              toolCallId: pending.id,
              toolName: pending.toolName,
              input: pending.argsBuffer || '{}',
            })
          }
        }
        break
      }
      case 'done': {
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.promptTokens,
            outputTokens: chunk.usage.completionTokens,
          }
        }
        if (chunk.citations) {
          for (const url of chunk.citations) {
            citationCount++
            parts.push({
              type: 'source',
              sourceType: 'url',
              id: `mock-source-${citationCount}`,
              url,
            })
          }
        }
        break
      }
      case 'error': {
        // Emit as V3 error part. Note: AI SDK fullStream surfaces this as
        // an `error` part rather than throwing.
        parts.push({ type: 'error', error: chunk.error ?? 'mock error' })
        break
      }
      case 'status': {
        // V3 has no native status part. Skip silently — tests that rely on
        // status chunks need to test via heartbeat/timeout-warning paths.
        break
      }
    }
  }

  // Close text/reasoning if started.
  if (textStarted) parts.push({ type: 'text-end', id: textId })
  if (reasoningStarted) parts.push({ type: 'reasoning-end', id: reasoningId })

  // Emit finish.
  parts.push({
    type: 'finish',
    usage: {
      inputTokens: {
        total: usage.inputTokens,
        noCache: usage.inputTokens,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: usage.outputTokens,
        text: usage.outputTokens,
        reasoning: undefined,
      },
    },
    finishReason: (hadToolCalls
      ? 'tool-calls'
      : 'stop') as unknown as LanguageModelV3FinishReason,
  })

  return parts
}

// ---------------------------------------------------------------------------
// Internal: array → ReadableStream
// ---------------------------------------------------------------------------

function arrayToReadableStream<T>(values: T[]): ReadableStream<T> {
  let i = 0
  return new ReadableStream<T>({
    pull(controller) {
      if (i < values.length) {
        controller.enqueue(values[i++])
      } else {
        controller.close()
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Re-export Message/ChatOptions types for test convenience
// ---------------------------------------------------------------------------

export type { Message, ChatOptions }
