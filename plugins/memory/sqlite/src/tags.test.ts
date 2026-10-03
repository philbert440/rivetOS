/**
 * SQLite tag store: the same lifecycle as the Postgres store, against a real
 * in-memory database.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteMemory } from './adapter.js'
import type { SqliteTagStore } from './tags.js'

const UUID = 'a1b2c3d4-1111-4222-8333-444455556666'

describe('SqliteTagStore', () => {
  let memory: SqliteMemory
  let tags: SqliteTagStore

  /** Create a conversation by appending one message; returns its id. */
  const conversation = async (sessionId: string, agent = 'rivet'): Promise<string> => {
    await memory.append({ sessionId, agent, channel: 'cli', role: 'user', content: 'hi' })
    const row = tags.add({ entityType: 'conversation', sessionKey: sessionId, agent, tag: 'seed:x' }, 't')
    tags.decide([row.id], 'rejected', 't')
    return row.entityId
  }

  beforeEach(() => {
    memory = new SqliteMemory({ path: ':memory:' })
    tags = memory.tags()
  })
  afterEach(() => {
    memory.close()
  })

  it('add is born accepted, keeps display casing, and re-adding a rejected tag accepts it again', async () => {
    const conv = await conversation('codex:one')
    const tag = tags.add({ entityType: 'conversation', entityId: conv, tag: 'Project:TenPAL' }, 'phil')
    expect(tag).toMatchObject({
      entityId: conv,
      key: 'project',
      value: 'tenpal',
      display: 'TenPAL',
      source: 'user',
      state: 'accepted',
      decidedBy: 'phil',
    })
    expect(tag.decidedAt).toBeInstanceOf(Date)
    expect(tags.decide([tag.id], 'rejected', 'phil')).toEqual([tag.id])
    // Deciding to the state it already has changes nothing.
    expect(tags.decide([tag.id], 'rejected', 'phil')).toEqual([])
    expect(tags.list({ entityId: conv })).toEqual([])
    const again = tags.add({ entityType: 'conversation', entityId: conv, key: 'project', value: 'tenpal' }, 'phil')
    expect(again.id).toBe(tag.id)
    expect(again.state).toBe('accepted')
    expect(again.display).toBe('TenPAL')
  })

  it('accepts a literal typed with a full-width colon and refuses a bad one', async () => {
    const conv = await conversation('codex:two')
    expect(tags.add({ entityType: 'conversation', entityId: conv, tag: 'topic：Wiki' }, 'p')).toMatchObject({
      key: 'topic',
      value: 'wiki',
      display: 'Wiki',
    })
    expect(() => tags.add({ entityType: 'conversation', entityId: conv, tag: 'nocolon' }, 'p')).toThrow(
      /invalid tag literal/,
    )
    expect(() => tags.add({ entityType: 'conversation', entityId: conv, key: 'topic' }, 'p')).toThrow(/required/)
    expect(() => tags.add({ entityType: 'conversation', tag: 'topic:x' }, 'p')).toThrow(/entity_id/)
  })

  it('propose writes suggestions, a rule tag is born accepted, and a rejected row blocks re-suggestion', async () => {
    const conv = await conversation('codex:three')
    const model = { source: 'model', proposedBy: 'gemma' }
    expect(
      tags.propose(
        'conversation',
        conv,
        [
          { key: 'Topic', value: 'Memory Compaction', display: 'Memory Compaction', confidence: 1.7, reason: 'why' },
          { key: 'topic', value: '   ' },
        ],
        model,
      ),
    ).toBe(1)
    const [pending] = tags.pending()
    expect(pending).toMatchObject({
      key: 'topic',
      value: 'memory-compaction',
      state: 'suggested',
      confidence: 1,
      proposedBy: 'gemma',
      sessionKey: 'codex:three',
      agent: 'rivet',
    })
    expect(pending.decidedBy).toBeUndefined()
    tags.decide([pending.id], 'rejected', 'phil')
    expect(tags.propose('conversation', conv, [{ key: 'topic', value: 'memory compaction' }], model)).toBe(0)
    expect(tags.pending()).toEqual([])

    expect(
      tags.propose('conversation', conv, [{ key: 'project', value: 'rivetos' }], {
        source: 'rule',
        proposedBy: 'cwd-git-root',
      }),
    ).toBe(1)
    expect(tags.list({ entityId: conv, key: 'project' })[0]).toMatchObject({
      state: 'accepted',
      source: 'rule',
      decidedBy: 'cwd-git-root',
    })
  })

  it('finds a session through its aliases in both directions, and never across harnesses', async () => {
    // Stored under Claude's path-fallback form; asked with the canonical id and the bare uuid.
    const conv = await conversation(`claude-code:-home-rivet-proj/${UUID}`)
    const added = tags.add(
      { entityType: 'conversation', sessionKey: `claude-code:${UUID}`, tag: 'project:rivetos' },
      'phil',
    )
    expect(added.entityId).toBe(conv)
    expect(tags.forSessionKeys([`claude-code:${UUID}`]).get(`claude-code:${UUID}`)?.map((t) => t.value)).toEqual([
      'rivetos',
    ])
    expect(tags.forSessionKeys([UUID]).get(UUID)).toHaveLength(1)
    // The same uuid under another harness does not answer a canonical ask.
    const codex = await conversation(`codex:${UUID}`)
    tags.add({ entityType: 'conversation', entityId: codex, tag: 'topic:codex-only' }, 'phil')
    expect(tags.forSessionKeys([`claude-code:${UUID}`]).get(`claude-code:${UUID}`)?.map((t) => t.value)).toEqual([
      'rivetos',
    ])
    // A bare uuid asks every harness.
    expect(tags.forSessionKeys([UUID]).get(UUID)?.map((t) => t.value).sort()).toEqual(['codex-only', 'rivetos'])
    expect(tags.forSessionKeys(['codex:unknown', '']).size).toBe(0)
  })

  it('a LIKE metacharacter in the harness id matches literally (the ESCAPE clause is live)', async () => {
    // Asking with `a_b:<uuid>` emits the pattern `a\_b:%/<uuid>`. Unescaped,
    // `_` would match the `x` in `axb` and the tag would land on the decoy.
    await conversation(`axb:slug/${UUID}`)
    expect(() =>
      tags.add({ entityType: 'conversation', sessionKey: `a_b:${UUID}`, tag: 'topic:x' }, 'p'),
    ).toThrow(/no conversation captured/)
    const real = await conversation(`a_b:slug/${UUID}`)
    expect(tags.add({ entityType: 'conversation', sessionKey: `a_b:${UUID}`, tag: 'topic:x' }, 'p').entityId).toBe(real)
    // An empty state list means the default, not invalid SQL.
    expect(tags.forSessionKeys(['codex:nothing'], []).size).toBe(0)
  })

  it('re-adding the cwd rule tag makes it a user tag', async () => {
    const conv = await conversation('codex:promote')
    tags.propose('conversation', conv, [{ key: 'project', value: 'rivetos' }], { source: 'rule', proposedBy: 'cwd-git-root' })
    expect(tags.add({ entityType: 'conversation', entityId: conv, tag: 'project:rivetos' }, 'phil')).toMatchObject({
      source: 'user',
      proposedBy: 'cwd-git-root',
      decidedBy: 'phil',
    })
  })

  it('refuses a session key that exists under two agents unless one is named', async () => {
    await conversation('codex:shared', 'rivet')
    const grok = await conversation('codex:shared', 'grok')
    expect(() => tags.add({ entityType: 'conversation', sessionKey: 'codex:shared', tag: 'topic:x' }, 'p')).toThrow(
      /several agents; pass agent/,
    )
    expect(
      tags.add({ entityType: 'conversation', sessionKey: 'codex:shared', agent: 'grok', tag: 'topic:x' }, 'p').entityId,
    ).toBe(grok)
    expect(() => tags.add({ entityType: 'conversation', sessionKey: 'codex:none', tag: 'topic:x' }, 'p')).toThrow(
      /no conversation captured/,
    )
  })

  it('counts accepted tags per conversation and lists the conversations carrying one', async () => {
    const a = await conversation('codex:a')
    const b = await conversation('codex:b')
    tags.add({ entityType: 'conversation', entityId: a, tag: 'project:TenPAL' }, 'p')
    tags.add({ entityType: 'conversation', entityId: b, tag: 'project:TenPAL' }, 'p')
    tags.add({ entityType: 'conversation', entityId: b, tag: 'topic:wiki' }, 'p')
    tags.propose('conversation', a, [{ key: 'topic', value: 'wiki' }], { source: 'model', proposedBy: 'm' })
    // A tag whose conversation does not exist is not a tagged conversation.
    tags.add({ entityType: 'conversation', entityId: 'gone', tag: 'project:tenpal' }, 'p')
    expect(tags.counts()).toEqual([
      { key: 'project', value: 'tenpal', display: 'TenPAL', conversations: 2 },
      { key: 'topic', value: 'wiki', display: 'wiki', conversations: 1 },
    ])
    expect(tags.counts('topic')).toHaveLength(1)
    expect(tags.conversationIdsWithTag('Project', 'TenPAL').sort()).toEqual([a, b].sort())
  })

  it('list filters by entity, key, value and state, accepted first', async () => {
    const conv = await conversation('codex:list')
    tags.propose('conversation', conv, [{ key: 'topic', value: 'b' }], { source: 'model', proposedBy: 'm' })
    tags.add({ entityType: 'conversation', entityId: conv, tag: 'topic:a' }, 'p')
    expect(tags.list({ entityType: 'conversation', entityId: conv }).map((t) => `${t.value}/${t.state}`)).toEqual([
      'a/accepted',
      'b/suggested',
    ])
    expect(tags.list({ entityId: conv, states: ['rejected'] }).map((t) => t.key)).toEqual(['seed'])
    expect(tags.list({ key: 'topic', value: 'A' })).toHaveLength(1)
    expect(tags.list({ entityId: conv, limit: 1 })).toHaveLength(1)
  })

  it('decides many ids in chunks, and refuses to work on a closed store', async () => {
    const conv = await conversation('codex:many')
    const proposals = Array.from({ length: 620 }, (_, n) => ({ key: 'topic', value: `v${String(n)}` }))
    expect(tags.propose('conversation', conv, proposals, { source: 'model', proposedBy: 'm' })).toBe(620)
    const ids = tags.list({ entityId: conv, states: ['suggested'], limit: 1000 }).map((t) => t.id)
    expect(ids).toHaveLength(620)
    expect(tags.decide(ids, 'accepted', 'phil')).toHaveLength(620)
    memory.close()
    expect(() => memory.tags()).toThrow(/closed/)
  })
})
