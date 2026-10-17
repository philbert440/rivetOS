import { describe, expect, it } from 'vitest'
import type { HarnessEvent, HarnessSessionSummary, SessionId } from '@rivetos/types'
import { chatItems } from './harness-chat.js'
import { sessionListRows } from './session-list.js'
import { StatusBlocks, withStatusBlocks } from './status-blocks.js'

const SID = 'grok-build:a1b2c3d4-1111-4222-8333-444455556666' as SessionId
const SID_NEXT = 'grok-build:b2c3d4e5-2222-4333-8444-555566667777' as SessionId

function status(
  s: 'working' | 'blocked' | 'idle',
  source?: 'herdr' | 'transcript' | 'hooks' | 'protocol',
  sessionId: SessionId = SID,
): HarnessEvent {
  return { type: 'status', sessionId, status: s, since: 1, ...(source ? { source } : {}) }
}

function summary(partial: Partial<HarnessSessionSummary> = {}): HarnessSessionSummary {
  return {
    sessionId: SID,
    harnessId: 'grok-build',
    title: 't',
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T12:00:00.000Z',
    status: 'active',
    ...partial,
  }
}

describe('StatusBlocks', () => {
  it('blocks on a status frame and clears when that source leaves blocked', () => {
    const b = new StatusBlocks()
    expect(b.observe(status('blocked', 'protocol'))).toBe(true)
    expect(b.isBlocked(SID)).toBe(true)
    expect(b.observe(status('working', 'protocol'))).toBe(true)
    expect(b.isBlocked(SID)).toBe(false)
    expect(b.isEmpty).toBe(true)
  })

  it('keeps a protocol block through another source going working', () => {
    const b = new StatusBlocks()
    b.observe(status('blocked', 'protocol'))
    expect(b.observe(status('working', 'transcript'))).toBe(false)
    expect(b.isBlocked(SID)).toBe(true)
    b.observe(status('idle', 'protocol'))
    expect(b.isBlocked(SID)).toBe(false)
  })

  it('treats a missing source as its own key', () => {
    const b = new StatusBlocks()
    b.observe(status('blocked'))
    b.observe(status('idle', 'protocol'))
    expect(b.isBlocked(SID)).toBe(true)
    b.observe(status('idle'))
    expect(b.isBlocked(SID)).toBe(false)
  })

  it('follows a rekey and drops on session end', () => {
    const b = new StatusBlocks()
    b.observe(status('blocked', 'protocol'))
    expect(
      b.observe({
        type: 'session-updated',
        sessionId: SID_NEXT,
        previousSessionId: SID,
        status: 'active',
      }),
    ).toBe(true)
    expect(b.isBlocked(SID)).toBe(false)
    expect(b.isBlocked(SID_NEXT)).toBe(true)
    expect(b.observe({ type: 'session-updated', sessionId: SID_NEXT, status: 'ended' })).toBe(true)
    expect(b.isBlocked(SID_NEXT)).toBe(false)
  })

  it('ignores a non-ending session-updated', () => {
    const b = new StatusBlocks()
    b.observe(status('blocked', 'protocol'))
    expect(b.observe({ type: 'session-updated', sessionId: SID, status: 'idle' })).toBe(false)
    expect(b.isBlocked(SID)).toBe(true)
  })

  it('clear() (registry reconnect) drops every block', () => {
    const b = new StatusBlocks()
    expect(b.clear()).toBe(false)
    b.observe(status('blocked', 'protocol'))
    expect(b.clear()).toBe(true)
    expect(b.isBlocked(SID)).toBe(false)
  })
})

describe('withStatusBlocks', () => {
  it('marks a status-blocked summary blocked, leaving the input untouched', () => {
    const b = new StatusBlocks()
    b.observe(status('blocked', 'protocol'))
    const input = [summary()]
    const out = withStatusBlocks(input, b)
    expect(out?.[0]?.blocked).toBe(true)
    expect(input[0]?.blocked).toBeUndefined()
  })

  it('does not mark an ended summary', () => {
    const b = new StatusBlocks()
    b.observe(status('blocked', 'protocol'))
    expect(withStatusBlocks([summary({ status: 'ended' })], b)?.[0]?.blocked).toBeUndefined()
  })

  it('returns the same array when nothing is blocked', () => {
    const input = [summary()]
    expect(withStatusBlocks(input, new StatusBlocks())).toBe(input)
    expect(withStatusBlocks(undefined, new StatusBlocks())).toBeUndefined()
  })

  it('surfaces an ACP session as blocked in the session list, then clears', () => {
    const b = new StatusBlocks()
    const plane = [summary()]
    const rows = () =>
      sessionListRows(
        chatItems({ drafts: [], harnessSessions: plane, legacySessions: [] }),
        withStatusBlocks(plane, b) ?? [],
      )
    expect(rows()[0]?.blocked).toBeUndefined()
    b.observe(status('blocked', 'protocol'))
    expect(rows()[0]?.blocked).toBe(true)
    b.observe(status('idle', 'protocol'))
    expect(rows()[0]?.blocked).toBeUndefined()
  })
})
