import { beforeEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import {
  WIKI_TAGS_MAX,
  acceptedTagsForSummary,
  mentionedIn,
  mergeTagCandidates,
  safeLiteral,
  withoutRuleEntities,
  resetWikiTagsWarnings,
  tagCandidateQuery,
  type WikiTag,
} from './wiki-tags.js'

const NOW = new Date('2026-10-02T12:00:00Z')
function row(
  entity_type: string,
  entity_id: string,
  key: string,
  value: string,
  display = '',
  source = 'user',
) {
  return {
    id: `${entity_type}-${key}-${value}`,
    entity_type,
    entity_id,
    // tagsForConversations keys its result by this column.
    conversation_id: entity_id,
    key,
    value,
    display,
    source,
    state: 'accepted',
    confidence: null,
    proposed_by: '',
    reason: '',
    decided_by: null,
    decided_at: null,
    created_at: NOW,
    updated_at: NOW,
  }
}

/** Pool that answers the summary query first, the conversation query second. */
function pool(summaryRows: unknown[], conversationRows: unknown[]) {
  const query = vi.fn(async (sql: string) =>
    String(sql).includes('entity_id = ANY') ? { rows: conversationRows } : { rows: summaryRows },
  )
  return { query } as unknown as pg.Pool & { query: typeof query }
}

const tag = (key: string, value: string, reviewed = true): WikiTag => ({
  literal: `${key}:${value}`,
  key,
  value,
  reviewed,
})

beforeEach(() => {
  resetWikiTagsWarnings()
})

describe('acceptedTagsForSummary', () => {
  it('marks the cwd rule tag as unreviewed, dedupes, and lists reviewed tags first', async () => {
    const p = pool(
      [row('summary', 's1', 'topic', 'wiki'), row('summary', 's1', 'topic', 'tagging', '', 'model')],
      [
        row('conversation', 'c1', 'project', 'rivetos', 'rivetOS', 'rule'),
        row('conversation', 'c1', 'topic', 'wiki'),
      ],
    )
    expect(await acceptedTagsForSummary(p, 's1', 'c1')).toEqual([
      { literal: 'topic:wiki', key: 'topic', value: 'wiki', reviewed: true },
      { literal: 'topic:tagging', key: 'topic', value: 'tagging', reviewed: true },
      { literal: 'project:rivetos', key: 'project', value: 'rivetos', reviewed: false },
    ])
    const calls = p.query.mock.calls.map(([, params]) => params)
    expect(calls).toContainEqual(['summary', 's1', ['accepted'], 200])
    expect(calls).toContainEqual([['c1'], ['accepted']])
  })

  it('a tag that is both the cwd rule tag and a reviewed tag counts as reviewed', async () => {
    const tags = await acceptedTagsForSummary(
      pool(
        [row('summary', 's1', 'project', 'rivetos', '', 'user')],
        [row('conversation', 'c1', 'project', 'rivetos', 'rivetOS', 'rule')],
      ),
      's1',
      'c1',
    )
    expect(tags).toEqual([{ literal: 'project:rivetos', key: 'project', value: 'rivetos', reviewed: true }])
  })

  it('an accepted tag from an unknown source is not treated as reviewed', async () => {
    const tags = await acceptedTagsForSummary(
      pool([row('summary', 's1', 'topic', 'auto', '', 'some-future-tagger')], []),
      's1',
      null,
    )
    expect(tags).toEqual([{ literal: 'topic:auto', key: 'topic', value: 'auto', reviewed: false }])
  })

  it('caps the list, reviewed tags first', async () => {
    const many = Array.from({ length: WIKI_TAGS_MAX + 9 }, (_, i) =>
      row('summary', 's', 'topic', `t${String(i)}`),
    )
    const rule = row('conversation', 'c', 'project', 'x', '', 'rule')
    const tags = await acceptedTagsForSummary(pool(many, [rule]), 's', 'c')
    expect(tags).toHaveLength(WIKI_TAGS_MAX)
    expect(tags.every((t) => t.reviewed)).toBe(true)
  })

  it('shows the canonical lowercase literal, not the display casing (entity ids are case-sensitive)', async () => {
    const tags = await acceptedTagsForSummary(
      pool([], [row('conversation', 'c', 'project', 'tenpal', 'TenPAL')]),
      's',
      'c',
    )
    expect(tags[0].literal).toBe('project:tenpal')
  })

  it('skips the conversation lookup without a conversation id', async () => {
    const p = pool([], [])
    expect(await acceptedTagsForSummary(p, 's', null)).toEqual([])
    expect(p.query).toHaveBeenCalledTimes(1)
  })

  it('degrades to no tags when only the summary lookup fails on a pre-0019 schema, warning once', async () => {
    const log = vi.fn()
    const query = vi.fn(async (sql: string) => {
      if (!String(sql).includes('entity_id = ANY')) throw new Error('relation "ros_tags" does not exist')
      return { rows: [] }
    })
    const p = { query } as unknown as pg.Pool
    expect(await acceptedTagsForSummary(p, 's', 'c', log)).toEqual([])
    expect(await acceptedTagsForSummary(p, 's', 'c', log)).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/migration 0019/)
  })

  it('degrades on any other lookup failure too (tags are optional), and says why every time', async () => {
    const log = vi.fn()
    const p = {
      query: vi.fn(async () => {
        throw new Error('operator does not exist: text = uuid')
      }),
    } as unknown as pg.Pool
    expect(await acceptedTagsForSummary(p, 's', 'c', log)).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('tag lookup failed'))
    expect(log.mock.calls[0][0]).not.toMatch(/migration 0019/)
  })
})

