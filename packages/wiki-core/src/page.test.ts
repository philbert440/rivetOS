import { describe, it, expect } from 'vitest'
import {
  applyArticlePatches,
  applyPatch,
  capSummary,
  demoteH2Headings,
  extractWikiLinks,
  mergePages,
  normalizeSlug,
  parseWikiPage,
  serializeWikiPage,
  SUMMARY_MAX_CHARS,
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
      historyEntry: { date: '2026-07-06', title: 'Phase 1 cutover shipped', body: base.history[0].body },
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
    const loser = parseWikiPage(SAMPLE.replace('slug: rivetos-task-engine', 'slug: ros-tasks-shard'))
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
