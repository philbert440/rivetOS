/**
 * Stream collection: AsyncIterable<LLMChunk> → StreamEvent emissions + state.
 *
 * Lives in core (not `@rivetos/aisdk`) because it consumes the RivetOS
 * `LLMChunk` stream — no AI SDK types involved here. The AI SDK ↔ RivetOS
 * adapter helpers (message conversion, fullStream-part translation, bridge
 * contract) all live in `@rivetos/aisdk` for both core and providers to share.
 */

import type { LLMChunk, LLMUsage, StreamEvent, ToolCall } from '@rivetos/types'

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
 * Behavior:
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
