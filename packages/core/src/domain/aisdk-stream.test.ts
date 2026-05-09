/**
 * Unit tests for the shared AI SDK ↔ RivetOS adapters.
 */

import { describe, expect, it } from 'vitest'
import type { LLMChunk, Message, StreamEvent } from '@rivetos/types'
import {
  buildDoneChunk,
  collectLlmStream,
  convertMessagesToAiSdk,
  createLlmChunkAccumulator,
  extractText,
  partsToAiSdkUserContent,
  translateAiSdkPart,
} from './aisdk-stream.js'

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

describe('extractText', () => {
  it('returns string content unchanged', () => {
    expect(extractText('hello')).toBe('hello')
  })

  it('joins text parts and ignores images', () => {
    expect(
      extractText([
        { type: 'text', text: 'a' },
        { type: 'image', mimeType: 'image/png', data: 'xxx' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab')
  })

  it('returns empty string for empty array', () => {
    expect(extractText([])).toBe('')
  })
})

describe('partsToAiSdkUserContent', () => {
  it('emits text parts as-is', () => {
    expect(partsToAiSdkUserContent([{ type: 'text', text: 'hi' }])).toEqual([
      { type: 'text', text: 'hi' },
    ])
  })

  it('drops empty text parts', () => {
    expect(partsToAiSdkUserContent([{ type: 'text', text: '' }])).toEqual([])
  })

  it('emits base64 image data as data URL', () => {
    const out = partsToAiSdkUserContent([
      { type: 'image', mimeType: 'image/png', data: 'BASE64' },
    ])
    expect(out).toEqual([
      { type: 'image', image: 'data:image/png;base64,BASE64', mediaType: 'image/png' },
    ])
  })

  it('defaults missing mimeType to image/jpeg', () => {
    const out = partsToAiSdkUserContent([{ type: 'image', data: 'X' }])
    expect(out[0]).toMatchObject({ image: 'data:image/jpeg;base64,X' })
  })

  it('emits image URL as URL object', () => {
    const out = partsToAiSdkUserContent([
      { type: 'image', mimeType: 'image/jpeg', url: 'https://example.com/a.jpg' },
    ])
    expect(out[0]).toMatchObject({ type: 'image', mediaType: 'image/jpeg' })
    expect((out[0] as { image: URL }).image).toBeInstanceOf(URL)
  })

  it('drops images with neither data nor url', () => {
    expect(partsToAiSdkUserContent([{ type: 'image' }])).toEqual([])
  })
})

describe('convertMessagesToAiSdk', () => {
  it('converts a simple user/assistant exchange', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    expect(convertMessagesToAiSdk(msgs)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('expands user multimodal content into AI SDK parts', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', mimeType: 'image/png', data: 'AA' },
        ],
      },
    ]
    const out = convertMessagesToAiSdk(msgs)
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('user')
    expect(Array.isArray(out[0]!.content)).toBe(true)
  })

  it('falls back to text-only when user multimodal has no usable parts', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'just text' },
          { type: 'image' },
        ],
      },
    ]
    const out = convertMessagesToAiSdk(msgs)
    expect(out[0]!.content).toBeDefined()
  })

  it('emits assistant tool-calls as content parts', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'x' } }],
      },
    ]
    const out = convertMessagesToAiSdk(msgs)
    expect(out[0]!.content).toEqual([
      { type: 'text', text: 'let me check' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'x' } },
    ])
  })

  it('parses string-encoded JSON tool-call arguments', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'f', arguments: '{"a":1}' }],
      },
    ]
    const out = convertMessagesToAiSdk(msgs)
    expect((out[0]!.content as Array<{ input?: unknown }>)[0]!.input).toEqual({ a: 1 })
  })

  it('falls back to {raw} for malformed string arguments', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'f', arguments: 'not json' }],
      },
    ]
    const out = convertMessagesToAiSdk(msgs)
    expect((out[0]!.content as Array<{ input?: unknown }>)[0]!.input).toEqual({ raw: 'not json' })
  })

  it('rebuilds toolName for tool-result messages from prior assistant turns', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: {} }],
      },
      { role: 'tool', content: 'result data', toolCallId: 'tc1' },
    ]
    const out = convertMessagesToAiSdk(msgs)
    const toolMsg = out[1] as {
      content: Array<{ type: string; toolName: string; toolCallId: string }>
    }
    expect(toolMsg.content[0]!.toolName).toBe('search')
    expect(toolMsg.content[0]!.toolCallId).toBe('tc1')
  })

  it('appends image marker to tool result text when result includes images', () => {
    const msgs: Message[] = [
      {
        role: 'tool',
        content: [
          { type: 'text', text: 'screenshot:' },
          { type: 'image', mimeType: 'image/png', data: 'X' },
        ],
        toolCallId: 'tc1',
      },
    ]
    const out = convertMessagesToAiSdk(msgs)
    const toolMsg = out[0] as {
      content: Array<{ output: { value: string } }>
    }
    expect(toolMsg.content[0]!.output.value).toContain('screenshot:')
    expect(toolMsg.content[0]!.output.value).toContain('1 image(s)')
  })

  it('drops empty assistant messages with no text and no tool calls', () => {
    const msgs: Message[] = [{ role: 'assistant', content: '' }]
    expect(convertMessagesToAiSdk(msgs)).toEqual([])
  })
})

