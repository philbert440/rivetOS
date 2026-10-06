import { describe, expect, it } from 'vitest'
import type { PendingTagWire } from '@rivetos/types'
import type { SessionListRow } from './session-list.js'
import {
  filterRowsByTag,
  groupPendingBySession,
  groupRowsByTag,
  sortTagsForChips,
  tagKeyOptions,
  tagLabel,
  tagsBySession,
  sessionKeysOf,
  type AnyTag,
} from './session-tags.js'

function tag(over: Partial<AnyTag> & Pick<AnyTag, 'key' | 'value'>): AnyTag {
  return { id: `${over.key}:${over.value}`, display: '', state: 'accepted', source: 'user', ...over }
}

function row(key: string, sessionId?: string): SessionListRow {
  return { key, kind: 'harness', title: key, updatedAt: 1, ...(sessionId ? { sessionId } : {}) } as SessionListRow
}

describe('tagLabel / sortTagsForChips', () => {
  it('uses display casing and orders accepted before suggested, dropping rejected', () => {
    const sorted = sortTagsForChips([
      tag({ key: 'topic', value: 'b', state: 'suggested' }),
      tag({ key: 'project', value: 'acmeapp', display: 'AcmeApp', state: 'rejected' }),
      tag({ key: 'topic', value: 'a' }),
      tag({ key: 'project', value: 'x' }),
    ])
    expect(sorted.map(tagLabel)).toEqual(['project:x', 'topic:a', 'topic:b'])
  })
})

describe('tagsBySession / sessionKeysOf / tagKeyOptions', () => {
  it('maps a lookup response and lists accepted keys', () => {
    const map = tagsBySession({
      'claude:a': [tag({ key: 'project', value: 'p' }), tag({ key: 'topic', value: 't', state: 'suggested' })],
      'codex:b': [tag({ key: 'repo', value: 'r' })],
    })
    expect([...map.keys()]).toEqual(['claude:a', 'codex:b'])
    expect(tagKeyOptions(map)).toEqual(['project', 'repo'])
    expect(sessionKeysOf([row('k1', 'claude:a'), row('k2'), row('k3', 'claude:a')])).toEqual(['claude:a', 'k2'])
  })
})

describe('groupRowsByTag / filterRowsByTag', () => {
  const rows = [row('r1', 'claude:a'), row('r2', 'claude:b'), row('r3', 'claude:c'), row('r4', 'claude:d')]
  const map = tagsBySession({
    'claude:a': [tag({ key: 'project', value: 'acmeapp', display: 'AcmeApp' }), tag({ key: 'project', value: 'rivetos' })],
    'claude:b': [tag({ key: 'project', value: 'rivetos' })],
    'claude:c': [tag({ key: 'project', value: 'rivetos', state: 'suggested' })],
  })

  it('groups by accepted values, a row can be in two groups, untagged last', () => {
    const groups = groupRowsByTag(rows, map, 'project')
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.key)])).toEqual([
      ['project:rivetos', ['r1', 'r2']],
      ['project:AcmeApp', ['r1']],
      ['(untagged)', ['r3', 'r4']],
    ])
  })

  it('filters rows by one accepted tag identity', () => {
    expect(filterRowsByTag(rows, map, 'project:rivetos').map((r) => r.key)).toEqual(['r1', 'r2'])
    expect(filterRowsByTag(rows, map, '').map((r) => r.key)).toEqual(['r1', 'r2', 'r3', 'r4'])
  })
})

