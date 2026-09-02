import { describe, it, expect } from 'vitest'
import type {
  HarnessDescriptor,
  HarnessSession,
  HarnessSessionSummary,
  SessionId,
} from '@rivetos/types'
import {
  applyRegistryEventToPlaneSessions,
  chatItems,
  denRoomKey,
  sortByRecency,
  fetchHarnessPlaneSessions,
  findChatItem,
  harnessGate,
  isTurnInFlight,
  listableHarnesses,
  mergeSessionCreated,
  nativeIdOf,
  patchSessionUpdated,
  shortNativeId,
  chatItemFromSummary,
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

function summary(
  native: string,
  extra: Partial<HarnessSessionSummary> = {},
): HarnessSessionSummary {
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
      // the thread key IS the canonical SessionId (§ Session identity mapping)
      key: `claude-code:${UUID_A}`,
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
      [`claude-code:${UUID_A}`, 'harness'],
      // no driver claimed these, so there is no harness id to canonicalize
      // with — they stay bare, and say so by carrying no sessionId
      [UUID_B, 'legacy'],
      [UUID_C, 'legacy'],
    ])
    expect(items.find((i) => i.key === UUID_B)?.sessionId).toBeUndefined()
  })

  it('orders drafts by creation time and drops one once its store row appears', () => {
    const unstamped = chatItems({
      drafts: [UUID_C],
      harnessSessions: [summary(UUID_A)],
      legacySessions: [],
    })
    expect(unstamped.map((i) => i.kind)).toEqual(['harness', 'draft'])

    const stamped = chatItems({
      drafts: [UUID_C],
      harnessSessions: [summary(UUID_A, { updatedAt: '2026-08-08T00:00:01.000Z' })],
      legacySessions: [],
      draftCreatedAt: { [UUID_C]: Date.parse('2026-08-08T10:00:00.000Z') },
    })
    expect(stamped.map((i) => i.kind)).toEqual(['draft', 'harness'])

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
    expect(items.map((i) => i.key)).toEqual([UUID_B, `claude-code:${UUID_A}`])
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

  // -- canonical keying (§ Session identity mapping / § Legacy keys) --------

  it('renders one row, not two, when the plane and the scan see the same session', () => {
    // The regression this guards: keying the plane row canonically while the
    // legacy scan still reports the bare id would put BOTH in the drawer.
    const items = chatItems({
      drafts: [UUID_A],
      harnessSessions: [summary(UUID_A)],
      legacySessions: [legacy(UUID_A, 'claude', 1_000)],
    })
    expect(items).toHaveLength(1)
    expect(items[0].key).toBe(`claude-code:${UUID_A}`)
  })

  it('every drawer row is canonical once all four drivers report', () => {
    // The four-driver reality: each roster harness has a HarnessId, so the
    // plane claims every on-disk row and nothing is left bare.
    const rows: HarnessSessionSummary[] = [
      summary(UUID_A),
      {
        ...summary(UUID_B),
        sessionId: `grok-build:${UUID_B}` as SessionId,
        harnessId: 'grok-build',
      },
      { ...summary(UUID_C), sessionId: `hermes:${UUID_C}` as SessionId, harnessId: 'hermes' },
    ]
    const items = chatItems({
      drafts: [],
      harnessSessions: rows,
      legacySessions: [
        legacy(UUID_A, 'claude', 1),
        legacy(UUID_B, 'grok', 2),
        legacy(UUID_C, 'hermes', 3),
      ],
    })
    expect(items.map((i) => i.key).sort()).toEqual(
      [`claude-code:${UUID_A}`, `grok-build:${UUID_B}`, `hermes:${UUID_C}`].sort(),
    )
    expect(items.every((i) => i.kind === 'harness')).toBe(true)
  })
})

describe('sortByRecency', () => {
  it('orders by updatedAt descending', () => {
    expect(
      sortByRecency([
        { id: 'a', updatedAt: 1 },
        { id: 'b', updatedAt: 3 },
        { id: 'c', updatedAt: 2 },
      ]).map((x) => x.id),
    ).toEqual(['b', 'c', 'a'])
  })

  it('keeps relative order on ties', () => {
    expect(
      sortByRecency([
        { id: 'a', updatedAt: 2 },
        { id: 'b', updatedAt: 2 },
        { id: 'c', updatedAt: 1 },
      ]).map((x) => x.id),
    ).toEqual(['a', 'b', 'c'])
  })

  it('sinks zero timestamps to the bottom', () => {
    expect(
      sortByRecency([
        { id: 'zero', updatedAt: 0 },
        { id: 'old', updatedAt: 1 },
        { id: 'new', updatedAt: 9 },
      ]).map((x) => x.id),
    ).toEqual(['new', 'old', 'zero'])
  })
})

