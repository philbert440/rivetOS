/**
 * Unit tests for the LLMChunk stream collector.
 *
 * Adapter helper tests (extractText / convertMessagesToAiSdk / translateAiSdkPart
 * / buildDoneChunk) live with their implementation in `@rivetos/aisdk`.
 */

import { describe, expect, it } from 'vitest'
import type { LLMChunk, StreamEvent } from '@rivetos/types'
import { collectLlmStream } from './aisdk-stream.js'

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

describe('collectLlmStream', () => {
  it('accumulates text deltas and emits text events', async () => {
    const events: StreamEvent[] = []
    const result = await collectLlmStream(
      fromArray<LLMChunk>([
        { type: 'text', delta: 'Hel' },
        { type: 'text', delta: 'lo' },
      ]),
      (e) => events.push(e),
    )
    expect(result.textContent).toBe('Hello')
    expect(events).toEqual([
      { type: 'text', content: 'Hel' },
      { type: 'text', content: 'lo' },
    ])
  })

  it('accumulates reasoning deltas separately from text', async () => {
    const events: StreamEvent[] = []
    const result = await collectLlmStream(
      fromArray<LLMChunk>([
        { type: 'reasoning', delta: 'thinking…' },
        { type: 'text', delta: 'answer' },
      ]),
      (e) => events.push(e),
    )
    expect(result.reasoningContent).toBe('thinking…')
    expect(result.textContent).toBe('answer')
    expect(events.map((e) => e.type)).toEqual(['reasoning', 'text'])
  })

  it('skips empty text/reasoning deltas without emitting', async () => {
    const events: StreamEvent[] = []
    const result = await collectLlmStream(
      fromArray<LLMChunk>([
        { type: 'text', delta: '' },
        { type: 'reasoning', delta: '' },
      ]),
      (e) => events.push(e),
    )
    expect(events).toHaveLength(0)
    expect(result.textContent).toBe('')
  })

  it('builds tool calls from start/delta/done sequence with parsed JSON args', async () => {
    const result = await collectLlmStream(
      fromArray<LLMChunk>([
        { type: 'tool_call_start', toolCall: { index: 0, id: 'call-1', name: 'do_thing' } },
        { type: 'tool_call_delta', toolCall: { index: 0 }, delta: '{"x":' },
        { type: 'tool_call_delta', toolCall: { index: 0 }, delta: '42}' },
        { type: 'tool_call_done', toolCall: { index: 0 } },
      ]),
      () => {},
    )
    expect(result.hasToolCalls).toBe(true)
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'do_thing', arguments: { x: 42 } }])
  })

  it('falls back to {raw} when accumulated tool args are not valid JSON', async () => {
    const result = await collectLlmStream(
      fromArray<LLMChunk>([
        { type: 'tool_call_start', toolCall: { index: 0, id: 'call-1', name: 'do' } },
        { type: 'tool_call_delta', toolCall: { index: 0 }, delta: 'not-json' },
        { type: 'tool_call_done', toolCall: { index: 0 } },
      ]),
      () => {},
    )
    expect(result.toolCalls[0]!.arguments).toEqual({ raw: 'not-json' })
  })

  it('synthesizes a tool call id when none is provided', async () => {
    const result = await collectLlmStream(
      fromArray<LLMChunk>([{ type: 'tool_call_start', toolCall: { index: 0, name: 'do' } }]),
      () => {},
    )
    expect(result.toolCalls[0]!.id).toMatch(/^tc-\d+-0$/)
  })

  it('preserves thoughtSignature on tool calls when present', async () => {
    const result = await collectLlmStream(
      fromArray<LLMChunk>([
        {
          type: 'tool_call_start',
          toolCall: { index: 0, id: 'call-1', name: 'do', thoughtSignature: 'sig' },
        },
      ]),
      () => {},
    )
    expect(result.toolCalls[0]!.thoughtSignature).toBe('sig')
  })

  it('handles multiple parallel tool calls by index', async () => {
    const result = await collectLlmStream(
      fromArray<LLMChunk>([
        { type: 'tool_call_start', toolCall: { index: 0, id: 'a', name: 'fn_a' } },
        { type: 'tool_call_start', toolCall: { index: 1, id: 'b', name: 'fn_b' } },
        { type: 'tool_call_delta', toolCall: { index: 1 }, delta: '{"y":1}' },
        { type: 'tool_call_delta', toolCall: { index: 0 }, delta: '{"x":2}' },
        { type: 'tool_call_done', toolCall: { index: 0 } },
        { type: 'tool_call_done', toolCall: { index: 1 } },
      ]),
      () => {},
    )
    expect(result.toolCalls).toEqual([
      { id: 'a', name: 'fn_a', arguments: { x: 2 } },
      { id: 'b', name: 'fn_b', arguments: { y: 1 } },
    ])
  })

  it('emits status events with the search emoji prefix', async () => {
    const events: StreamEvent[] = []
    await collectLlmStream(fromArray<LLMChunk>([{ type: 'status', delta: 'searching' }]), (e) =>
      events.push(e),
    )
    expect(events).toEqual([{ type: 'status', content: '🔍 searching' }])
  })

  it('captures usage from any chunk and max-merges across the stream', async () => {
    const result = await collectLlmStream(
      fromArray<LLMChunk>([
        { type: 'text', delta: 'a', usage: { promptTokens: 100, completionTokens: 5 } },
        { type: 'text', delta: 'b', usage: { promptTokens: 80, completionTokens: 8 } },
      ]),
      () => {},
    )
    expect(result.totalUsage.promptTokens).toBe(100)
    expect(result.totalUsage.completionTokens).toBe(8)
    expect(result.lastKnownPromptTokens).toBe(80)
  })

  it('merges done chunk usage including reasoningTokens and cachedTokens', async () => {
    const result = await collectLlmStream(
      fromArray<LLMChunk>([
        {
          type: 'done',
          usage: {
            promptTokens: 50,
            completionTokens: 20,
            reasoningTokens: 10,
            cachedTokens: 30,
          },
        },
      ]),
      () => {},
    )
    expect(result.totalUsage).toEqual({
      promptTokens: 50,
      completionTokens: 20,
      reasoningTokens: 10,
      cachedTokens: 30,
    })
  })

  it('captures done-chunk citations', async () => {
    const result = await collectLlmStream(
      fromArray<LLMChunk>([{ type: 'done', citations: ['https://a.com', 'https://b.com'] }]),
      () => {},
    )
    expect(result.citations).toEqual(['https://a.com', 'https://b.com'])
  })

  it('emits error events and stores lastError', async () => {
    const events: StreamEvent[] = []
    const result = await collectLlmStream(
      fromArray<LLMChunk>([{ type: 'error', error: 'boom' }]),
      (e) => events.push(e),
    )
    expect(result.lastError).toBe('boom')
    expect(events).toEqual([{ type: 'error', content: 'boom' }])
  })

  it('uses fallback message when error chunk has no error string', async () => {
    const result = await collectLlmStream(fromArray<LLMChunk>([{ type: 'error' }]), () => {})
    expect(result.lastError).toBe('Unknown provider error')
  })

  it('returns aborted=true when signal fires mid-stream', async () => {
    const controller = new AbortController()
    const events: StreamEvent[] = []
    async function* gen(): AsyncIterable<LLMChunk> {
      yield { type: 'text', delta: 'partial' }
      controller.abort()
      yield { type: 'text', delta: 'after-abort' }
    }
    const result = await collectLlmStream(gen(), (e) => events.push(e), controller.signal)
    expect(result.aborted).toBe(true)
    expect(result.textContent).toBe('partial')
    expect(events).toEqual([{ type: 'text', content: 'partial' }])
  })

  it('ignores tool_call_delta for unknown indices', async () => {
    const result = await collectLlmStream(
      fromArray<LLMChunk>([{ type: 'tool_call_delta', toolCall: { index: 99 }, delta: 'x' }]),
      () => {},
    )
    expect(result.toolCalls).toEqual([])
  })

  it('produces an empty result for an empty stream', async () => {
    const events: StreamEvent[] = []
    const result = await collectLlmStream(fromArray<LLMChunk>([]), (e) => events.push(e))
    expect(events).toHaveLength(0)
    expect(result.textContent).toBe('')
    expect(result.toolCalls).toEqual([])
    expect(result.hasToolCalls).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.lastError).toBeNull()
  })
})
