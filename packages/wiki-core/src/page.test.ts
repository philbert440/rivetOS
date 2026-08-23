import { describe, it, expect } from 'vitest'
import {
  applyArticlePatches,
  applyPatch,
  ALIASES_MAX,
  buildWikiSearchText,
  capList,
  capSummary,
  capTail,
  CITATIONS_MAX,
  demoteH2Headings,
  ENTITIES_MAX,
  extractWikiLinks,
  HISTORY_MAX,
  mergePages,
  normalizeSlug,
  parseWikiPage,
  RELATED_MAX,
  serializeWikiPage,
  SOURCES_MAX,
  SUMMARY_MAX_CHARS,
  TAGS_MAX,
  WikiParseError,
} from './index.js'
import type { WikiPage } from './index.js'

const SAMPLE = `---
title: RivetOS Task Engine
slug: rivetos-task-engine
aliases:
  - task-engine
tags:
  - rivetos
entities:
  - project:rivetos
last_verified: 2026-07-06T18:00:00Z
sources:
  - kind: summary
    ids:
      - 8f3a0000-0000-0000-0000-000000000001
    conversationId: c1d20000-0000-0000-0000-000000000002
---

## Current state

ros_tasks is the only orchestration engine. Gateway lives on :5174.

## History

### 2026-07-06 — Phase 1 cutover shipped

- Legacy tables archived in 0003.
- **Provenance:** summary 8f3a…

### 2026-05-20 — Design locked

- HarnessExecutor contract in @rivetos/types.
`

describe('parse / serialize round trip', () => {
  it('parses frontmatter, current state, and dated history', () => {
    const page = parseWikiPage(SAMPLE)
    expect(page.meta.slug).toBe('rivetos-task-engine')
    expect(page.meta.aliases).toEqual(['task-engine'])
    expect(page.meta.sources[0].ids).toHaveLength(1)
    expect(page.currentState).toContain('only orchestration engine')
    expect(page.history).toHaveLength(2)
    expect(page.history[0]).toMatchObject({ date: '2026-07-06', title: 'Phase 1 cutover shipped' })
    expect(page.history[1].body).toContain('HarnessExecutor')
  })

  it('round-trips stably', () => {
    const once = serializeWikiPage(parseWikiPage(SAMPLE))
    const twice = serializeWikiPage(parseWikiPage(once))
    expect(twice).toBe(once)
  })

  it('rejects pages without frontmatter / title / slug', () => {
    expect(() => parseWikiPage('# no frontmatter')).toThrow(WikiParseError)
    expect(() => parseWikiPage('---\nslug: x\n---\n')).toThrow(/title/)
    expect(() => parseWikiPage('---\ntitle: x\n---\n')).toThrow(/slug/)
  })
})

