import { expect, it, vi, afterEach } from 'vitest'
import {
  contentHashEventId,
  messagesFromHookPayload,
  parseWireJsonl,
} from '../src/kimi-memory-capture.js'

afterEach(() => vi.useRealTimers())

it.each(['message_id', 'event_id', 'tool_call_id', 'timestamp'])(
  'uses stable payload %s and preserves retry identity',
  (key) => {
    const first = { prompt: 'continue', [key]: 'first' }
    const second = { prompt: 'continue', [key]: 'second' }
    const id = (payload: Record<string, unknown>) =>
      messagesFromHookPayload('UserPromptSubmit', 'sid', payload)[0].eventId
    expect(id(first)).not.toBe(id(second))
    expect(id(first)).toBe(id(first))
  },
)

it('keeps legacy identity without a native discriminator even across retry times', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01'))
  const first = messagesFromHookPayload('UserPromptSubmit', 'sid', { prompt: 'continue' })[0]
  vi.setSystemTime(new Date('2026-02-01'))
  const retry = messagesFromHookPayload('UserPromptSubmit', 'sid', { prompt: 'continue' })[0]
  expect(first.eventTs).not.toBe(retry.eventTs)
  expect(first.eventId).toBe(retry.eventId)
  expect(first.eventId).toBe(
    contentHashEventId({
      sessionId: 'sid',
      role: 'user',
      content: 'continue',
      sourceEvent: 'UserPromptSubmit',
    }),
  )
})

it('distinguishes tool arguments with the same tool and result', () => {
  const row = (command: string) =>
    messagesFromHookPayload('PostToolUse', 'sid', {
      tool_name: 'shell',
      tool_input: { command },
      tool_output: 'ok',
    })[0]
  expect(row('pwd').eventId).not.toBe(row('ls').eventId)
  expect(row('pwd').eventId).toBe(row('pwd').eventId)
})

it('counts wire tuple occurrences from the top and keeps replay and append identities stable', () => {
  const line = (text: string) =>
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1000,
      event: { type: 'content.part', uuid: 'uuid', part: { type: 'text', text } },
    }) + '\n'
  const text = line('hello') + line('different') + line('hello')
  const ids = (input: string) => parseWireJsonl(input, 'sid').map((m) => m.eventId)
  const original = ids(text)
  expect(new Set(original).size).toBe(3)
  expect(ids(text)).toEqual(original)
  expect(ids(text + line('hello')).slice(0, 3)).toEqual(original)
  expect(ids(text + line('hello'))[3]).not.toBe(original[2])
  expect(original[0]).toBe(
    contentHashEventId({
      sessionId: 'sid',
      role: 'assistant',
      content: 'hello',
      sourceEvent: 'wire:content.part:uuid',
    }),
  )
})
