import { describe, expect, it } from 'vitest'
import type { HarnessTranscriptEvent, HarnessTranscriptTurn, SessionId } from '@rivetos/types'
import { applyTranscriptEvent, emptyTranscript, resyncTranscript } from './session-transcript.js'

const SID = 'claude-code:abc' as SessionId

function turn(text: string, role: 'user' | 'assistant' = 'user'): HarnessTranscriptTurn {
  return { role, text } as HarnessTranscriptTurn
}

function frame(
  rev: number,
  from: number,
  turns: HarnessTranscriptTurn[],
  total: number,
  extra: Partial<HarnessTranscriptEvent> = {},
): HarnessTranscriptEvent {
  return {
    type: 'transcript',
    sessionId: SID,
    rev,
    from,
    total,
    turns,
    command: 'claude',
    ...extra,
  }
}

describe('applyTranscriptEvent', () => {
  it('applies a snapshot then consecutive deltas without asking for sync', () => {
    let t = applyTranscriptEvent(
      emptyTranscript(),
      frame(1, 0, [turn('a'), turn('b', 'assistant')], 2),
    )
    expect(t).not.toBeNull()
    t = applyTranscriptEvent(t!, frame(2, 2, [turn('c')], 3))
    expect(t?.turns.map((x) => x.text)).toEqual(['a', 'b', 'c'])
    // in-place rewrite of the trailing (streaming) turn
    t = applyTranscriptEvent(t!, frame(3, 2, [turn('c+', 'assistant')], 3))
    expect(t?.turns.map((x) => x.text)).toEqual(['a', 'b', 'c+'])
    expect(t?.rev).toBe(3)
  })

  it('reports a rev gap', () => {
    const t = applyTranscriptEvent(emptyTranscript(), frame(1, 0, [turn('a')], 1))!
    expect(applyTranscriptEvent(t, frame(3, 1, [turn('b')], 2))).toBeNull()
  })

  it('reports a splice past the end and a total mismatch', () => {
    const t = applyTranscriptEvent(emptyTranscript(), frame(1, 0, [turn('a')], 1))!
    expect(applyTranscriptEvent(t, frame(2, 3, [turn('b')], 4))).toBeNull()
    expect(applyTranscriptEvent(t, frame(2, 1, [turn('b')], 5))).toBeNull()
  })

  it('needs one sync after an HTTP resync, then the snapshot re-seeds rev', () => {
    const http = resyncTranscript([turn('a')])
    expect(applyTranscriptEvent(http, frame(7, 1, [turn('b')], 2))).toBeNull()
    const snap = applyTranscriptEvent(http, frame(8, 0, [turn('a'), turn('b')], 2))!
    expect(applyTranscriptEvent(snap, frame(9, 2, [turn('c')], 3))?.turns).toHaveLength(3)
  })

  it('pins earlier turns under a truncated tail snapshot and offsets deltas', () => {
    const full = applyTranscriptEvent(
      emptyTranscript(),
      frame(1, 0, [turn('a'), turn('b'), turn('c')], 3),
    )!
    const tail = applyTranscriptEvent(
      full,
      frame(2, 0, [turn('b'), turn('c')], 2, { truncatedBefore: true }),
    )!
    expect(tail.turns.map((x) => x.text)).toEqual(['a', 'b', 'c'])
    expect(tail.offset).toBe(1)
    const next = applyTranscriptEvent(tail, frame(3, 2, [turn('d')], 3))
    expect(next?.turns.map((x) => x.text)).toEqual(['a', 'b', 'c', 'd'])
  })
})
