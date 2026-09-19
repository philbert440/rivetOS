import { describe, expect, it } from 'vitest'
import type { HarnessSessionSummary, SessionId } from '@rivetos/types'
import { chatItems, type ChatItem } from './harness-chat.js'
import {
  cwdBasename,
  filterSessionList,
  harnessFilterOptions,
  sessionListRows,
} from './session-list.js'

const UUID_A = 'a1b2c3d4-1111-4222-8333-444455556666'
const UUID_B = 'b2c3d4e5-2222-4333-8444-555566667777'
const SID_A = `claude-code:${UUID_A}` as SessionId
const SID_B = `grok-build:${UUID_B}` as SessionId

function summary(
  partial: Partial<HarnessSessionSummary> & Pick<HarnessSessionSummary, 'sessionId' | 'harnessId'>,
): HarnessSessionSummary {
  return {
    title: 't',
    cwd: '/home/rivet/proj',
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T12:00:00.000Z',
    status: 'idle',
    ...partial,
  }
}

describe('cwdBasename', () => {
  it('returns the last path segment', () => {
    expect(cwdBasename('/home/rivet/proj')).toBe('proj')
    expect(cwdBasename('/home/rivet/proj/')).toBe('proj')
    expect(cwdBasename(undefined)).toBeUndefined()
  })
})

describe('sessionListRows + filterSessionList', () => {
  const plane: HarnessSessionSummary[] = [
    summary({
      sessionId: SID_A,
      harnessId: 'claude-code',
      title: 'alpha work',
      cwd: '/var/work/alpha',
      status: 'active',
      blocked: true,
      updatedAt: '2026-09-18T14:00:00.000Z',
    }),
    summary({
      sessionId: SID_B,
      harnessId: 'grok-build',
      title: 'beta notes',
      cwd: '/var/work/beta',
      status: 'ended',
      updatedAt: '2026-09-18T10:00:00.000Z',
    }),
  ]

  const items: ChatItem[] = chatItems({
    drafts: [],
    harnessSessions: plane,
    legacySessions: [
      {
        id: 'c3d4e5f6-3333-4444-8555-666677778888',
        command: 'hermes',
        title: 'legacy hermes',
        updatedAt: Date.parse('2026-09-18T13:00:00.000Z'),
      },
    ],
  })

  const rows = sessionListRows(items, plane)

  it('enriches plane rows with cwd and blocked', () => {
    expect(items.map((i) => i.key)).toEqual(
      expect.arrayContaining([SID_A, SID_B, 'c3d4e5f6-3333-4444-8555-666677778888']),
    )
    const alpha = rows.find((r) => r.sessionId === SID_A)
    expect(alpha).toMatchObject({
      title: 'alpha work',
      cwd: '/var/work/alpha',
      blocked: true,
      status: 'active',
      harnessId: 'claude-code',
    })
  })

  it('keeps legacy rows from the merge', () => {
    expect(rows.some((r) => r.kind === 'legacy' && r.title === 'legacy hermes')).toBe(true)
  })

  it('defaults to most recently updated order after filter', () => {
    const filtered = filterSessionList(rows, { harnessId: '', status: 'all', text: '' })
    expect(filtered.map((r) => r.title)).toEqual(['alpha work', 'legacy hermes', 'beta notes'])
  })

  it('filters by harness id', () => {
    const filtered = filterSessionList(rows, {
      harnessId: 'grok-build',
      status: 'all',
      text: '',
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.harnessId).toBe('grok-build')
  })

  it('filters Live vs Ended', () => {
    const live = filterSessionList(rows, { harnessId: '', status: 'live', text: '' })
    expect(live.every((r) => r.status !== 'ended')).toBe(true)
    expect(live.some((r) => r.title === 'alpha work')).toBe(true)

    const ended = filterSessionList(rows, { harnessId: '', status: 'ended', text: '' })
    expect(ended).toHaveLength(1)
    expect(ended[0]?.title).toBe('beta notes')
  })

  it('filters by title/cwd text', () => {
    const byTitle = filterSessionList(rows, { harnessId: '', status: 'all', text: 'beta' })
    expect(byTitle.map((r) => r.title)).toEqual(['beta notes'])
    const byCwd = filterSessionList(rows, { harnessId: '', status: 'all', text: 'alpha' })
    expect(byCwd.map((r) => r.title)).toEqual(['alpha work'])
  })

  it('lists harness filter options sorted', () => {
    expect(harnessFilterOptions(rows)).toEqual(['claude-code', 'grok-build'])
  })
})
