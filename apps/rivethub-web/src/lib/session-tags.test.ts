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
      tag({ key: 'project', value: 'tenpal', display: 'TenPAL', state: 'rejected' }),
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
    'claude:a': [tag({ key: 'project', value: 'tenpal', display: 'TenPAL' }), tag({ key: 'project', value: 'rivetos' })],
    'claude:b': [tag({ key: 'project', value: 'rivetos' })],
    'claude:c': [tag({ key: 'project', value: 'rivetos', state: 'suggested' })],
  })

  it('groups by accepted values, a row can be in two groups, untagged last', () => {
    const groups = groupRowsByTag(rows, map, 'project')
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.key)])).toEqual([
      ['project:rivetos', ['r1', 'r2']],
      ['project:TenPAL', ['r1']],
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
  it('filtering by a tag only ever matches accepted tags (why suggested chips are not filters)', () => {
    const rows = [row('r1', 'claude:a')]
    const map = tagsBySession({ 'claude:a': [tag({ key: 'topic', value: 'x', state: 'suggested' })] })
    expect(filterRowsByTag(rows, map, 'topic:x')).toEqual([])
  })
})
