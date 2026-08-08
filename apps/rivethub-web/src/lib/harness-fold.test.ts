import { describe, it, expect } from 'vitest'
import type { HarnessEvent, SessionId } from '@rivetos/types'
import { foldHarnessEvent, isApprovalEvent } from './harness-fold.js'
import type { LiveTurn } from './fold-stream.js'

const SID = 'claude-code:a1b2c3d4-1111-4222-8333-444455556666' as SessionId

const ev = (e: HarnessEvent): HarnessEvent => e

describe('foldHarnessEvent', () => {
  it('accumulates assistant deltas', () => {
    let t: LiveTurn | undefined
    t = foldHarnessEvent(t, ev({ type: 'assistant-delta', sessionId: SID, text: 'Hel' }))
    t = foldHarnessEvent(t, ev({ type: 'assistant-delta', sessionId: SID, text: 'lo' }))
    expect(t?.text).toBe('Hello')
    expect(t?.reasoning).toBe(false)
  })

  it('pairs tool-result to its own tool-use by toolCallId, not by name', () => {
    let t: LiveTurn | undefined
    t = foldHarnessEvent(
      t,
      ev({
        type: 'tool-use',
        sessionId: SID,
        toolCallId: 't1',
        name: 'Bash',
        input: { command: 'ls' },
      }),
    )
    t = foldHarnessEvent(
      t,
      ev({ type: 'tool-use', sessionId: SID, toolCallId: 't2', name: 'Bash', input: {} }),
    )
    // Out-of-order completion: the FIRST call finishes last.
    t = foldHarnessEvent(
      t,
      ev({ type: 'tool-result', sessionId: SID, toolCallId: 't2', name: 'Bash', output: null }),
    )
    expect(t?.tools.map((x) => x.status)).toEqual(['running', 'done'])
    t = foldHarnessEvent(
      t,
      ev({
        type: 'tool-result',
        sessionId: SID,
        toolCallId: 't1',
        name: 'Bash',
        output: null,
        isError: true,
      }),
    )
    expect(t?.tools.map((x) => x.status)).toEqual(['error', 'done'])
    expect(t?.tools[0].title).toBe('Ran: ls')
  })

  it('appends a done entry for a result whose tool-use predates the attach', () => {
    // At-most-once live tail: attaching mid-turn means the tool-use half is
    // simply gone — the result must still render.
    const t = foldHarnessEvent(
      undefined,
      ev({ type: 'tool-result', sessionId: SID, toolCallId: 'orphan', name: 'Read', output: null }),
    )
    expect(t?.tools).toHaveLength(1)
    expect(t?.tools[0].status).toBe('done')
  })

  it('clears the slot on turn-complete and on a session that ended', () => {
    const base = foldHarnessEvent(
      undefined,
      ev({ type: 'assistant-delta', sessionId: SID, text: 'hi' }),
    )
    expect(foldHarnessEvent(base, ev({ type: 'turn-complete', sessionId: SID }))).toBeUndefined()
    expect(
      foldHarnessEvent(base, ev({ type: 'session-updated', sessionId: SID, status: 'ended' })),
    ).toBeUndefined()
    // idle is a normal between-turns transition — it keeps whatever is showing
    expect(
      foldHarnessEvent(base, ev({ type: 'session-updated', sessionId: SID, status: 'idle' })),
    ).toBe(base)
  })

  it('surfaces an error as the activity line without dropping the turn', () => {
    const t = foldHarnessEvent(
      foldHarnessEvent(undefined, ev({ type: 'assistant-delta', sessionId: SID, text: 'partial' })),
      ev({ type: 'error', sessionId: SID, code: 'boom', message: 'exploded' }),
    )
    expect(t?.text).toBe('partial')
    expect(t?.activity).toBe('⚠ exploded')
  })

  it('leaves the turn untouched for non-turn events', () => {
    const approval = ev({
      type: 'approval-request',
      sessionId: SID,
      requestId: 'r1',
      name: 'Bash',
      input: {},
    })
    expect(foldHarnessEvent(undefined, approval)).toBeUndefined()
    expect(isApprovalEvent(approval)).toBe(true)
    expect(isApprovalEvent(ev({ type: 'turn-complete', sessionId: SID }))).toBe(false)
  })
})
