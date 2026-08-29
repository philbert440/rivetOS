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

  it('reuses the previous message object for reference-equal turns', () => {
    const t0 = turn('user', 'hi')
    const t1 = turn('assistant', 'hel')
    const first = messagesFromHarnessTurns('s1', [t0, t1])
    // Delta splices a new tail onto the old prefix — t0 is the same object.
    const t1b = turn('assistant', 'hello there')
    const second = messagesFromHarnessTurns('s1', [t0, t1b], {
      turns: [t0, t1],
      messages: first,
    })
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1].text).toBe('hello there')
  })

  it('does not reuse across sessions or non-harness ids', () => {
    const t0 = turn('user', 'hi')
    const first = messagesFromHarnessTurns('s1', [t0])
    const other = messagesFromHarnessTurns('s2', [t0], { turns: [t0], messages: first })
    expect(other[0]).not.toBe(first[0])
    expect(other[0].id).toBe('harness:s2:0')
    // Ring-seeded rows (foreign ids) never satisfy the id check.
    const seeded = [{ ...first[0], id: 'ring:abc' }]
    const rebuilt = messagesFromHarnessTurns('s1', [t0], { turns: [t0], messages: seeded })
    expect(rebuilt[0]).not.toBe(seeded[0])
    expect(rebuilt[0].id).toBe('harness:s1:0')
  })
})
