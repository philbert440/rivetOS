/**
 * Shared AI SDK ↔ RivetOS adapters.
 *
 * Two consumers:
 *   - Provider plugins (xAI, soon Anthropic/Google/OpenAI) wrapping
 *     `streamText()` and exposing `AsyncIterable<LLMChunk>`.
 *   - The new AI-SDK-native loop (step 6+) which calls `streamText()` directly
 *     but reuses the chunk translation when emitting StreamEvents.
 *
 * Pure / stateless except for the per-stream accumulator passed into the
 * generator. No I/O, no provider-specific behavior — provider quirks
 * (response-id persistence, conversation cache headers, server-side tools)
 * stay in the provider plugin.
 */

import type {
  ContentPart,
  LLMChunk,
  LLMUsage,
  Message,
  StreamEvent,
  ToolCall,
} from '@rivetos/types'
import type { ModelMessage } from 'ai'

// ---------------------------------------------------------------------------
// Message conversion helpers
// ---------------------------------------------------------------------------

export function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

type AiSdkUserPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string | URL; mediaType?: string }

export function partsToAiSdkUserContent(parts: ContentPart[]): AiSdkUserPart[] {
  const out: AiSdkUserPart[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) out.push({ type: 'text', text: part.text })
    } else if (part.data) {
      out.push({
        type: 'image',
        image: `data:${part.mimeType ?? 'image/jpeg'};base64,${part.data}`,
        mediaType: part.mimeType,
      })
    } else if (part.url) {
      out.push({ type: 'image', image: new URL(part.url), mediaType: part.mimeType })
    }
  }
  return out
}

/**
 * Convert RivetOS `Message[]` → AI SDK `ModelMessage[]`.
 *
 * Tool-result messages need a `toolName` under AI SDK's schema; RivetOS doesn't
 * track that on tool messages, so we rebuild it from prior assistant turns.
 */