describe('denRoomKey', () => {
  it('projects a canonical thread key onto the den room key', () => {
    expect(denRoomKey(`claude-code:${UUID_A}`)).toBe(UUID_A)
  })

  it('leaves a bare key and a non-SessionId room alone', () => {
    expect(denRoomKey(UUID_A)).toBe(UUID_A)
    expect(denRoomKey('den-pty-1a2b3c4d')).toBe('den-pty-1a2b3c4d')
  })
})

describe('findChatItem', () => {
  const items = chatItems({
    drafts: [UUID_C],
    harnessSessions: [summary(UUID_A)],
    legacySessions: [legacy(UUID_B, 'grok', 1_000)],
  })

  it('finds a row by its own key', () => {
    expect(findChatItem(items, `claude-code:${UUID_A}`)?.kind).toBe('harness')
    expect(findChatItem(items, UUID_B)?.kind).toBe('legacy')
    expect(findChatItem(items, UUID_C)?.kind).toBe('draft')
  })

  it('back-compat: a bare id still finds the row that got canonicalized', () => {
    // A pre-canonical selection, a deep link, or a draft the plane adopted.
    const found = findChatItem(items, UUID_A)
    expect(found?.key).toBe(`claude-code:${UUID_A}`)
  })

  it('does not invent a row for an unknown id', () => {
    expect(findChatItem(items, 'nope')).toBeUndefined()
    expect(findChatItem(items, undefined)).toBeUndefined()
  })
})

