import { describe, expect, it } from 'vitest'
import type { HarnessTranscriptTurn } from '@rivetos/types'
import { messagesFromHarnessTurns } from './harness-turns.js'

const turn = (role: 'user' | 'assistant', text: string): HarnessTranscriptTurn => ({ role, text })

describe('messagesFromHarnessTurns', () => {
  it('maps turns onto index-stable ids', () => {
    const msgs = messagesFromHarnessTurns('s1', [turn('user', 'hi'), turn('assistant', 'hello')])
    expect(msgs.map((m) => m.id)).toEqual(['harness:s1:0', 'harness:s1:1'])
    expect(msgs[1]).toMatchObject({ role: 'assistant', text: 'hello', ts: 2 })
  })

  it('reuses the previous message when the turn is unchanged (spliced delta)', () => {
    const t0 = turn('user', 'hi')
    const t1 = turn('assistant', 'hel')
    const first = messagesFromHarnessTurns('s1', [t0, t1])
    const second = messagesFromHarnessTurns('s1', [t0, turn('assistant', 'hello there')], first)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1].text).toBe('hello there')
  })

  it('reuses across a hard resync where fields match on fresh objects', () => {
    const first = messagesFromHarnessTurns('s1', [turn('user', 'hi')])
    const second = messagesFromHarnessTurns('s1', [turn('user', 'hi')], first)
    expect(second[0]).toBe(first[0])
  })

  it('does NOT reuse when a turn object was mutated in place', () => {
    const t0 = turn('assistant', 'partial')
    const first = messagesFromHarnessTurns('s1', [t0])
    t0.text = 'partial plus more streamed text'
    const second = messagesFromHarnessTurns('s1', [t0], first)
    expect(second[0]).not.toBe(first[0])
    expect(second[0].text).toBe('partial plus more streamed text')
  })

  it('does NOT reuse when a tool status or usage mutates in place', () => {
    const t0: HarnessTranscriptTurn = {
      role: 'assistant',
      text: 'working',
      tools: [{ name: 'Bash', status: 'running', args: { cmd: 'ls' } }],
      usage: { promptTokens: 10, completionTokens: 1, cachedTokens: 0 },
    }
    const first = messagesFromHarnessTurns('s1', [t0])
    t0.tools![0].status = 'done'
    const second = messagesFromHarnessTurns('s1', [t0], first)
    expect(second[0]).not.toBe(first[0])
    expect(second[0].tools?.[0].status).toBe('done')

    const third = messagesFromHarnessTurns('s1', [t0], second)
    expect(third[0]).toBe(second[0])
    t0.usage!.completionTokens = 99
    const fourth = messagesFromHarnessTurns('s1', [t0], third)
    expect(fourth[0]).not.toBe(third[0])
    expect(fourth[0].usage?.completionTokens).toBe(99)
  })

  it('does NOT reuse when thinking/tools arrive on a new object at the same index', () => {
    const first = messagesFromHarnessTurns('s1', [turn('assistant', 'hi')])
    const withThinking: HarnessTranscriptTurn = { role: 'assistant', text: 'hi', thinking: 'why' }
    const second = messagesFromHarnessTurns('s1', [withThinking], first)
    expect(second[0]).not.toBe(first[0])
    expect(second[0].thinking).toBe('why')
  })

  it('handles prev shorter and longer than the new turn list', () => {
    const t0 = turn('user', 'a')
    const t1 = turn('assistant', 'b')
    const short = messagesFromHarnessTurns('s1', [t0])
    const grown = messagesFromHarnessTurns('s1', [t0, t1], short)
    expect(grown[0]).toBe(short[0])
    expect(grown).toHaveLength(2)
    const shrunk = messagesFromHarnessTurns('s1', [t0], grown)
    expect(shrunk).toHaveLength(1)
    expect(shrunk[0]).toBe(short[0])
  })

  it('does not reuse across sessions or non-harness ids', () => {
    const t0 = turn('user', 'hi')
    const first = messagesFromHarnessTurns('s1', [t0])
    const other = messagesFromHarnessTurns('s2', [t0], first)
    expect(other[0]).not.toBe(first[0])
    expect(other[0].id).toBe('harness:s2:0')
    // Ring-seeded / optimistic rows (foreign ids) never satisfy the id check.
    const seeded = [{ ...first[0], id: 'ring:abc' }]
    const rebuilt = messagesFromHarnessTurns('s1', [t0], seeded)
    expect(rebuilt[0]).not.toBe(seeded[0])
    expect(rebuilt[0].id).toBe('harness:s1:0')
  })
})
