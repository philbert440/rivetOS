import { describe, it, expect } from 'vitest'
import { formatWikiRead, WIKI_READ_VERBATIM_MAX_CHARS } from './wiki-read-format.js'

function fatPage(opts: { aliases?: number; article?: string; extraHistory?: number } = {}): string {
  const n = opts.aliases ?? 3_000
  const aliases = Array.from({ length: n }, (_, i) => `  - alias-${String(i)}`).join('\n')
  const extraHistory = Array.from({ length: opts.extraHistory ?? 0 }, (_, i) => {
    const day = String(i + 1).padStart(2, '0')
    return `### 2026-07-${day} — Extra ${String(i)}\n\n- filler ${String(i)}\n`
  }).join('\n')
  const article = opts.article ?? 'The mesh runs on port 3000 with mTLS.'
  return `---
title: rivetOS
slug: rivetos
aliases:
${aliases}
tags:
  - rivetos
last_verified: 2026-08-21T00:00:00Z
---

## Summary

RivetOS is an open-source agent runtime and monorepo.

## Article

${article}

## See also

- [[memory-postgres]]
- [[stats-tool]]

## History

### 2026-08-21 — Daily job

- noted oversized page

${extraHistory}

## Citations

| Date | Kind | Summary | Note |
|------|------|---------|------|
| 2026-08-21 | leaf | \`aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\` | note |
`
}

const SMALL = `---
title: GERTY
slug: gerty
---

## Current state

pve3 lab.

## History

### 2026-07-01 — Setup

- racked
`

describe('formatWikiRead', () => {
  it('returns small pages verbatim', () => {
    const out = formatWikiRead(SMALL, { slug: 'gerty' })
    expect(out).toBe(SMALL)
    expect(out).toContain('## Current state')
    expect(out).toContain('### 2026-07-01 — Setup')
  })

  it('oversized default view leads with Summary, not the alias dump', () => {
    const md = fatPage()
    expect(md.length).toBeGreaterThan(WIKI_READ_VERBATIM_MAX_CHARS)
    expect(md.indexOf('alias-0')).toBeLessThan(md.indexOf('## Summary'))

    const out = formatWikiRead(md, { slug: 'rivetos' })
    expect(out.length).toBeLessThan(WIKI_READ_VERBATIM_MAX_CHARS)
    expect(out).toContain('⚠ Oversized wiki page "rivetos"')
    expect(out).toContain('## Summary')
    expect(out).toContain('RivetOS is an open-source agent runtime')
    expect(out).toContain('## Article')
    expect(out).toContain('The mesh runs on port 3000')
    expect(out).toContain('[[memory-postgres]]')
    expect(out).toContain('### 2026-08-21 — Daily job')

    const summaryAt = out.indexOf('## Summary')
    const aliasBullet = out.indexOf('- alias-0')
    expect(summaryAt).toBeGreaterThan(0)
    expect(aliasBullet).toBe(-1)
    expect(out).toMatch(/aliases: 3,000 \(showing 8:/)
    expect(out).toContain('section=aliases')
  })

  it('section=full is refused on oversized pages and still returns the encyclopedia view', () => {
    const out = formatWikiRead(fatPage(), { slug: 'rivetos', section: 'full' })
    expect(out).toContain('section=full refused')
    expect(out).toContain('## Summary')
    expect(out).toContain('RivetOS is an open-source agent runtime')
    expect(out).not.toContain('- alias-0')
  })

  it('section=full on a small page is verbatim', () => {
    expect(formatWikiRead(SMALL, { slug: 'gerty', section: 'full' })).toBe(SMALL)
  })

  it('section=summary / article / history / aliases / citations slice the page', () => {
    const md = fatPage({ extraHistory: 12 })
    const summary = formatWikiRead(md, { slug: 'rivetos', section: 'summary' })
    expect(summary).toContain('section=summary')
    expect(summary).toContain('RivetOS is an open-source agent runtime')
    expect(summary).not.toContain('## Article')

    const article = formatWikiRead(md, { slug: 'rivetos', section: 'article' })
    expect(article).toContain('section=article')
    expect(article).toContain('The mesh runs on port 3000')

    const history = formatWikiRead(md, { slug: 'rivetos', section: 'history' })
    expect(history).toContain('section=history')
    expect(history).toContain('### 2026-08-21 — Daily job')
    expect(history).toContain('### 2026-07-01 — Extra 0')

    const aliases = formatWikiRead(md, { slug: 'rivetos', section: 'aliases' })
    expect(aliases).toContain('section=aliases')
    expect(aliases).toContain('- alias-0')
    expect(aliases).toContain('- alias-199')
    expect(aliases).not.toContain('- alias-200')
    expect(aliases).toMatch(/2,800 more/)

    const citations = formatWikiRead(md, { slug: 'rivetos', section: 'citations' })
    expect(citations).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    expect(citations).toContain('| Date | Kind | Summary | Note |')
  })

  it('caps a long article and points at section=article', () => {
    const article = `${'paragraph\n\n'.repeat(4)}${'x'.repeat(12_000)}`
    const out = formatWikiRead(fatPage({ article }), { slug: 'rivetos' })
    expect(out).toContain('more chars — wiki_read slug=rivetos section=article')
    expect(out.length).toBeLessThan(20_000)
  })

  it('malformed small pages stay raw-with-warning; oversized malformed pages are capped', () => {
    const small = formatWikiRead('no frontmatter here', { slug: 'broken' })
    expect(small).toContain('malformed')
    expect(small).toContain('no frontmatter here')

    const hugeRaw = `no frontmatter\n${'y'.repeat(WIKI_READ_VERBATIM_MAX_CHARS + 100)}`
    const huge = formatWikiRead(hugeRaw, { slug: 'broken' })
    expect(huge).toContain('malformed')
    expect(huge).toContain('also oversized')
    expect(huge.length).toBeLessThan(hugeRaw.length)
    expect(huge).toContain('more chars')
  })
})
