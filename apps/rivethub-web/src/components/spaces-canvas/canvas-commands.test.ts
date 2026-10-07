import { describe, expect, it } from 'vitest'
import {
  mruPreviewId,
  nextWaitingId,
  rankFindHits,
  rememberThread,
  removeSpaceMessage,
} from './canvas-commands.js'

describe('nextWaitingId', () => {
  const waiting = [
    { id: 'new', since: 30 },
    { id: 'old', since: 10 },
    { id: 'mid', since: 20 },
  ]

  it('jumps to the oldest when not at thread altitude', () => {
    expect(nextWaitingId(waiting, 'new', false)).toBe('old')
    expect(nextWaitingId(waiting, undefined, true)).toBe('old')
  })

  it('cycles forward from the current tile at thread altitude', () => {
    expect(nextWaitingId(waiting, 'old', true)).toBe('mid')
    expect(nextWaitingId(waiting, 'mid', true)).toBe('new')
    expect(nextWaitingId(waiting, 'new', true)).toBe('old')
    expect(nextWaitingId(waiting, 'absent', true)).toBe('old')
  })

  it('is undefined when nothing is waiting', () => {
    expect(nextWaitingId([], 'old', true)).toBeUndefined()
  })
})

describe('rankFindHits', () => {
  const rows = [
    { id: 'a', needs: false, updatedAt: 5, haystack: 'alpha invoices' },
    { id: 'b', needs: true, updatedAt: 1, haystack: 'beta invoices' },
    { id: 'c', needs: false, updatedAt: 9, haystack: 'gamma notes' },
    { id: 'd', needs: true, updatedAt: 8, haystack: 'delta invoices' },
  ]

  it('puts needs-you first, then recency, and ignores a blank query', () => {
    expect(rankFindHits(rows, '  Invoices ').map((row) => row.id)).toEqual(['d', 'b', 'a'])
    expect(rankFindHits(rows, '   ')).toEqual([])
  })
})

describe('mru', () => {
  it('moves a reopened thread to the front', () => {
    expect(rememberThread(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(rememberThread([], 'a')).toEqual(['a'])
  })

  it('steps with a 1-based index that wraps', () => {
    const list = ['current', 'previous', 'older']
    expect(mruPreviewId(list, 1)).toBe('previous')
    expect(mruPreviewId(list, 2)).toBe('older')
    expect(mruPreviewId(list, 3)).toBe('current')
    expect(mruPreviewId([], 1)).toBeUndefined()
  })
})

describe('removeSpaceMessage', () => {
  it('uses the mock copy for empty and live spaces', () => {
    expect(removeSpaceMessage('Home', 0, 0)).toContain(
      "It has no threads yet. This can't be undone",
    )
    expect(removeSpaceMessage('Home', 1, 0)).toContain('This closes its 1 thread.')
    expect(removeSpaceMessage('Home', 2, 1)).toContain(
      'This closes its 2 threads, 1 of them still active.',
    )
  })
})
