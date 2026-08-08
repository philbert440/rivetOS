import { describe, it, expect } from 'vitest'
import type {
  HarnessDescriptor,
  HarnessSession,
  HarnessSessionSummary,
  SessionId,
} from '@rivetos/types'
import {
  chatItems,
  fetchHarnessPlaneSessions,
  harnessGate,
  isTurnInFlight,
  listableHarnesses,
  nativeIdOf,
  shortNativeId,
} from './harness-chat.js'

const UUID_A = 'a1b2c3d4-1111-4222-8333-444455556666'
const UUID_B = 'b2c3d4e5-2222-4333-8444-555566667777'
const UUID_C = 'c3d4e5f6-3333-4444-8555-666677778888'

const CLAUDE: HarnessDescriptor = {
  harnessId: 'claude-code',
  capabilities: {
    interrupt: true,
    resume: true,
    approvals: false,
    liveStream: true,
    listSessions: true,
  },
}

function summary(native: string, extra: Partial<HarnessSessionSummary> = {}): HarnessSessionSummary {
  return {
    sessionId: `claude-code:${native}` as SessionId,
    harnessId: 'claude-code',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:05:00.000Z',
    status: 'idle',
    ...extra,
  }
}

function legacy(id: string, command: string, updatedAt: number, title = 'stored'): HarnessSession {
  return { id, command, title, updatedAt }
}

describe('chatItems', () => {
  it('unions the control plane with the legacy scan, plane wins on the same native id', () => {
    const items = chatItems({
      drafts: [],
      harnessSessions: [summary(UUID_A, { title: 'plane title' })],
      legacySessions: [legacy(UUID_A, 'claude', 1_000, 'store title')],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      key: UUID_A,
      kind: 'harness',
      harnessId: 'claude-code',
      sessionId: `claude-code:${UUID_A}`,
      title: 'plane title',
      // the roster command comes off the store row so the PTY path still works
      command: 'claude',
      status: 'idle',
    })
  })

  it('keeps harnesses with no driver yet on the legacy binding (no regression)', () => {
    const items = chatItems({
      drafts: [],
      harnessSessions: [summary(UUID_A)],
      legacySessions: [legacy(UUID_B, 'grok', 2_000), legacy(UUID_C, 'hermes', 1_000)],
    })
    expect(items.map((i) => [i.key, i.kind])).toEqual([
      [UUID_A, 'harness'],
      [UUID_B, 'legacy'],
      [UUID_C, 'legacy'],
    ])
    expect(items.find((i) => i.key === UUID_B)?.sessionId).toBeUndefined()
  })

  it('pins drafts on top and drops one once its store row appears', () => {
    const withDraft = chatItems({
      drafts: [UUID_C],
      harnessSessions: [summary(UUID_A)],
      legacySessions: [],
    })
    expect(withDraft.map((i) => i.kind)).toEqual(['draft', 'harness'])

    const committed = chatItems({
      drafts: [UUID_C],
      harnessSessions: [summary(UUID_C)],
      legacySessions: [],
    })
    expect(committed.map((i) => i.kind)).toEqual(['harness'])
  })

  it('orders listed rows newest-first across both sources', () => {
    const items = chatItems({
      drafts: [],
      harnessSessions: [summary(UUID_A, { updatedAt: '2026-08-08T00:00:01.000Z' })],
      legacySessions: [legacy(UUID_B, 'grok', Date.parse('2026-08-08T09:00:00.000Z'))],
    })
    expect(items.map((i) => i.key)).toEqual([UUID_B, UUID_A])
  })

  it('falls back to the native id for a title and skips unparseable ids', () => {
    const items = chatItems({
      drafts: [],
      harnessSessions: [
        summary(UUID_A),
        { ...summary(UUID_B), sessionId: 'not-a-session-id' as SessionId },
      ],
      legacySessions: [],
    })
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe(UUID_A)
  })
})

