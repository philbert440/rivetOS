import { describe, it, expect } from 'vitest'
import { applyPatch, normalizeSlug, parseWikiPage, serializeWikiPage, WikiParseError } from './index.js'
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

describe('normalizeSlug', () => {
  it('kebab-cases and bounds', () => {
    expect(normalizeSlug('  RivetOS Task Engine! ')).toBe('rivetos-task-engine')
    expect(normalizeSlug('--x--')).toBe('x')
    expect(normalizeSlug('a'.repeat(120))).toHaveLength(80)
  })
})