describe('applyPatch', () => {
  it('create seeds a page; update replaces current state and archives the prior one', () => {
    const created = applyPatch(undefined, {
      action: 'create',
      slug: 'GERTY vLLM!',
      title: 'GERTY vLLM',
      currentState: 'v1 state',
      verifiedAt: '2026-07-07T00:00:00Z',
    })
    expect(created.meta.slug).toBe('gerty-vllm')
    expect(created.currentState).toBe('v1 state')
    expect(created.history).toHaveLength(0) // nothing to archive on create

    const updated = applyPatch(created, {
      action: 'update',
      slug: 'gerty-vllm',
      currentState: 'v2 state',
      historyEntry: { date: '2026-07-08', title: 'Cutover', body: '- moved to v2' },
      verifiedAt: '2026-07-08T00:00:00Z',
    })
    expect(updated.currentState).toBe('v2 state')
    // auto-merge everywhere: prior state archived, then the explicit entry
    const titles = updated.history.map((h) => h.title)
    expect(titles).toContain('Superseded current state')
    expect(titles).toContain('Cutover')
    expect(updated.history.find((h) => h.title === 'Superseded current state')?.body).toBe(
      'v1 state',
    )
  })

  it('identical current state does not archive; duplicate history/sources dedupe', () => {
    const base: WikiPage = parseWikiPage(SAMPLE)
    const patched = applyPatch(base, {
      action: 'update',
      slug: base.meta.slug,
      currentState: base.currentState,
      historyEntry: {
        date: '2026-07-06',
        title: 'Phase 1 cutover shipped',
        body: base.history[0].body,
      },
      addSources: base.meta.sources,
      verifiedAt: '2026-07-09T00:00:00Z',
    })
    expect(patched.history).toHaveLength(2) // no dup entry, no archive
    expect(patched.meta.sources).toHaveLength(1)
    expect(patched.meta.lastVerified).toBe('2026-07-09T00:00:00Z')
  })

  it('unions aliases/tags/entities', () => {
    const page = applyPatch(parseWikiPage(SAMPLE), {
      action: 'update',
      slug: 'rivetos-task-engine',
      addAliases: ['task-engine', 'ros-tasks'],
      addTags: ['infrastructure'],
      verifiedAt: '2026-07-09T00:00:00Z',
    })
    expect(page.meta.aliases).toEqual(['task-engine', 'ros-tasks'])
    expect(page.meta.tags).toEqual(['rivetos', 'infrastructure'])
  })

  it('caps aliases/tags/entities/related after union (hub-page bloat)', () => {
    const overflowAliases = Array.from({ length: ALIASES_MAX + 20 }, (_, i) => `alias-${i}`)
    const overflowTags = Array.from({ length: TAGS_MAX + 10 }, (_, i) => `tag-${i}`)
    const overflowEntities = Array.from({ length: ENTITIES_MAX + 10 }, (_, i) => `ent:${i}`)
    const overflowRelated = Array.from({ length: RELATED_MAX + 10 }, (_, i) => `rel-${i}`)
    const page = applyPatch(parseWikiPage(SAMPLE), {
      action: 'update',
      slug: 'rivetos-task-engine',
      addAliases: overflowAliases,
      addTags: overflowTags,
      addEntities: overflowEntities,
      addRelated: overflowRelated,
      verifiedAt: '2026-07-09T00:00:00Z',
    })
    // Existing entries kept first, then new, then sliced.
    expect(page.meta.aliases).toHaveLength(ALIASES_MAX)
    expect(page.meta.aliases[0]).toBe('task-engine')
    expect(page.meta.aliases[1]).toBe('alias-0')
    expect(page.meta.aliases).not.toContain(`alias-${ALIASES_MAX + 5}`)
    expect(page.meta.tags).toHaveLength(TAGS_MAX)
    expect(page.meta.tags[0]).toBe('rivetos')
    expect(page.meta.entities).toHaveLength(ENTITIES_MAX)
    expect(page.meta.related).toHaveLength(RELATED_MAX)
    expect(page.seeAlso).toHaveLength(RELATED_MAX)
  })
})

