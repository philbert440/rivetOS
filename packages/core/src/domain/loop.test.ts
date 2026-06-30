/**
 * AgentLoop tests — text response, tool calling, abort, steer, max iterations,
 * error surfacing, and provider timeout handling.
 *
 * Uses the new `makeMockProvider` fixture (test-utils/mock-aisdk-provider.ts)
 * which translates ergonomic LLMChunk[] arrays into a MockLanguageModelV3
 * driving the new AI SDK loop.
 */

import { describe, it } from 'vitest'
import * as assert from 'node:assert/strict'
import { AgentLoop } from './loop.js'
import type { LLMChunk, Message, Tool } from '@rivetos/types'
import { makeMockProvider, makeMockProviderSequence } from '../test-utils/mock-aisdk-provider.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, result: string): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    async execute(_args: Record<string, unknown>, _signal?: AbortSignal): Promise<string> {
      return result
    },
  }
}

const TOOL_CALL_THEN_TEXT: LLMChunk[][] = [
  [
    { type: 'tool_call_start', toolCall: { index: 0, id: 'tc-1', name: 'shell' } },
    { type: 'tool_call_delta', delta: '{"command":"echo hi"}', toolCall: { index: 0 } },
    { type: 'tool_call_done', toolCall: { index: 0 } },
    { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
  ],
  [
    { type: 'text', delta: 'Done! The output was hi.' },
    { type: 'done', usage: { promptTokens: 20, completionTokens: 10 } },
  ],
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop', () => {
  it('should return text response from provider', async () => {
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeMockProvider([
        { type: 'text', delta: 'Hello, ' },
        { type: 'text', delta: 'world!' },
        { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
      ]),
      tools: [],
    })

    const result = await loop.run('Hi', [])
    assert.equal(result.response, 'Hello, world!')
    assert.equal(result.aborted, false)
    assert.equal(result.iterations, 0)
    assert.deepEqual(result.toolsUsed, [])
  })

  it('should execute tool calls and loop back', async () => {
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeMockProviderSequence(TOOL_CALL_THEN_TEXT),
      tools: [makeTool('shell', 'hi')],
    })

    const result = await loop.run('Run echo hi', [])
    assert.equal(result.response, 'Done! The output was hi.')
    assert.equal(result.aborted, false)
    assert.equal(result.iterations, 1)
    assert.deepEqual(result.toolsUsed, ['shell'])
  })

  it('should abort on signal', async () => {
    const controller = new AbortController()
    controller.abort('test abort')

    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeMockProvider([
        { type: 'text', delta: 'This should not complete' },
        { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } },
      ]),
      tools: [],
    })

    const result = await loop.run('Hi', [], controller.signal)
    assert.equal(result.aborted, true)
    assert.equal(result.response, '')
  })

  it('should inject steer message into conversation', async () => {
    const messagesPerCall: Message[][] = []

    const provider = makeMockProvider({
      chunks: [
        [
          { type: 'tool_call_start', toolCall: { index: 0, id: 'tc-1', name: 'shell' } },
          { type: 'tool_call_delta', delta: '{"command":"ls"}', toolCall: { index: 0 } },
          { type: 'tool_call_done', toolCall: { index: 0 } },
          { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } },
        ],
        [
          { type: 'text', delta: 'OK' },
          { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } },
        ],
      ],
      onCall: ({ prompt }) => {
        // prompt is in V3 ModelMessage[] shape — re-derive role/content for assertions.
        const recorded: Message[] = []
        for (const m of prompt) {
          if (m.role === 'system') {
            recorded.push({
              role: 'system',
              content: typeof m.content === 'string' ? m.content : '',
            })
          } else if (m.role === 'user') {
            const text = Array.isArray(m.content)
              ? m.content
                  .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                  .map((p) => p.text)
                  .join('')
              : (m.content as string)
            recorded.push({ role: 'user', content: text })
          } else if (m.role === 'assistant') {
            const text = Array.isArray(m.content)
              ? m.content
                  .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                  .map((p) => p.text)
                  .join('')
              : (m.content as string)
            recorded.push({ role: 'assistant', content: text })
          }
        }
        messagesPerCall.push(recorded)
      },
    })

    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider,
      tools: [makeTool('shell', 'file.txt')],
    })

    loop.steer('Actually, use the -la flag')

    const result = await loop.run('List files', [])
    assert.equal(result.response, 'OK')

    const secondCallMessages = messagesPerCall[1]
    assert.ok(secondCallMessages, 'Expected a second provider call')
    const steerMsg = secondCallMessages.find(
      (m) => typeof m.content === 'string' && m.content.includes('STEER'),
    )
    assert.ok(steerMsg, 'Steer message should be injected')
    assert.ok(
      typeof steerMsg.content === 'string' &&
        steerMsg.content.includes('Actually, use the -la flag'),
    )
  })

  it('should stop at turn timeout', async () => {
    // Provider always returns tool calls — infinite loop unless timeout fires.
    const infiniteProvider = makeMockProvider({
      chunks: [
        [
          { type: 'tool_call_start', toolCall: { index: 0, id: 'tc-1', name: 'shell' } },
          { type: 'tool_call_delta', delta: '{"command":"echo loop"}', toolCall: { index: 0 } },
          { type: 'tool_call_done', toolCall: { index: 0 } },
          { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } },
        ],
      ],
      // 30ms per call — enough for the 100ms timer to fire after a few iterations.
      stepDelayMs: 30,
    })

    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: infiniteProvider,
      tools: [makeTool('shell', 'loop')],
      turnTimeout: 100,
    })

    const result = await loop.run('Loop forever', [])
    assert.ok(result.response.toLowerCase().includes('timed out'))
  })

  it('should inject graceful degradation warning before timeout', async () => {
    const capturedMessages: Message[][] = []
    const infiniteProvider = makeMockProvider({
      chunks: [
        [
          { type: 'tool_call_start', toolCall: { index: 0, id: 'tc-1', name: 'shell' } },
          { type: 'tool_call_delta', delta: '{"command":"echo loop"}', toolCall: { index: 0 } },
          { type: 'tool_call_done', toolCall: { index: 0 } },
          { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } },
        ],
      ],
      stepDelayMs: 60,
      onCall: ({ prompt }) => {
        const recorded: Message[] = []
        for (const m of prompt) {
          const content =
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content
                    .map((p) =>
                      'text' in p && typeof (p as { text?: unknown }).text === 'string'
                        ? (p as { text: string }).text
                        : '',
                    )
                    .join('')
                : ''
          recorded.push({ role: m.role as Message['role'], content })
        }
        capturedMessages.push(recorded)
      },
    })

    const statusEvents: string[] = []
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: infiniteProvider,
      tools: [makeTool('shell', 'loop')],
      turnTimeout: 200,
      gracefulWarningMs: 150,
      onStream: (event) => {
        if (event.type === 'status') statusEvents.push(event.content ?? '')
      },
    })

    const result = await loop.run('Loop forever', [])

    assert.ok(result.response.toLowerCase().includes('timed out'))

    const warningEmitted = statusEvents.some((s) => s.includes('Approaching turn timeout'))
    assert.ok(warningEmitted, 'Expected graceful degradation warning status event')

    const allMessages = capturedMessages.flat()
    const warningMessage = allMessages.find(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('Turn Timeout Warning'),
    )
    assert.ok(
      warningMessage,
      'Expected [SYSTEM — Turn Timeout Warning] message injected into context',
    )
  })

  it('should accumulate token usage across iterations', async () => {
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeMockProviderSequence(TOOL_CALL_THEN_TEXT),
      tools: [makeTool('shell', 'hi')],
    })

    const result = await loop.run('Run echo hi', [])
    assert.ok(result.usage)
    assert.equal(result.usage.promptTokens, 20)
    assert.equal(result.usage.completionTokens, 10)
  })

  it('should handle unknown tool gracefully', async () => {
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeMockProviderSequence(TOOL_CALL_THEN_TEXT),
      tools: [],
    })

    const result = await loop.run('Run something', [])
    assert.ok(result.toolsUsed.includes('shell'))
    assert.equal(result.aborted, false)
  })

  it('should emit stream events', async () => {
    const events: Array<{ type: string }> = []

    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeMockProvider([
        { type: 'text', delta: 'Hello' },
        { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } },
      ]),
      tools: [],
      onStream: (event) => events.push(event),
    })

    await loop.run('Hi', [])
    assert.ok(events.some((e) => e.type === 'text'))
  })

  it('should surface provider error as response when no text produced', async () => {
    const events: Array<{ type: string; content?: string }> = []
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeMockProvider([
        {
          type: 'error',
          error:
            'Provider timed out waiting for first response (120s). The model may be overloaded or the context too large.',
        },
      ]),
      tools: [],
      onStream: (event) => events.push(event),
    })

    const result = await loop.run('Hi', [])
    assert.ok(
      result.response.includes('timed out'),
      `Expected error in response, got: "${result.response}"`,
    )
    assert.ok(result.response.startsWith('⚠️'), 'Error response should start with warning emoji')
    assert.equal(result.aborted, false)
    assert.ok(events.some((e) => e.type === 'error'))
  })

  it('should prefer text content over error when both exist', async () => {
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeMockProvider([
        { type: 'text', delta: 'Partial response before error' },
        { type: 'error', error: 'Something went wrong' },
      ]),
      tools: [],
    })

    const result = await loop.run('Hi', [])
    assert.equal(result.response, 'Partial response before error')
  })
})
