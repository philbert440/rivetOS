/**
 * Unit tests for the shared AI SDK ↔ RivetOS adapters.
 */

import { describe, expect, it } from 'vitest'
import type { Message } from '@rivetos/types'
import {
  buildDoneChunk,
  convertMessagesToAiSdk,
  createLlmChunkAccumulator,
  extractText,
  partsToAiSdkUserContent,
  translateAiSdkPart,
} from './stream.js'

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
    const out = partsToAiSdkUserContent([{ type: 'image', mimeType: 'image/png', data: 'BASE64' }])
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