describe('harnessGate', () => {
  it('opens only for a driver-owned row with a registered driver', () => {
    const item = {
      kind: 'harness' as const,
      harnessId: 'claude-code' as const,
      sessionId: `claude-code:${UUID_A}` as SessionId,
    }
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
      {
        kind: 'harness',
        harnessId: 'claude-code',
        sessionId: `claude-code:${UUID_A}` as SessionId,
      },
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
      listableHarnesses([
        { ...CLAUDE, capabilities: { ...CLAUDE.capabilities, listSessions: false } },
      ]),
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

describe('registry stream → plane session list merge', () => {
  it('mergeSessionCreated inserts a row without a refetch (empty + non-empty cache)', () => {
    const created = summary(UUID_B, { title: 'brand new', status: 'active' })
    expect(mergeSessionCreated([], created)).toEqual([created])

    const existing = [summary(UUID_A)]
    const merged = mergeSessionCreated(existing, created)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toBe(created)
    expect(merged[1]).toEqual(existing[0])
    // pure: does not mutate the prior list
    expect(existing).toHaveLength(1)
  })

  it('merged row is the same shape as a fetched listSessions row', () => {
    // The event payload IS a HarnessSessionSummary — store it as-is so
    // chatItems / harnessGate see every field a GET would have returned.
    const fetched = summary(UUID_A, {
      title: 'from list',
      cwd: '/tmp/proj',
      status: 'idle',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T01:00:00.000Z',
    })
    const fromEvent = summary(UUID_B, {
      title: 'from event',
      cwd: '/tmp/other',
      status: 'active',
      createdAt: '2026-08-08T02:00:00.000Z',
      updatedAt: '2026-08-08T02:00:00.000Z',
    })
    const list = mergeSessionCreated([fetched], fromEvent)
    // every required SessionSummary field present on both
    for (const row of list) {
      expect(row).toEqual(
        expect.objectContaining({
          sessionId: expect.any(String),
          harnessId: expect.any(String),
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          status: expect.stringMatching(/^(active|idle|ended|error)$/),
        }),
      )
    }
    // chatItems treats the merged row as a harness plane row, not a draft/legacy
    const items = chatItems({ drafts: [], harnessSessions: list, legacySessions: [] })
    const item = items.find((i) => i.key === `claude-code:${UUID_B}`)
    expect(item).toMatchObject({
      kind: 'harness',
      sessionId: fromEvent.sessionId,
      harnessId: 'claude-code',
      status: 'active',
      title: 'from event',
    })
    // gate opens for the merged row exactly as for a fetched one
    expect(harnessGate(item, [CLAUDE]).bound).toBe(true)
  })

  it('dedups when the same session-created races a refetch (or a duplicate event)', () => {
    const created = summary(UUID_A, { title: 'v1', status: 'active' })
    const once = mergeSessionCreated([], created)
    // second event / merge-after-refetch-that-already-includes-it
    const twice = mergeSessionCreated(once, created)
    expect(twice).toHaveLength(1)
    expect(twice[0].sessionId).toBe(created.sessionId)

    // refetch returned a slightly staler copy; a later event overwrites in place
    const fromRefetch = [summary(UUID_A, { title: 'from GET', status: 'idle' }), summary(UUID_B)]
    const afterEvent = mergeSessionCreated(
      fromRefetch,
      summary(UUID_A, { title: 'from event', status: 'active' }),
    )
    expect(afterEvent).toHaveLength(2)
    expect(afterEvent.filter((s) => s.sessionId === `claude-code:${UUID_A}`)).toHaveLength(1)
    expect(afterEvent.find((s) => s.sessionId === `claude-code:${UUID_A}`)).toMatchObject({
      title: 'from event',
      status: 'active',
    })
  })

  it('patchSessionUpdated patches status in place; rotation rewrites sessionId', () => {
    const list = [summary(UUID_A, { status: 'idle' }), summary(UUID_B, { status: 'idle' })]
    const patched = patchSessionUpdated(list, {
      sessionId: `claude-code:${UUID_A}` as SessionId,
      status: 'active',
    })
    expect(patched).toHaveLength(2)
    expect(patched.find((s) => s.sessionId === `claude-code:${UUID_A}`)?.status).toBe('active')
    expect(patched.find((s) => s.sessionId === `claude-code:${UUID_B}`)?.status).toBe('idle')
    // unknown id: same reference (caller relies on invalidation)
    const untouched = patchSessionUpdated(list, {
      sessionId: `claude-code:${UUID_C}` as SessionId,
      status: 'ended',
    })
    expect(untouched).toBe(list)

    // native-id rotation: previousSessionId → sessionId, status applied
    const rotated = patchSessionUpdated([summary(UUID_A, { status: 'active' })], {
      sessionId: `claude-code:${UUID_B}` as SessionId,
      previousSessionId: `claude-code:${UUID_A}` as SessionId,
      status: 'idle',
    })
    expect(rotated).toEqual([
      expect.objectContaining({
        sessionId: `claude-code:${UUID_B}`,
        status: 'idle',
        harnessId: 'claude-code',
      }),
    ])
  })

  it('applyRegistryEventToPlaneSessions covers create/update and ignores other types', () => {
    const created = summary(UUID_A, { title: 'live' })
    // empty cache + session-created seeds the list (no refetch required to paint)
    const seeded = applyRegistryEventToPlaneSessions(undefined, {
      type: 'session-created',
      sessionId: created.sessionId,
      summary: created,
    })
    expect(seeded).toEqual([created])

    const active = applyRegistryEventToPlaneSessions(seeded, {
      type: 'session-updated',
      sessionId: created.sessionId,
      status: 'active',
    })
    expect(active?.[0].status).toBe('active')

    // turn-complete etc. are not registry-list events — leave cache alone
    const same = applyRegistryEventToPlaneSessions(active, {
      type: 'turn-complete',
      sessionId: created.sessionId,
    })
    expect(same).toBe(active)

    // missing summary on session-created is a no-op (malformed frame)
    expect(
      applyRegistryEventToPlaneSessions(active, {
        type: 'session-created',
        sessionId: created.sessionId,
      }),
    ).toBe(active)
  })
})

describe('chatItemFromSummary', () => {
  it('builds a cross-node drawer row from one control-plane summary', () => {
    const item = chatItemFromSummary({
      sessionId: 'claude-code:abc-123' as never,
      harnessId: 'claude-code',
      title: 'remote thread',
      status: 'idle',
      updatedAt: '2026-08-29T12:00:00.000Z',
    } as never)
    expect(item).toMatchObject({
      key: 'claude-code:abc-123',
      kind: 'harness',
      title: 'remote thread',
      harnessId: 'claude-code',
      command: 'claude',
      status: 'idle',
    })
    expect(item?.updatedAt).toBe(Date.parse('2026-08-29T12:00:00.000Z'))
  })

  it('refuses a malformed session id', () => {
    expect(
      chatItemFromSummary({ sessionId: '???', harnessId: 'claude-code' } as never),
    ).toBeUndefined()
  })
})