describe('harnessGate', () => {
  it('opens only for a driver-owned row with a registered driver', () => {
    const item = { kind: 'harness' as const, harnessId: 'claude-code' as const, sessionId: `claude-code:${UUID_A}` as SessionId }
    expect(harnessGate(item, [CLAUDE])).toEqual({
      bound: true,
      stream: true,
      canInterrupt: true,
      // claude-code always reports approvals:false — its prompts live in the TUI
      canApprove: false,
      canResume: true,
    })
    // no registry (older node) → nothing is bound, the legacy path owns it
    expect(harnessGate(item, []).bound).toBe(false)
    expect(harnessGate(item, undefined).bound).toBe(false)
    expect(harnessGate({ kind: 'legacy' }, [CLAUDE]).bound).toBe(false)
    expect(harnessGate(undefined, [CLAUDE]).bound).toBe(false)
  })

  it('mirrors every false flag so the UI can hide the affordance', () => {
    const bare: HarnessDescriptor = {
      harnessId: 'claude-code',
      capabilities: {
        interrupt: false,
        resume: false,
        approvals: false,
        liveStream: false,
        listSessions: true,
      },
    }
    const gate = harnessGate(
      { kind: 'harness', harnessId: 'claude-code', sessionId: `claude-code:${UUID_A}` as SessionId },
      [bare],
    )
    // still bound (turns go through the driver) but the stream falls back
    expect(gate).toEqual({
      bound: true,
      stream: false,
      canInterrupt: false,
      canApprove: false,
      canResume: false,
    })
  })
})

describe('fetchHarnessPlaneSessions', () => {
  it('asks every listSessions-capable driver and merges the answers', async () => {
    const asked: string[] = []
    const sessions = await fetchHarnessPlaneSessions(
      {
        harnessSessionList: (id) => {
          asked.push(id)
          return Promise.resolve({ sessions: [summary(id === 'claude-code' ? UUID_A : UUID_B)] })
        },
      },
      [CLAUDE, { ...CLAUDE, harnessId: 'hermes' }],
    )
    expect(asked).toEqual(['claude-code', 'hermes'])
    expect(sessions).toHaveLength(2)
  })

  it('drops a failing driver instead of blanking the drawer', async () => {
    const sessions = await fetchHarnessPlaneSessions(
      {
        harnessSessionList: (id) =>
          id === 'claude-code'
            ? Promise.resolve({ sessions: [summary(UUID_A)] })
            : Promise.reject(new Error('store unreadable')),
      },
      [CLAUDE, { ...CLAUDE, harnessId: 'hermes' }],
    )
    expect(sessions.map((s) => s.sessionId)).toEqual([`claude-code:${UUID_A}`])
  })

  it('skips drivers that cannot list', () => {
    expect(
      listableHarnesses([{ ...CLAUDE, capabilities: { ...CLAUDE.capabilities, listSessions: false } }]),
    ).toEqual([])
  })
})

describe('typed-error and id helpers', () => {
  it('recognizes turn_in_flight, and nothing else on 409', () => {
    expect(isTurnInFlight({ status: 409, body: { code: 'turn_in_flight' } })).toBe(true)
    expect(isTurnInFlight({ status: 409, body: { code: 'session_id_collision' } })).toBe(false)
    expect(isTurnInFlight({ status: 501, body: { code: 'turn_in_flight' } })).toBe(false)
    expect(isTurnInFlight(new Error('nope'))).toBe(false)
    expect(isTurnInFlight(undefined)).toBe(false)
  })

  it('splits the native half on the first colon only', () => {
    expect(nativeIdOf(`claude-code:${UUID_A}`)).toBe(UUID_A)
    expect(nativeIdOf('grok-build:sess:42')).toBe('sess:42')
    expect(nativeIdOf(`claude-code:proj/slug/${UUID_A}`)).toBe(`proj/slug/${UUID_A}`)
    expect(nativeIdOf(UUID_A)).toBeUndefined()
  })

  it('shortens a native id for the drawer badge', () => {
    expect(shortNativeId(UUID_A)).toBe('…556666')
    expect(shortNativeId('abc')).toBe('abc')
  })
})
