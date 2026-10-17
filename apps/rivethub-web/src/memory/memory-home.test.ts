import { describe, expect, it } from 'vitest'
import type { MemorySearchHit } from '@rivetos/types'
import type { SessionListRow } from '../lib/session-list.js'
import {
  dayBucket,
  excerpt,
  groupRowsByDay,
  highlightParts,
  isToolStub,
  sessionResults,
} from './memory-home.js'

// Mon 2026-10-12 15:00 local.
const NOW = new Date(2026, 9, 12, 15, 0).getTime()
const at = (day: number, hour = 12): number => new Date(2026, 9, day, hour).getTime()

function row(key: string, updatedAt: number, extra: Partial<SessionListRow> = {}): SessionListRow {
  return { key, kind: 'harness', title: key, updatedAt, ...extra } as SessionListRow
}

function hit(id: string, sessionId: string | null, content = 'x'): MemorySearchHit {
  return { id, source: 'message', content, createdAt: '2026-10-12T00:00:00Z', score: 1, sessionId }
}

describe('dayBucket', () => {
  it('pins active and blocked rows above the day groups', () => {
    expect(dayBucket(row('a', at(1), { status: 'active' }), NOW)).toBe('Active now')
    expect(dayBucket(row('b', at(1), { blocked: true }), NOW)).toBe('Active now')
  })
  it('buckets by local calendar day', () => {
    expect(dayBucket(row('a', at(12, 0)), NOW)).toBe('Today')
    expect(dayBucket(row('b', at(11, 23)), NOW)).toBe('Yesterday')
    expect(dayBucket(row('c', at(6, 1)), NOW)).toBe('This week')
    expect(dayBucket(row('d', at(5, 23)), NOW)).toBe('Older')
  })
})

describe('groupRowsByDay', () => {
  it('orders groups, sorts newest first, and drops empty groups', () => {
    const groups = groupRowsByDay(
      [
        row('old', at(1)),
        row('t1', at(12, 9)),
        row('t2', at(12, 11)),
        row('live', at(2), { status: 'active' }),
      ],
      NOW,
    )
    expect(groups.map((g) => g.bucket)).toEqual(['Active now', 'Today', 'Older'])
    expect(groups[1].rows.map((r) => r.key)).toEqual(['t2', 't1'])
  })
})

describe('sessionResults', () => {
  const rows = [row('s1', at(12)), row('s2', at(11), { sessionId: 'canon-2' })]

  it('groups hits under their session in best-hit order and joins rows', () => {
    const out = sessionResults(
      [hit('1', 'canon-2'), hit('2', 's1'), hit('3', 'canon-2')],
      rows,
      [],
      {
        onlyKnownRows: false,
      },
    )
    expect(out.map((r) => r.key)).toEqual(['canon-2', 's1'])
    expect(out[0].row?.key).toBe('s2')
    expect(out[0].hits.map((h) => h.id)).toEqual(['1', '3'])
  })

  it('keeps sessionless hits and unknown sessions unless filters are on', () => {
    const hits = [hit('1', null), hit('2', 'elsewhere')]
    expect(sessionResults(hits, rows, [], { onlyKnownRows: false }).map((r) => r.key)).toEqual([
      'hit:message:1',
      'elsewhere',
    ])
    expect(sessionResults(hits, rows, [], { onlyKnownRows: true })).toEqual([])
  })

  it('joins a bare native hit id to a canonical row id', () => {
    const canon = [row('claude-code:abc-123', at(12), { sessionId: 'claude-code:abc-123' })]
    const out = sessionResults([hit('1', 'abc-123'), hit('2', 'claude-code:abc-123')], canon, [], {
      onlyKnownRows: true,
    })
    expect(out).toHaveLength(1)
    expect(out[0].row?.key).toBe('claude-code:abc-123')
    expect(out[0].hits.map((h) => h.id)).toEqual(['1', '2'])
  })

  it('appends title matches that had no hit', () => {
    const out = sessionResults([hit('1', 's1')], rows, [rows[0], rows[1]], { onlyKnownRows: false })
    expect(out.map((r) => [r.key, r.hits.length])).toEqual([
      ['s1', 1],
      ['canon-2', 0],
    ])
  })
})

describe('excerpt', () => {
  it('returns short text whole, flattened', () => {
    expect(excerpt('a\n  b', 'b')).toBe('a b')
  })
  it('windows long text around the first term', () => {
    const text = `${'x '.repeat(200)}the cert rotated ${'y '.repeat(200)}`
    const out = excerpt(text, 'cert', 80)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(out).toContain('cert rotated')
  })
})

describe('highlightParts', () => {
  it('marks case-insensitive term runs', () => {
    expect(highlightParts('Den PTY resize', 'pty')).toEqual([
      { text: 'Den ', match: false },
      { text: 'PTY', match: true },
      { text: ' resize', match: false },
    ])
  })
  it('escapes regex characters in the query', () => {
    expect(highlightParts('ip 192.0.2.21 here', '192.0.2.21').filter((p) => p.match)).toEqual([
      { text: '192.0.2.21', match: true },
    ])
  })
  it('leaves text alone for a query with no usable terms', () => {
    expect(highlightParts('abc', 'a')).toEqual([{ text: 'abc', match: false }])
  })
})

describe('isToolStub', () => {
  it('flags bare tool-call stubs only', () => {
    expect(isToolStub(hit('1', 's', '[tool call] Bash'))).toBe(true)
    expect(isToolStub(hit('2', 's', '[tool] Read'))).toBe(true)
    expect(isToolStub(hit('3', 's', '[tool call] Bash\nbreadcrumb rendered'))).toBe(false)
    expect(isToolStub(hit('4', 's', 'the breadcrumb'))).toBe(false)
  })
})