export function convertMessagesToAiSdk(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = []

  const toolNameByCallId = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) toolNameByCallId.set(tc.id, tc.name)
    }
  }

  for (const msg of messages) {
    if (msg.role === 'tool') {
      let value = extractText(msg.content) || ''
      if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
        const imageCount = msg.content.filter((p) => p.type === 'image').length
        if (imageCount > 0) {
          value += `\n[${String(imageCount)} image(s) returned — see image content in context]`
        }
      }
      const callId = msg.toolCallId ?? ''
      result.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
            toolName: toolNameByCallId.get(callId) ?? '',
            output: { type: 'text', value },
          },
        ],
      })
    } else if (msg.role === 'assistant') {
      const text = extractText(msg.content) || ''
      const hasToolCalls = !!msg.toolCalls && msg.toolCalls.length > 0

      if (hasToolCalls) {
        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
        > = []
        if (text) content.push({ type: 'text', text })
        for (const tc of msg.toolCalls!) {
          let input: unknown
          if (typeof tc.arguments === 'string') {
            try {
              input = JSON.parse(tc.arguments)
            } catch {
              input = { raw: tc.arguments }
            }
          } else {
            input = tc.arguments
          }
          content.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input })
        }
        result.push({ role: 'assistant', content })
      } else if (text) {
        result.push({ role: 'assistant', content: text })
      }
    } else if (msg.role === 'user') {
      if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
        const userContent = partsToAiSdkUserContent(msg.content)
        if (userContent.length > 0) {
          result.push({ role: 'user', content: userContent })
        } else {
          const text = extractText(msg.content)
          if (text) result.push({ role: 'user', content: text })
        }
      } else {
        const text = extractText(msg.content)
        if (text) result.push({ role: 'user', content: text })
      }
    } else {
      const text = extractText(msg.content)
      if (text) result.push({ role: 'system', content: text })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Chunk translation: AI SDK fullStream parts → LLMChunk
// ---------------------------------------------------------------------------

/**
 * Per-stream mutable state. The translator mutates this so callers can inspect
 * the final state after the stream ends (e.g., to decide response-id persistence).
 *
 * Construct via `createLlmChunkAccumulator()`. Provider plugins can read fields
 * after the loop completes.
 */
export interface AiSdkChunkAccumulator {
  readonly usage: LLMUsage
  readonly citations: string[]
  hadTextContent: boolean
  /** Last response.id observed on a finish-step, if any. */
  responseId: string | null
  /** Internal: AI SDK tool-input ids → contiguous indices for LLMChunk. */
  readonly _pendingToolCallIndex: Map<string, number>
  _nextToolCallIndex: number
}

export function createLlmChunkAccumulator(): AiSdkChunkAccumulator {
  return {
    usage: { promptTokens: 0, completionTokens: 0 },
    citations: [],
    hadTextContent: false,
    responseId: null,
    _pendingToolCallIndex: new Map(),
    _nextToolCallIndex: 0,
  }
}

/**
 * AI SDK `fullStream` part shape (loose-typed — we only read fields by name and
 * fall through unknown types).
 */
type AiSdkPart = {
  type: string
  text?: string
  delta?: string
  id?: string
  toolName?: string
  sourceType?: string
  url?: string
  error?: unknown
  usage?: {
    inputTokens?: number
    outputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  response?: { id?: string }
}

/**
 * Translate one AI SDK fullStream part into zero or more `LLMChunk`s.
 *
 * Returns an array because most parts emit one chunk, some emit none, and a few
 * (none today, but future-proofed) could emit multiple. Mutates `acc`.
 */
export function translateAiSdkPart(part: AiSdkPart, acc: AiSdkChunkAccumulator): LLMChunk[] {
  switch (part.type) {
    case 'text-delta': {
      if (part.text) {
        acc.hadTextContent = true
        return [{ type: 'text', delta: part.text }]
      }
      return []
    }
    case 'reasoning-delta': {
      if (part.text) return [{ type: 'reasoning', delta: part.text }]
      return []
    }
    case 'tool-input-start': {
      if (!part.id) return []
      const idx = acc._nextToolCallIndex++
      acc._pendingToolCallIndex.set(part.id, idx)
      return [
        {
          type: 'tool_call_start',
          toolCall: { index: idx, id: part.id, name: part.toolName },
        },
      ]
    }
    case 'tool-input-delta': {
      if (!part.id || part.delta === undefined) return []
      const idx = acc._pendingToolCallIndex.get(part.id) ?? 0
      return [{ type: 'tool_call_delta', delta: part.delta, toolCall: { index: idx } }]
    }
    case 'tool-input-end': {
      if (!part.id) return []
      const idx = acc._pendingToolCallIndex.get(part.id) ?? 0
      return [{ type: 'tool_call_done', toolCall: { index: idx } }]
    }
    case 'source': {
      if (part.sourceType === 'url' && part.url) acc.citations.push(part.url)
      return []
    }
    case 'finish-step': {
      if (part.usage) {
        acc.usage.promptTokens = part.usage.inputTokens ?? 0
        acc.usage.completionTokens = part.usage.outputTokens ?? 0
        const reasoningTokens = part.usage.outputTokenDetails?.reasoningTokens
        if (reasoningTokens) acc.usage.reasoningTokens = reasoningTokens
        const cacheReadTokens = part.usage.inputTokenDetails?.cacheReadTokens
        if (cacheReadTokens) acc.usage.cachedTokens = cacheReadTokens
      }
      if (part.response?.id) acc.responseId = part.response.id
      return []
    }
    case 'error': {
      const errMsg = part.error instanceof Error ? part.error.message : String(part.error)
      return [{ type: 'error', error: errMsg }]
    }
    // Ignored: text-start/end, reasoning-start/end, tool-call (we already
    // emitted equivalent chunks from the input stream), tool-result,
    // tool-error, file, start, finish, abort, start-step.
    default:
      return []
  }
}

/**
 * Build the terminal `done` chunk from the accumulator. Callers yield this
 * after exhausting the AI SDK stream successfully.
 */
export function buildDoneChunk(acc: AiSdkChunkAccumulator): LLMChunk {
  const chunk: LLMChunk = { type: 'done', usage: acc.usage }
  if (acc.citations.length > 0) chunk.citations = acc.citations
  return chunk
}

// ---------------------------------------------------------------------------
// Stream collection: AsyncIterable<LLMChunk> → StreamEvent emissions + state
// ---------------------------------------------------------------------------

/**
 * Terminal state returned by `collectLlmStream`. Mirrors the per-iteration state
 * tracked by the legacy loop at `loop.ts:371-505` so the new AI-SDK-native loop
 * can replace that block with a single function call.
 */
export interface StreamCollectorResult {
  /** Concatenated 'text' chunk deltas. Becomes the assistant message content. */
  textContent: string
  /** Concatenated 'reasoning' chunk deltas. Currently emitted but discarded by the loop. */
  reasoningContent: string
  /** Finalized tool calls (args parsed from accumulated JSON deltas). */
  toolCalls: ToolCall[]
  /** True iff the model emitted at least one tool_call_start chunk. */
  hasToolCalls: boolean
  /** Per-stream usage (max-merged across chunks; matches loop semantics). */
  totalUsage: LLMUsage
  /**
   * Last non-zero `promptTokens` observed on any chunk. The loop uses this for
   * context-window % calculations even when the final 'done' chunk reports 0.
   */
  lastKnownPromptTokens: number
  /** Last 'error' chunk message, if any. */
  lastError: string | null
  /** URL citations from server-side search tools. */
  citations: string[]
  /** True if the abort signal fired mid-stream. */
  aborted: boolean
}

/**
 * Consume an `AsyncIterable<LLMChunk>`, emit per-chunk `StreamEvent`s via the
 * provided callback, and return the terminal accumulator state.
 *
 * Lifted from `AgentLoop.run()` chunk-handling loop (loop.ts:392-506) so the
 * upcoming AI-SDK-native loop (step 6) can reuse it. Behavior is byte-for-byte
 * identical:
 *   - 'text' delta → emit text event, accumulate
 *   - 'reasoning' delta → emit reasoning event, accumulate
 *   - 'tool_call_start' / 'tool_call_delta' / 'tool_call_done' → build ToolCall
 *     from contiguous index, parse JSON args (fall back to {raw}) on done
 *   - 'status' delta → emit "🔍 <delta>" status event
 *   - 'done' usage → max-merge into totalUsage, copy reasoningTokens/cachedTokens
 *   - 'error' → emit error event, store as lastError
 * Usage on any chunk also updates totalUsage and lastKnownPromptTokens.
 *
 * If `signal.aborted` becomes true mid-stream, returns immediately with
 * `aborted: true` and whatever's been accumulated so far.
 *
 * The function does NOT throw on stream errors — provider errors are surfaced
 * via 'error' chunks (yielded by the provider's `chatStream`) and translated to
 * `lastError` here. Iterator-level exceptions (network drops, abort errors)
 * still propagate to the caller.
 */
export async function collectLlmStream(
  stream: AsyncIterable<LLMChunk>,
  emit: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<StreamCollectorResult> {
  let textContent = ''
  let reasoningContent = ''
  const pendingToolCalls = new Map<number, ToolCall>()
  const argsDelta = new Map<number, string>()
  let hasToolCalls = false
  let lastError: string | null = null
  let lastKnownPromptTokens = 0
  const totalUsage: LLMUsage = { promptTokens: 0, completionTokens: 0 }
  const citations: string[] = []

  for await (const chunk of stream) {
    if (chunk.usage) {
      totalUsage.promptTokens = Math.max(totalUsage.promptTokens, chunk.usage.promptTokens)
      totalUsage.completionTokens = Math.max(
        totalUsage.completionTokens,
        chunk.usage.completionTokens,
      )
      if (chunk.usage.promptTokens > 0) lastKnownPromptTokens = chunk.usage.promptTokens
    }

    if (signal?.aborted) {
      return {
        textContent,
        reasoningContent,
        toolCalls: Array.from(pendingToolCalls.values()),
        hasToolCalls,
        totalUsage,
        lastKnownPromptTokens,
        lastError,
        citations,
        aborted: true,
      }
    }

    switch (chunk.type) {
      case 'text':
        if (chunk.delta) {
          textContent += chunk.delta
          emit({ type: 'text', content: chunk.delta })
        }
        break

      case 'reasoning':
        if (chunk.delta) {
          reasoningContent += chunk.delta
          emit({ type: 'reasoning', content: chunk.delta })
        }
        break

      case 'tool_call_start':
        if (chunk.toolCall?.index !== undefined) {
          hasToolCalls = true
          const tc: ToolCall = {
            id: chunk.toolCall.id ?? `tc-${Date.now()}-${chunk.toolCall.index}`,
            name: chunk.toolCall.name ?? '',
            arguments: {},
          }
          if (chunk.toolCall.thoughtSignature) {
            tc.thoughtSignature = chunk.toolCall.thoughtSignature
          }
          pendingToolCalls.set(chunk.toolCall.index, tc)
        }
        break

      case 'tool_call_delta':
        if (chunk.toolCall?.index !== undefined && chunk.delta) {
          const idx = chunk.toolCall.index
          if (pendingToolCalls.has(idx)) {
            argsDelta.set(idx, (argsDelta.get(idx) ?? '') + chunk.delta)
          }
        }
        break

      case 'tool_call_done':
        if (chunk.toolCall?.index !== undefined) {
          const idx = chunk.toolCall.index
          const tc = pendingToolCalls.get(idx)
          const rawArgs = argsDelta.get(idx)
          if (tc && rawArgs) {
            try {
              tc.arguments = JSON.parse(rawArgs) as Record<string, unknown>
            } catch {
              tc.arguments = { raw: rawArgs }
            }
            argsDelta.delete(idx)
          }
        }
        break

      case 'status':
        if (chunk.delta) emit({ type: 'status', content: `🔍 ${chunk.delta}` })
        break

      case 'done':
        if (chunk.usage) {
          totalUsage.promptTokens = Math.max(totalUsage.promptTokens, chunk.usage.promptTokens)
          totalUsage.completionTokens = Math.max(
            totalUsage.completionTokens,
            chunk.usage.completionTokens,
          )
          if (chunk.usage.reasoningTokens) {
            totalUsage.reasoningTokens = chunk.usage.reasoningTokens
          }
          if (chunk.usage.cachedTokens) {
            totalUsage.cachedTokens = chunk.usage.cachedTokens
          }
        }
        if (chunk.citations) citations.push(...chunk.citations)
        break

      case 'error':
        lastError = chunk.error ?? 'Unknown provider error'
        emit({ type: 'error', content: lastError })
        break
    }
  }

  return {
    textContent,
    reasoningContent,
    toolCalls: Array.from(pendingToolCalls.values()),
    hasToolCalls,
    totalUsage,
    lastKnownPromptTokens,
    lastError,
    citations,
    aborted: false,
  }
}