describe('frontmatter list caps', () => {
  it('serialize of an already-bloated page writes only the ceilings', () => {
    const bloated = parseWikiPage(SAMPLE)
    bloated.meta.aliases = Array.from({ length: 200 }, (_, i) => `a-${i}`)
    bloated.meta.tags = Array.from({ length: 200 }, (_, i) => `t-${i}`)
    bloated.meta.entities = Array.from({ length: 200 }, (_, i) => `e-${i}`)
    bloated.meta.related = Array.from({ length: 200 }, (_, i) => `r-${i}`)
    bloated.seeAlso = bloated.meta.related
    const round = parseWikiPage(serializeWikiPage(bloated))
    expect(round.meta.aliases).toHaveLength(ALIASES_MAX)
    expect(round.meta.aliases[0]).toBe('a-0')
    expect(round.meta.tags).toHaveLength(TAGS_MAX)
    expect(round.meta.entities).toHaveLength(ENTITIES_MAX)
    expect(round.meta.related.length).toBeLessThanOrEqual(RELATED_MAX)
    expect(round.seeAlso.length).toBeLessThanOrEqual(RELATED_MAX)
    // Second serialize is stable (no further loss).
    expect(serializeWikiPage(round)).toBe(
      serializeWikiPage(parseWikiPage(serializeWikiPage(round))),
    )
  })

  it('mergePages caps identity lists when consolidating losers', () => {
    const canonical = parseWikiPage(SAMPLE)
    canonical.meta.aliases = Array.from({ length: ALIASES_MAX - 2 }, (_, i) => `keep-${i}`)
    const loser = parseWikiPage(
      SAMPLE.replace('slug: rivetos-task-engine', 'slug: ros-tasks-shard'),
    )
    loser.meta.aliases = Array.from({ length: 40 }, (_, i) => `loser-${i}`)
    loser.meta.title = 'Ros Tasks Shard'
    const merged = mergePages(canonical, [loser])
    expect(merged.meta.aliases.length).toBeLessThanOrEqual(ALIASES_MAX)
    expect(merged.meta.aliases[0]).toBe('keep-0')
    // Loser slug is a useful alias and is unioned before the cap.
    expect(merged.meta.aliases).toContain('ros-tasks-shard')
  })

  it('buildWikiSearchText does not embed overflow aliases', () => {
    const page = parseWikiPage(SAMPLE)
    page.meta.aliases = Array.from({ length: 200 }, (_, i) => `unique-alias-token-${i}`)
    const text = buildWikiSearchText(page)
    expect(text).toContain('unique-alias-token-0')
    expect(text).not.toContain('unique-alias-token-199')
  })

  it('capList is a no-op under the ceiling', () => {
    expect(capList(['a', 'b'], 8)).toEqual(['a', 'b'])
    expect(capList(undefined, 8)).toEqual([])
  })

  it('capTail keeps the newest (last) entries of an append-only list', () => {
    expect(capTail(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd'])
    expect(capTail(['a', 'b'], 8)).toEqual(['a', 'b'])
    expect(capTail(undefined, 8)).toEqual([])
  })

  it('serialize of bloated provenance writes only the ceilings', () => {
    const bloated = parseWikiPage(SAMPLE)
    bloated.meta.sources = Array.from({ length: SOURCES_MAX + 40 }, (_, i) => ({
      kind: 'summary' as const,
      ids: [`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`],
    }))
    bloated.history = Array.from({ length: HISTORY_MAX + 20 }, (_, i) => ({
      date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      title: `entry-${i}`,
      body: `- note ${i}`,
    }))
    bloated.citations = Array.from({ length: CITATIONS_MAX + 20 }, (_, i) => ({
      summaryId: `11111111-1111-1111-1111-${String(i).padStart(12, '0')}`,
      date: '2026-08-22',
      kind: 'leaf',
    }))
    const round = parseWikiPage(serializeWikiPage(bloated))
    expect(round.meta.sources).toHaveLength(SOURCES_MAX)
    // Oldest-first append: keep the newest tail, drop source-0.
    expect(round.meta.sources[0].ids[0]).toContain(String(40).padStart(12, '0'))
    expect(round.meta.sources.at(-1)?.ids[0]).toContain(String(SOURCES_MAX + 39).padStart(12, '0'))
    expect(round.history).toHaveLength(HISTORY_MAX)
    expect(round.history[0].title).toBe('entry-0')
    expect(round.history).not.toContainEqual(expect.objectContaining({ title: 'entry-60' }))
    expect(round.citations).toHaveLength(CITATIONS_MAX)
    expect(round.citations[0].summaryId.endsWith(String(0).padStart(12, '0'))).toBe(true)
    expect(serializeWikiPage(round)).toBe(
      serializeWikiPage(parseWikiPage(serializeWikiPage(round))),
    )
  })

  it('applyPatch caps sources/history/citations after union', () => {
    const page = applyPatch(parseWikiPage(SAMPLE), {
      action: 'update',
      slug: 'rivetos-task-engine',
      addSources: Array.from({ length: SOURCES_MAX + 10 }, (_, i) => ({
        kind: 'summary' as const,
        ids: [`22222222-2222-2222-2222-${String(i).padStart(12, '0')}`],
      })),
      addCitations: Array.from({ length: CITATIONS_MAX + 10 }, (_, i) => ({
        summaryId: `33333333-3333-3333-3333-${String(i).padStart(12, '0')}`,
        date: '2026-08-23',
        kind: 'leaf',
      })),
      verifiedAt: '2026-08-23T00:00:00Z',
    })
    expect(page.meta.sources.length).toBeLessThanOrEqual(SOURCES_MAX)
    expect(page.citations.length).toBeLessThanOrEqual(CITATIONS_MAX)
    // Newest citations unshift, so the last added (index 0 of the overflow
    // batch is added last → ends up first after unshifts, then cap keeps it).
    expect(page.citations[0].summaryId.endsWith(String(CITATIONS_MAX + 9).padStart(12, '0'))).toBe(
      true,
    )
  })
})

describe('round-trip edge cases (#285 review)', () => {
  it('CRLF input parses; hyphen and en-dash history headings parse', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n').replace('— Phase 1', '- Phase 1')
    const page = parseWikiPage(crlf)
    expect(page.history[0].title).toBe('Phase 1 cutover shipped')
  })

  it('### inside fenced code does not split history; ## inside fence does not split sections', () => {
    const md = SAMPLE + '\n```\n### 2020-01-01 — not an entry\n## not a section\n```\n'
    const page = parseWikiPage(md)
    expect(page.history).toHaveLength(2)
    expect(page.history[1].body).toContain('### 2020-01-01')
  })

  it('preamble, extra sections, and unknown frontmatter keys survive round-trip', () => {
    // inject extra key + preamble + extra non-core section
    const md2 =
      SAMPLE.replace('last_verified:', 'touched_by: human\nlast_verified:') +
      '\n## Notes\n\n- hand note\n'
    const page = parseWikiPage(md2)
    expect(page.meta.extra).toEqual({ touched_by: 'human' })
    expect(page.extraSections).toEqual([{ heading: 'Notes', body: '- hand note' }])
    const round = parseWikiPage(serializeWikiPage(page))
    expect(round.meta.extra).toEqual({ touched_by: 'human' })
    expect(round.extraSections).toEqual(page.extraSections)
    expect(serializeWikiPage(round)).toBe(serializeWikiPage(page))
  })
})

describe('v7 wikipedia article model', () => {
  it('parses ## Summary as currentState and ## Article / See also', () => {
    const md = `---
title: Deckard 40B
slug: deckard-40b
aliases: []
tags: []
entities: []
related:
  - pve3
sources: []
---

## Summary

Lead paragraph about the model.

## Article

### Configuration

Runs on [[pve3]].

### Operations

vLLM on :8003.

## See also

- [[1cat-vllm]]
- [[rivetos]]

## History

### 2026-07-01 — First note

- hello
`
    const page = parseWikiPage(md)
    expect(page.currentState).toContain('Lead paragraph')
    expect(page.article).toContain('### Configuration')
    expect(page.seeAlso).toEqual(expect.arrayContaining(['pve3', '1cat-vllm', 'rivetos']))
    const round = parseWikiPage(serializeWikiPage(page))
    expect(round.currentState).toBe(page.currentState)
    expect(round.article).toContain('Configuration')
    expect(serializeWikiPage(round)).toContain('## Summary')
    expect(serializeWikiPage(round)).not.toContain('## Current state')
  })

  it('legacy ## Current state still parses as Summary', () => {
    const page = parseWikiPage(SAMPLE)
    expect(page.currentState).toContain('only orchestration engine')
    expect(page.article).toBe('')
  })

  it('summaryDelta folds; short full rewrite refuses shrink', () => {
    const base = parseWikiPage(SAMPLE)
    const long = 'A'.repeat(200) + ' standing facts about the task engine and ros_tasks.'
    const withLong = applyPatch(base, {
      action: 'update',
      slug: base.meta.slug,
      currentState: long,
      verifiedAt: '2026-07-10T00:00:00Z',
      allowShrink: true,
    })
    expect(withLong.currentState).toBe(long)

    const thrashed = applyPatch(withLong, {
      action: 'update',
      slug: base.meta.slug,
      currentState: 'tiny blurb',
      verifiedAt: '2026-07-11T00:00:00Z',
    })
    // Shrink guard: keep long + fold short
    expect(thrashed.currentState.length).toBeGreaterThan(100)
    expect(thrashed.currentState).toContain('standing facts')
    expect(thrashed.currentState).toContain('tiny blurb')

    const delta = applyPatch(withLong, {
      action: 'update',
      slug: base.meta.slug,
      summaryDelta: 'Also exposes GET /api/tasks.',
      verifiedAt: '2026-07-12T00:00:00Z',
    })
    expect(delta.currentState).toContain('standing facts')
    expect(delta.currentState).toContain('GET /api/tasks')
  })

  it('articlePatches merge by heading; extractWikiLinks harvested', () => {
    const art = applyArticlePatches('', [
      { heading: 'Role', mode: 'merge', body: 'Orchestration engine.' },
      { heading: 'Hosts', mode: 'merge', body: 'Lives with [[datahub]].' },
    ])
    expect(art).toContain('### Role')
    expect(art).toContain('### Hosts')
    const page = applyPatch(parseWikiPage(SAMPLE), {
      action: 'update',
      slug: 'rivetos-task-engine',
      articlePatches: [{ heading: 'Hosts', mode: 'merge', body: 'Lives with [[datahub]].' }],
      addRelated: ['ros-tasks'],
      verifiedAt: '2026-07-12T00:00:00Z',
    })
    expect(page.article).toContain('datahub')
    expect(page.seeAlso).toEqual(expect.arrayContaining(['datahub', 'ros-tasks']))
    expect(extractWikiLinks(page.article)).toContain('datahub')
  })

  it('demotes ## inside article so parse does not truncate; caps summary growth', () => {
    const demoted = demoteH2Headings('### Role\n\nA.\n\n## Configuration\n\nPort 8003.')
    expect(demoted).toContain('### Configuration')
    expect(demoted).not.toMatch(/^## Configuration/m)

    const page = applyPatch(parseWikiPage(SAMPLE), {
      action: 'update',
      slug: 'rivetos-task-engine',
      article: '### Role\n\nA thing.\n\n## Configuration\n\nPort 8003.\n\n### Ops\n\nRestart.',
      verifiedAt: '2026-07-12T00:00:00Z',
    })
    // Full article retained after demote + round-trip
    const round = parseWikiPage(serializeWikiPage(page))
    expect(round.article).toContain('### Configuration')
    expect(round.article).toContain('Port 8003')
    expect(round.article).toContain('### Ops')

    // Thrash against a maxed lead does not grow unboundedly
    const fat = 'Lead. '.repeat(Math.ceil(SUMMARY_MAX_CHARS / 6))
    let p = applyPatch(parseWikiPage(SAMPLE), {
      action: 'update',
      slug: 'rivetos-task-engine',
      currentState: fat,
      allowShrink: true,
      verifiedAt: '2026-07-13T00:00:00Z',
    })
    expect(p.currentState.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS)
    for (let i = 0; i < 12; i++) {
      p = applyPatch(p, {
        action: 'update',
        slug: 'rivetos-task-engine',
        currentState: `tiny thrash ${i}`,
        verifiedAt: `2026-07-14T${String(i).padStart(2, '0')}:00:00.000Z`,
      })
    }
    expect(p.currentState.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS)

    const { kept, overflow } = capSummary('a'.repeat(3000), 100)
    expect(kept.length).toBeLessThanOrEqual(100)
    expect(overflow.length).toBeGreaterThan(0)
  })

  it('filters self-links and normalizes addRelated', () => {
    const page = applyPatch(parseWikiPage(SAMPLE), {
      action: 'update',
      slug: 'rivetos-task-engine',
      article: 'See [[rivetos-task-engine]] and [[datahub]].',
      addRelated: ['Raw Host!', 'datahub'],
      verifiedAt: '2026-07-12T00:00:00Z',
    })
    expect(page.seeAlso).not.toContain('rivetos-task-engine')
    expect(page.seeAlso).toEqual(expect.arrayContaining(['datahub', 'raw-host']))
  })

  it('demotes ## inside historyEntry.body so it does not escape History', () => {
    const page = applyPatch(parseWikiPage(SAMPLE), {
      action: 'update',
      slug: 'rivetos-task-engine',
      historyEntry: {
        date: '2026-07-27',
        title: 'Ops note',
        body: '- did a thing\n\n## Configuration\n\nleaked out of history',
      },
      verifiedAt: '2026-07-27T00:00:00Z',
    })
    const md = serializeWikiPage(page)
    const round = parseWikiPage(md)
    const entry = round.history.find((h) => h.title === 'Ops note')
    expect(entry?.body).toContain('### Configuration')
    expect(entry?.body).toContain('leaked out of history')
    expect(round.extraSections?.some((s) => s.heading === 'Configuration')).toBeFalsy()
  })

  it('re-applying the same historyEntry dedups against the stored demoted body', () => {
    const entry = {
      date: '2026-07-27',
      title: 'Ops note',
      body: '- did a thing\n\n## Configuration\n\nleaked out of history',
    }
    const once = applyPatch(parseWikiPage(SAMPLE), {
      action: 'update',
      slug: 'rivetos-task-engine',
      historyEntry: entry,
      verifiedAt: '2026-07-27T00:00:00Z',
    })
    const twice = applyPatch(parseWikiPage(serializeWikiPage(once)), {
      action: 'update',
      slug: 'rivetos-task-engine',
      historyEntry: entry,
      verifiedAt: '2026-07-28T00:00:00Z',
    })
    expect(twice.history.filter((h) => h.title === 'Ops note')).toHaveLength(1)
  })

  it('applyPatch tolerates a pre-v7 page object missing the new fields', () => {
    // A page unpickled from a pre-v7 cache, or built by hand: no article,
    // seeAlso, citations, or meta.related. applyPatch dereferences all of
    // these, so it must normalize before touching them (as mergePages does).
    const legacy = {
      meta: {
        title: 'Legacy',
        slug: 'legacy',
        aliases: [],
        tags: [],
        entities: [],
        sources: [],
      },
      currentState: 'Old lead.',
      history: [],
    } as unknown as WikiPage

    const page = applyPatch(legacy, {
      action: 'update',
      slug: 'legacy',
      summaryDelta: 'Now also serves :9000.',
      articlePatches: [{ heading: 'Role', mode: 'merge', body: 'Runs on [[pve3]].' }],
      addRelated: ['datahub'],
      addCitations: [{ summaryId: '8f3a0000-0000-0000-0000-000000000009' }],
      verifiedAt: '2026-07-27T00:00:00Z',
    })

    expect(page.currentState).toContain('Old lead.')
    expect(page.currentState).toContain(':9000')
    expect(page.article).toContain('### Role')
    expect(page.citations).toHaveLength(1)
    expect(page.seeAlso).toEqual(expect.arrayContaining(['datahub', 'pve3']))
    // And the result is a well-formed page.
    expect(parseWikiPage(serializeWikiPage(page)).article).toContain('Runs on')
  })

  it('serialize demotes stray ## on paths that never reach applyPatch', () => {
    // Legacy on-disk history copied verbatim by mergePages, and a lead/article
    // written by hand — neither goes through applyPatch's demote.
    const canonical = parseWikiPage(SAMPLE)
    const loser = parseWikiPage(
      SAMPLE.replace('slug: rivetos-task-engine', 'slug: ros-tasks-shard'),
    )
    loser.history = [{ date: '2026-07-01', title: 'legacy', body: '- x\n\n## Stray\n\nescaped' }]
    const merged = mergePages(canonical, [loser])
    const mergedRound = parseWikiPage(serializeWikiPage(merged))
    expect(mergedRound.history.find((h) => h.title === 'legacy')?.body).toContain('escaped')
    expect(mergedRound.extraSections?.some((s) => s.heading === 'Stray')).toBeFalsy()

    const hand = parseWikiPage(SAMPLE)
    hand.currentState = 'Lead.\n\n## Stray\n\nescaped from the lead'
    hand.article = '### Role\n\nA.\n\n## Stray\n\nescaped from the article'
    const handRound = parseWikiPage(serializeWikiPage(hand))
    expect(handRound.currentState).toContain('escaped from the lead')
    expect(handRound.article).toContain('escaped from the article')
    expect(handRound.extraSections?.some((s) => s.heading === 'Stray')).toBeFalsy()

    // Idempotent: a second serialize pass changes nothing.
    expect(serializeWikiPage(handRound)).toBe(
      serializeWikiPage(parseWikiPage(serializeWikiPage(handRound))),
    )
  })
})

describe('normalizeSlug', () => {
  it('kebab-cases and bounds', () => {
    expect(normalizeSlug('  RivetOS Task Engine! ')).toBe('rivetos-task-engine')
    expect(normalizeSlug('--x--')).toBe('x')
    expect(normalizeSlug('a'.repeat(120))).toHaveLength(80)
  })
})

describe('citations (memory v6)', () => {
  it('applyPatch appends citations; serialize/parse round-trips the table', () => {
    const base = parseWikiPage(SAMPLE)
    const patched = applyPatch(base, {
      action: 'update',
      slug: base.meta.slug,
      addCitations: [
        {
          summaryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          date: '2026-07-25',
          kind: 'leaf',
          note: 'leaf batch on task engine',
        },
      ],
      verifiedAt: '2026-07-25T00:00:00Z',
    })
    expect(patched.citations).toHaveLength(1)
    const md = serializeWikiPage(patched)
    expect(md).toContain('## Citations')
    expect(md).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    const round = parseWikiPage(md)
    expect(round.citations[0]).toMatchObject({
      summaryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      date: '2026-07-25',
      kind: 'leaf',
      note: 'leaf batch on task engine',
    })
    // second apply with same id dedupes
    const again = applyPatch(round, {
      action: 'update',
      slug: base.meta.slug,
      addCitations: [
        { summaryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', note: 'dup' },
        { summaryId: '11111111-2222-3333-4444-555555555555', kind: 'leaf' },
      ],
      verifiedAt: '2026-07-26T00:00:00Z',
    })
    expect(again.citations).toHaveLength(2)
  })
})