describe('groupPendingBySession', () => {
  const pending = (over: Partial<PendingTagWire>): PendingTagWire =>
    ({
      id: 'x', entityType: 'conversation', entityId: 'c', key: 'topic', value: 'v', display: '',
      source: 'model', state: 'suggested', proposedBy: 'm', reason: '', createdAt: '', updatedAt: '',
      ...over,
    }) as PendingTagWire

  it('groups by session key and falls back to the conversation or entity id', () => {
    const groups = groupPendingBySession([
      pending({ id: '1', sessionKey: 'claude:a', title: 'A' }),
      pending({ id: '2', sessionKey: null, conversationId: 'c9' }),
      pending({ id: '3', sessionKey: 'claude:a' }),
    ])
    expect(groups.map((g) => [g.sessionKey, g.title, g.openable, g.tags.map((t) => t.id)])).toEqual([
      ['claude:a', 'A', true, ['1', '3']],
      ['c9', null, false, ['2']],
    ])
  })

  it('two conversations sharing a session key (two agents) are two groups with distinct ids', () => {
    const groups = groupPendingBySession([
      pending({ id: '1', entityId: 'c1', conversationId: 'c1', sessionKey: 'codex:shared', agent: 'rivet' }),
      pending({ id: '2', entityId: 'c2', conversationId: 'c2', sessionKey: 'codex:shared', agent: 'grok' }),
    ])
    expect(groups.map((g) => [g.id, g.sessionKey, g.agent])).toEqual([
      ['c1', 'codex:shared', 'rivet'],
      ['c2', 'codex:shared', 'grok'],
    ])
  })

  it('puts a session and its summaries in one group, openable when any tag knows the session key', () => {
    const groups = groupPendingBySession([
      // Summary suggestion first: it knows only the conversation.
      pending({ id: '1', entityType: 'summary', entityId: 's1', sessionKey: null, conversationId: 'c1' }),
      pending({ id: '2', entityId: 'c1', sessionKey: 'claude:a', conversationId: 'c1', title: 'A', agent: 'rivet' }),
      pending({ id: '3', entityType: 'summary', entityId: 's2', sessionKey: null, conversationId: 'c1' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: 'c1', sessionKey: 'claude:a', openable: true, title: 'A', agent: 'rivet' })
    expect(groups[0].tags.map((t) => t.id)).toEqual(['1', '2', '3'])
  })
})

describe('lookup chunking', () => {
  it('splits keys into request-sized chunks without dropping any', async () => {
    const { chunkKeys, TAG_LOOKUP_CHUNK } = await import('./session-tags.js')
    const keys = Array.from({ length: TAG_LOOKUP_CHUNK * 2 + 3 }, (_, i) => `k${String(i)}`)
    const chunks = chunkKeys(keys)
    expect(chunks.map((c) => c.length)).toEqual([TAG_LOOKUP_CHUNK, TAG_LOOKUP_CHUNK, 3])
    expect(chunks.flat()).toEqual(keys)
    expect(chunkKeys([])).toEqual([])
  })
})

describe('mergeLookups', () => {
  it('combines chunk responses without losing a session', async () => {
    const { mergeLookups } = await import('./session-tags.js')
    const a = { sessions: { k1: [tag({ key: 'project', value: 'a' })] } }
    const b = { sessions: { k2: [tag({ key: 'project', value: 'b' })], k3: [] } }
    expect(Object.keys(mergeLookups([a, b]))).toEqual(['k1', 'k2', 'k3'])
    expect(mergeLookups([])).toEqual({})
  })
})

describe('chip click target', () => {
  it('only an accepted chip is a filter, because filters match accepted tags only', async () => {
    const { isFilterableChip } = await import('./session-tags.js')
    expect(isFilterableChip({ state: 'accepted' })).toBe(true)
    expect(isFilterableChip({ state: 'suggested' })).toBe(false)
    expect(isFilterableChip({ state: 'rejected' })).toBe(false)
    const rows = [row('r1', 'claude:a')]
    const map = tagsBySession({ 'claude:a': [tag({ key: 'topic', value: 'x', state: 'suggested' })] })
    expect(filterRowsByTag(rows, map, 'topic:x')).toEqual([])
  })
})

describe('lookup rules', () => {
  it('keeps the previous tags only across a session-set change on the same datahub', async () => {
    const { keepLookupPlaceholder } = await import('./session-tags.js')
    expect(keepLookupPlaceholder('https://hub-a', 'https://hub-a')).toBe(true)
    expect(keepLookupPlaceholder('https://hub-a', 'https://hub-b')).toBe(false)
    expect(keepLookupPlaceholder('https://hub-a', undefined)).toBe(false)
    expect(keepLookupPlaceholder(undefined, undefined)).toBe(false)
    expect(keepLookupPlaceholder(undefined, 'https://hub-a')).toBe(false)
  })

  it('a lookup is in flight on first load or while a stand-in is being replaced, not when disabled', async () => {
    const { lookupInFlight } = await import('./session-tags.js')
    expect(lookupInFlight({ isLoading: true, isPlaceholderData: false, isFetching: true })).toBe(true)
    expect(lookupInFlight({ isLoading: false, isPlaceholderData: true, isFetching: true })).toBe(true)
    // A disabled query holding a placeholder is not loading and never will be.
    expect(lookupInFlight({ isLoading: false, isPlaceholderData: true, isFetching: false })).toBe(false)
    expect(lookupInFlight({ isLoading: false, isPlaceholderData: false, isFetching: true })).toBe(false)
  })

  it('settleTagFilters: keeps while loading, clears what no longer exists, clears all without a datahub', async () => {
    const { settleTagFilters } = await import('./session-tags.js')
    const base = {
      hasEndpoint: true,
      lookupInFlight: false,
      tagFilter: 'project:acmeapp',
      groupKey: 'project',
      filterIdentities: ['', 'project:acmeapp'],
      keyChoices: ['project'],
    }
    expect(settleTagFilters(base)).toEqual({ tagFilter: 'project:acmeapp', groupKey: 'project' })
    // A session was just added: the lookup has not answered, nothing is known yet.
    expect(
      settleTagFilters({ ...base, lookupInFlight: true, filterIdentities: [''], keyChoices: [] }),
    ).toEqual({ tagFilter: 'project:acmeapp', groupKey: 'project' })
    // The tag was removed: the answer no longer has it.
    expect(settleTagFilters({ ...base, filterIdentities: [''], keyChoices: [] })).toEqual({
      tagFilter: '',
      groupKey: '',
    })
    // Datahub gone: the controls are hidden, even mid-lookup.
    expect(settleTagFilters({ ...base, hasEndpoint: false, lookupInFlight: true })).toEqual({
      tagFilter: '',
      groupKey: '',
    })
    expect(settleTagFilters({ ...base, tagFilter: '', groupKey: '' })).toEqual({ tagFilter: '', groupKey: '' })
  })
})

describe('isTagLiteral', () => {
  it('accepts what the server accepts, including a full-width colon', async () => {
    const { isTagLiteral } = await import('./session-tags.js')
    expect(isTagLiteral('project:AcmeApp')).toBe(true)
    expect(isTagLiteral('project\uFF1Aacmeapp')).toBe(true)
    for (const bad of ['project', ':x', 'project:', 'project:   ', '']) {
      expect(isTagLiteral(bad)).toBe(false)
    }
  })
})

describe('chipLabel', () => {
  it('marks a removal suggestion and leaves an addition alone', async () => {
    const { chipLabel } = await import('./session-tags.js')
    expect(chipLabel({ key: 'project', value: 'rivetos', display: 'rivetOS', action: 'remove' })).toBe(
      'suggest remove project:rivetOS',
    )
    expect(chipLabel({ key: 'topic', value: 'wiki', display: '' })).toBe('topic:wiki')
  })
})

describe('pending review helpers', () => {
  it('says "first N" when the page is full', async () => {
    const { pendingCountLabel } = await import('./session-tags.js')
    expect(pendingCountLabel(3, 200)).toBe('3 pending')
    expect(pendingCountLabel(200, 200)).toBe('first 200 pending')
  })
})
