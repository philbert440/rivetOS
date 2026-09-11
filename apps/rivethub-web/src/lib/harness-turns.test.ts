import { describe, expect, it } from 'vitest'
import type { HarnessStatusFrame, HarnessTranscriptTurn, SessionId } from '@rivetos/types'
import {
  agentStatusLine,
  isLiveTurnCommand,
  liveFromTranscript,
  messagesFromHarnessTurns,
} from './harness-turns.js'

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

  it('skips the trailing live turn when asked', () => {
    const msgs = messagesFromHarnessTurns(
      's1',
      [turn('user', 'hi'), turn('assistant', 'partial')],
      undefined,
      true,
    )
    expect(msgs).toHaveLength(1)
    expect(msgs[0].text).toBe('hi')
  })
})

describe('isLiveTurnCommand', () => {
  it('treats claude/kimi/opencode/pi/grok/hermes/codex as live-turn stores', () => {
    expect(isLiveTurnCommand('claude')).toBe(true)
    expect(isLiveTurnCommand('kimi-code')).toBe(true)
    expect(isLiveTurnCommand('opencode')).toBe(true)
    expect(isLiveTurnCommand('pi')).toBe(true)
    expect(isLiveTurnCommand('grok')).toBe(true)
    expect(isLiveTurnCommand('hermes')).toBe(true)
    expect(isLiveTurnCommand('codex')).toBe(true)
    expect(isLiveTurnCommand('shell')).toBe(false)
    expect(isLiveTurnCommand('')).toBe(false)
  })
})

describe('liveFromTranscript', () => {
  const SID = 'claude-code:a1b2c3d4-1111-4222-8333-444455556666' as SessionId
  const working: HarnessStatusFrame = {
    type: 'status',
    sessionId: SID,
    status: 'working',
    since: 1,
    phase: 'thinking',
  }

  it('builds live from a trailing incomplete assistant while working', () => {
    const live = liveFromTranscript(
      [
        turn('user', 'hi'),
        {
          role: 'assistant',
          text: 'partial',
          thinking: 'plan',
          lastBlock: 'text',
          tools: [{ name: 'Bash', status: 'running', id: 't1' }],
        },
      ],
      working,
    )
    expect(live?.text).toBe('partial')
    expect(live?.reasoningText).toBe('plan')
    expect(live?.tools).toEqual([
      expect.objectContaining({ id: 't1', name: 'Bash', status: 'running' }),
    ])
    expect(live?.activity).toBe('thinking…')
  })

  it('returns undefined on idle, complete, or a trailing user turn', () => {
    const incomplete: HarnessTranscriptTurn = { role: 'assistant', text: 'partial' }
    expect(liveFromTranscript([incomplete], { ...working, status: 'idle' })).toBeUndefined()
    expect(
      liveFromTranscript([{ ...incomplete, complete: true }], working),
    ).toBeUndefined()
    expect(liveFromTranscript([turn('user', 'hi')], working)).toBeUndefined()
  })
})

describe('agentStatusLine (the thinking window is never silent)', () => {
  const st = (extra: Record<string, unknown>) =>
    ({ type: 'status', sessionId: 's', since: 1, ...extra }) as unknown as import('@rivetos/types').HarnessStatusFrame
  it('shows the activity while working with no live bubble yet', () => {
    expect(agentStatusLine(undefined, st({ status: 'working', phase: 'thinking' }))?.text).toBe('thinking…')
    expect(agentStatusLine(undefined, st({ status: 'working', phase: 'tool', tool: { name: 'Bash' } }))).toMatchObject({
      tool: 'Bash',
    })
  })
  it('says waiting for you when blocked or on a prompt; nothing when idle or a live bubble exists', () => {
    expect(agentStatusLine(undefined, st({ status: 'blocked' }))?.text).toBe('waiting for you')
    expect(agentStatusLine(undefined, st({ status: 'working', phase: 'prompt' }))?.text).toBe('waiting for you')
    expect(agentStatusLine(undefined, st({ status: 'idle' }))).toBeUndefined()
    const live = { text: 'x', reasoning: false, reasoningText: '', tools: [] }
    expect(agentStatusLine(live, st({ status: 'working' }))).toBeUndefined()
  })
})