describe('translateAiSdkPart + accumulator', () => {
  it('text-delta emits text chunk and sets hadTextContent', () => {
    const acc = createLlmChunkAccumulator()
    const chunks = translateAiSdkPart({ type: 'text-delta', text: 'hi' }, acc)
    expect(chunks).toEqual([{ type: 'text', delta: 'hi' }])
    expect(acc.hadTextContent).toBe(true)
  })

  it('empty text-delta emits nothing and does not flip hadTextContent', () => {
    const acc = createLlmChunkAccumulator()
    expect(translateAiSdkPart({ type: 'text-delta', text: '' }, acc)).toEqual([])
    expect(acc.hadTextContent).toBe(false)
  })

  it('reasoning-delta emits reasoning chunk', () => {
    const acc = createLlmChunkAccumulator()
    expect(translateAiSdkPart({ type: 'reasoning-delta', text: 'think' }, acc)).toEqual([
      { type: 'reasoning', delta: 'think' },
    ])
  })

  it('tool-input-start assigns contiguous indices', () => {
    const acc = createLlmChunkAccumulator()
    const a = translateAiSdkPart({ type: 'tool-input-start', id: 'a', toolName: 'x' }, acc)
    const b = translateAiSdkPart({ type: 'tool-input-start', id: 'b', toolName: 'y' }, acc)
    expect(a[0]!.toolCall!.index).toBe(0)
    expect(b[0]!.toolCall!.index).toBe(1)
  })

  it('tool-input-delta carries the matched index', () => {
    const acc = createLlmChunkAccumulator()
    translateAiSdkPart({ type: 'tool-input-start', id: 'a', toolName: 'x' }, acc)
    const delta = translateAiSdkPart({ type: 'tool-input-delta', id: 'a', delta: '{"k":' }, acc)
    expect(delta).toEqual([{ type: 'tool_call_delta', delta: '{"k":', toolCall: { index: 0 } }])
  })

  it('tool-input-end emits done with same index', () => {
    const acc = createLlmChunkAccumulator()
    translateAiSdkPart({ type: 'tool-input-start', id: 'a', toolName: 'x' }, acc)
    expect(translateAiSdkPart({ type: 'tool-input-end', id: 'a' }, acc)).toEqual([
      { type: 'tool_call_done', toolCall: { index: 0 } },
    ])
  })

  it('source url accumulates citations without emitting a chunk', () => {
    const acc = createLlmChunkAccumulator()
    expect(
      translateAiSdkPart({ type: 'source', sourceType: 'url', url: 'https://a.com' }, acc),
    ).toEqual([])
    expect(
      translateAiSdkPart({ type: 'source', sourceType: 'url', url: 'https://b.com' }, acc),
    ).toEqual([])
    expect(acc.citations).toEqual(['https://a.com', 'https://b.com'])
  })

  it('finish-step captures usage and response id', () => {
    const acc = createLlmChunkAccumulator()
    translateAiSdkPart(
      {
        type: 'finish-step',
        usage: {
          inputTokens: 50,
          outputTokens: 30,
          inputTokenDetails: { cacheReadTokens: 10 },
          outputTokenDetails: { reasoningTokens: 5 },
        },
        response: { id: 'resp_123' },
      },
      acc,
    )
    expect(acc.usage).toEqual({
      promptTokens: 50,
      completionTokens: 30,
      reasoningTokens: 5,
      cachedTokens: 10,
    })
    expect(acc.responseId).toBe('resp_123')
  })

  it('error part emits error chunk with normalized message', () => {
    const acc = createLlmChunkAccumulator()
    expect(translateAiSdkPart({ type: 'error', error: new Error('bad') }, acc)).toEqual([
      { type: 'error', error: 'bad' },
    ])
    expect(translateAiSdkPart({ type: 'error', error: 'plain' }, acc)).toEqual([
      { type: 'error', error: 'plain' },
    ])
  })

  it('unknown part types emit nothing', () => {
    const acc = createLlmChunkAccumulator()
    expect(translateAiSdkPart({ type: 'start' }, acc)).toEqual([])
    expect(translateAiSdkPart({ type: 'finish' }, acc)).toEqual([])
    expect(translateAiSdkPart({ type: 'tool-result' }, acc)).toEqual([])
  })
})

describe('buildDoneChunk', () => {
  it('emits done with usage', () => {
    const acc = createLlmChunkAccumulator()
    acc.usage.promptTokens = 10
    acc.usage.completionTokens = 5
    expect(buildDoneChunk(acc)).toEqual({
      type: 'done',
      usage: { promptTokens: 10, completionTokens: 5 },
    })
  })

  it('includes citations only when present', () => {
    const acc = createLlmChunkAccumulator()
    expect(buildDoneChunk(acc).citations).toBeUndefined()
    acc.citations.push('https://x.com')
    expect(buildDoneChunk(acc).citations).toEqual(['https://x.com'])
  })
})

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
    expect(result.toolCalls).toEqual([
      { id: 'call-1', name: 'do_thing', arguments: { x: 42 } },
    ])
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
      fromArray<LLMChunk>([
        { type: 'tool_call_start', toolCall: { index: 0, name: 'do' } },
      ]),
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
    await collectLlmStream(
      fromArray<LLMChunk>([{ type: 'status', delta: 'searching' }]),
      (e) => events.push(e),
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
    // lastKnownPromptTokens tracks the most recent non-zero report (matches legacy loop)
    expect(result.lastKnownPromptTokens).toBe(80)
  })

  it("merges done chunk usage including reasoningTokens and cachedTokens", async () => {
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
      fromArray<LLMChunk>([
        { type: 'done', citations: ['https://a.com', 'https://b.com'] },
      ]),
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
    const result = await collectLlmStream(
      fromArray<LLMChunk>([{ type: 'error' }]),
      () => {},
    )
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
      fromArray<LLMChunk>([
        { type: 'tool_call_delta', toolCall: { index: 99 }, delta: 'x' },
      ]),
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
