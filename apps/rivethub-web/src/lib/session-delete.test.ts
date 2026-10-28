import { describe, expect, it } from 'vitest'
import { GatewayError } from '@rivetos/gateway-client'
import type { SessionTrashCandidate } from '@rivetos/types'
import type { ChatItem } from './harness-chat.js'
import {
  ageLabel,
  deleteConfirmMessage,
  deleteTargetFor,
  failureFromError,
  foldDeleteResults,
  isTrashResponse,
  outcomeNotice,
  reviewableCandidates,
  trashUnsupported,
} from './session-delete.js'

const UUID = '00000000-0000-4000-8000-000000000001'
const SID = `claude-code:${UUID}`

function item(over: Partial<ChatItem>): ChatItem {
  return { key: UUID, kind: 'legacy', title: 't', updatedAt: 0, ...over }
}

describe('deleteTargetFor', () => {
  it('uses the canonical id of a control-plane row', () => {
    expect(
      deleteTargetFor(item({ key: SID, kind: 'harness', sessionId: SID as ChatItem['sessionId'] })),
    ).toBe(SID)
  })

  it('canonicalizes a legacy row through its roster command', () => {
    expect(deleteTargetFor(item({ command: 'claude' }))).toBe(SID)
  })

  it('offers nothing for drafts, pins, or an unmapped legacy command', () => {
    expect(deleteTargetFor(item({ kind: 'draft' }))).toBeUndefined()
    expect(deleteTargetFor(item({ kind: 'harness', key: SID, pin: true }))).toBeUndefined()
    expect(
      deleteTargetFor(item({ kind: 'harness', key: SID, pinNodeBaseUrl: 'https://other' })),
    ).toBeUndefined()
    expect(deleteTargetFor(item({ command: 'not-a-harness' }))).toBeUndefined()
  })
})

describe('deleteConfirmMessage', () => {
  it('names the session and says memory goes, the transcript stays', () => {
    const msg = deleteConfirmMessage(['Fix CI'])
    expect(msg).toContain('Delete “Fix CI”?')
    expect(msg).toContain('removed from memory')
    expect(msg).toContain('transcript on disk is kept')
  })

  it('counts and lists the first few for a bulk delete', () => {
    const msg = deleteConfirmMessage(['a', 'b', 'c', 'd', 'e'])
    expect(msg).toContain('Delete 5 sessions (“a”, “b”, “c” and 2 more)?')
    expect(msg).toContain('transcript on')
  })
})

describe('foldDeleteResults', () => {
  it('splits ok / live / not found and treats a missing result as a failure', () => {
    const out = foldDeleteResults(
      ['a', 'b', 'c', 'd'],
      [
        { session: 'a', ok: true, conversations: 1, messages: 1, summaries: 0 },
        { session: 'b', ok: false, error: 'session is live' },
        { session: 'c', ok: false, error: 'not found' },
      ],
    )
    expect(out.deleted).toEqual(['a'])
    expect(out.failed.map((f) => [f.session, f.kind])).toEqual([
      ['b', 'live'],
      ['c', 'not-found'],
      ['d', 'error'],
    ])
  })
})

describe('failureFromError', () => {
  it('maps 409 to live and 404 to not found', () => {
    expect(failureFromError(new GatewayError(409, 'session is live', undefined)).kind).toBe('live')
    expect(failureFromError(new GatewayError(404, 'not found', undefined)).kind).toBe('not-found')
    expect(failureFromError(new GatewayError(500, 'boom', undefined))).toEqual({
      kind: 'error',
      message: 'boom',
    })
  })
})

describe('outcomeNotice', () => {
  it('reads plainly for mixed outcomes', () => {
    const label = (id: string): string => id.toUpperCase()
    expect(outcomeNotice({ deleted: ['a'], failed: [] }, label)).toBe('Deleted “A”.')
    expect(
      outcomeNotice(
        { deleted: ['a', 'b'], failed: [{ session: 'c', kind: 'live', message: '' }] },
        label,
      ),
    ).toBe('Deleted 2 sessions. “C” is running, so it was left alone.')
  })
})

function candidate(session: string): SessionTrashCandidate {
  return {
    session,
    harness: 'claude-code',
    title: null,
    updatedAt: '2026-10-01T00:00:00Z',
    reason: 'empty',
    userTurns: 0,
    reply: null,
  }
}

describe('reviewableCandidates', () => {
  it('drops sessions the user renamed locally and the excluded (open) one', () => {
    const renamed = new Set(['claude-code:b'])
    const out = reviewableCandidates(
      [candidate('claude-code:a'), candidate('claude-code:b'), candidate('claude-code:c')],
      (s) => renamed.has(s),
      new Set(['claude-code:c']),
    )
    expect(out.map((c) => c.session)).toEqual(['claude-code:a'])
  })

  it('drops malformed rows', () => {
    expect(reviewableCandidates([candidate('')], () => false)).toEqual([])
  })
})

describe('trash support detection', () => {
  it('treats 404/405/501 as an older gateway and other errors as errors', () => {
    expect(trashUnsupported(new GatewayError(404, 'x', undefined))).toBe(true)
    expect(trashUnsupported(new GatewayError(405, 'x', undefined))).toBe(true)
    expect(trashUnsupported(new GatewayError(501, 'x', undefined))).toBe(true)
    expect(trashUnsupported(new GatewayError(500, 'x', undefined))).toBe(false)
    expect(trashUnsupported(new Error('x'))).toBe(false)
  })

  it('rejects a 200 that is not the trash shape', () => {
    expect(isTrashResponse({ candidates: [] })).toBe(true)
    expect(isTrashResponse({ messages: [] })).toBe(false)
    expect(isTrashResponse(null)).toBe(false)
  })
})

describe('ageLabel', () => {
  it('coarsens to m / h / d / w', () => {
    const now = Date.parse('2026-10-27T12:00:00Z')
    expect(ageLabel('2026-10-27T11:30:00Z', now)).toBe('30m')
    expect(ageLabel('2026-10-27T09:00:00Z', now)).toBe('3h')
    expect(ageLabel('2026-10-24T12:00:00Z', now)).toBe('3d')
    expect(ageLabel('2026-09-01T12:00:00Z', now)).toBe('8w')
    expect(ageLabel('nope', now)).toBe('')
  })
})
