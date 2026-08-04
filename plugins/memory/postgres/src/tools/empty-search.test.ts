/**
 * Unit tests for formatEmptySearchResult — pure empty-path UX guidance.
 * No PG required.
 */
import { describe, expect, it } from 'vitest'
import { formatEmptySearchResult } from './helpers.js'

describe('formatEmptySearchResult', () => {
  it('without date filter: suggests trigram, multi-angle, and browse for time-bounded', () => {
    const msg = formatEmptySearchResult({ query: 'datahub IP' })
    expect(msg).toContain('No results found for query "datahub IP"')
    expect(msg).toContain('mode="trigram"')
    expect(msg).toContain('service / host / subnet / role')
    expect(msg).toContain('memory_browse')
    expect(msg).toContain('window=')
    // Must not be the old bare string that agents treated as final.
    expect(msg).not.toBe('No results found.')
  })

  it('with since/before: points at memory_browse with those bounds', () => {
    const msg = formatEmptySearchResult({
      query: 'heartbeat',
      since: '2026-08-01T00:00:00.000Z',
      before: '2026-08-02T00:00:00.000Z',
    })
    expect(msg).toContain('since="2026-08-01T00:00:00.000Z"')
    expect(msg).toContain('before="2026-08-02T00:00:00.000Z"')
    expect(msg).toContain('memory_browse(since="2026-08-01T00:00:00.000Z", before="2026-08-02T00:00:00.000Z")')
    expect(msg).toContain('no FTS match required')
  })

  it('with window= prefers window label over raw since/before in the message', () => {
    const msg = formatEmptySearchResult({
      query: 'mesh update',
      since: '2026-07-27T04:00:00.000Z',
      window: 'last_7d',
    })
    expect(msg).toContain('window="last_7d"')
    expect(msg).toContain('memory_browse(window="last_7d")')
    expect(msg).not.toContain('since=')
  })

  it('window alone without since/before still falls through to no-date path', () => {
    // Callers pass resolved since/before from applyWindowArgs; if neither
    // bound is set, window is ignored for empty-path routing (defensive).
    const msg = formatEmptySearchResult({
      query: 'orphan',
      window: 'today',
    })
    expect(msg).toContain('mode="trigram"')
    expect(msg).not.toContain('window="today"')
  })
})