describe('safeLiteral', () => {
  it('is one line with no markdown structure, bounded by code point', () => {
    expect(safeLiteral({ key: 'project', value: 'x\n## y `z`' })).toBe('project:x y z')
    const long = safeLiteral({ key: 'topic', value: '\u{1F600}'.repeat(200) })
    expect(Array.from(long)).toHaveLength(80)
    expect(long.endsWith('\u{1F600}')).toBe(true)
  })
})

describe('mentionedIn / withoutRuleEntities', () => {
  it('matches whole tokens only', () => {
    expect(mentionedIn('tuned postgres on the database host', 'os')).toBe(false)
    expect(mentionedIn('tuned postgres on the database host', 'db')).toBe(false)
    expect(mentionedIn('the OS image and the db.', 'os')).toBe(true)
    expect(mentionedIn('worked on My App login', 'my-app')).toBe(true)
    expect(mentionedIn('c++ and a.b notes', 'a.b')).toBe(true)
  })

  it('drops an entity that is only the automatic rule tag, case-insensitively, and keeps reviewed ones', () => {
    const tags = [tag('project', 'rivetos', false), tag('project', 'tenpal', true)]
    expect(
      withoutRuleEntities(['project:RivetOS', 'project:tenpal', 'host:hv-c'], tags),
    ).toEqual(['project:tenpal', 'host:hv-c'])
    expect(withoutRuleEntities(undefined, tags)).toBeUndefined()
    expect(withoutRuleEntities(['project:rivetos'], [tag('project', 'rivetos', true)])).toEqual(['project:rivetos'])
  })
})

describe('tagCandidateQuery', () => {
  it('uses reviewed project then topic tags, keeping identifiers verbatim plus a de-dashed form', () => {
    expect(
      tagCandidateQuery(
        [tag('topic', 'memory-compaction'), tag('project', 'deckard-40b'), tag('repo', 'x')],
        'unrelated summary',
      ),
    ).toBe('deckard-40b deckard 40b memory-compaction memory compaction')
  })

  it('uses the automatic cwd tag only when the summary mentions it', () => {
    const rule = [tag('project', 'rivetos', false)]
    expect(tagCandidateQuery(rule, 'Tuned Postgres autovacuum on the datahub host.')).toBeNull()
    expect(tagCandidateQuery(rule, 'Fixed the RivetOS compaction worker.')).toBe('rivetos')
    const dashed = [tag('project', 'my-app', false)]
    expect(tagCandidateQuery(dashed, 'worked on My App login')).toBe('my-app my app')
  })

  it('is null without usable project or topic tags', () => {
    expect(tagCandidateQuery([], 's')).toBeNull()
    expect(tagCandidateQuery([tag('repo', 'x')], 's')).toBeNull()
    expect(tagCandidateQuery([tag('project', '')], 's')).toBeNull()
  })
})

describe('mergeTagCandidates', () => {
  const h = (slug: string) => ({ slug, title: slug })
  it('appends unseen tag hits, marks them, caps them, and never mutates its inputs', () => {
    const hits = [h('a'), h('b')]
    const tagHits = [h('b'), h('c'), h('c'), h('d'), h('e')]
    const merged = mergeTagCandidates(hits, tagHits, 2)
    expect(merged).toEqual([
      { slug: 'a', title: 'a' },
      { slug: 'b', title: 'b' },
      { slug: 'c', title: 'c', fromTag: true },
      { slug: 'd', title: 'd', fromTag: true },
    ])
    expect(hits).toHaveLength(2)
    expect(tagHits).toHaveLength(5)
  })
  it('returns the content hits unchanged when there are no tag hits', () => {
    expect(mergeTagCandidates([h('a')], [], 3)).toEqual([{ slug: 'a', title: 'a' }])
  })
})
