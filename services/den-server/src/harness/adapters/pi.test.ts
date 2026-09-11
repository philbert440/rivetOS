import { describe, expect, it } from 'vitest'
import { piTurnsFromLines } from './pi.js'

describe('piTurnsFromLines', () => {
  it('completes tools from a separate toolResult message and reads real usage keys', () => {
    const turns = piTurnsFromLines([
      {
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'ls' }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'Bash_0', name: 'Bash', arguments: { command: 'ls' } }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'Bash_0',
          toolName: 'Bash',
          content: [{ type: 'text', text: 'a\nb\n' }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          usage: { input: 1516, output: 10, cacheRead: 4, cacheWrite: 2, reasoning: 0, totalTokens: 1526 },
        },
      },
    ])
    expect(turns).toHaveLength(3)
    expect(turns[0]).toMatchObject({ role: 'user', text: 'ls' })
    expect(turns[1].tools).toEqual([
      { name: 'Bash', status: 'done', id: 'Bash_0', args: { command: 'ls' } },
    ])
    expect(turns[2]).toMatchObject({
      role: 'assistant',
      text: 'done',
      usage: { promptTokens: 1522, completionTokens: 10, cachedTokens: 6 },
    })
  })

  it('does not invent a turn for the toolResult message itself', () => {
    const turns = piTurnsFromLines([
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'x',
          toolName: 'Bash',
          content: [{ type: 'text', text: 'nope' }],
        },
      },
    ])
    expect(turns).toEqual([])
  })

  it('falls back to snake_case usage keys', () => {
    const turns = piTurnsFromLines([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 1 },
        },
      },
    ])
    expect(turns[0]?.usage).toEqual({ promptTokens: 11, completionTokens: 4, cachedTokens: 1 })
  })
})
