import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

// Mock WikiIndex — the PG layer has its own suite; here we test tool shape.
const searchTopics = vi.fn()
const resolveTopic = vi.fn()
vi.mock('@rivetos/memory-postgres', () => ({
  WikiIndex: class {
    searchTopics = searchTopics
    resolveTopic = resolveTopic
  },
}))

import { createWikiTools } from './wiki.js'

describe('wiki tools (3g)', () => {
  let wikiDir: string
  beforeAll(() => {
    wikiDir = mkdtempSync(join(tmpdir(), 'wiki-mcp-'))
    mkdirSync(join(wikiDir, 'topics'))
    writeFileSync(
      join(wikiDir, 'topics', 'gerty.md'),
      '---\ntitle: GERTY\nslug: gerty\n---\n\n## Current state\n\npve3 lab.\n\n## History\n\n### 2026-07-01 — Setup\n\n- racked\n',
    )
  })
  afterAll(() => rmSync(wikiDir, { recursive: true, force: true }))

  const handle = () => createWikiTools({ pgUrl: 'postgres://x', wikiDir })

  it('wiki_search formats hits and the empty-gap message', async () => {
    const { tools } = handle()
    const search = tools.find((t) => t.name === 'wiki_search')!
    searchTopics.mockResolvedValueOnce([
      { slug: 'gerty', title: 'GERTY', currentState: 'pve3 lab.', lastVerifiedAt: '2026-07-01T00:00:00Z' },
    ])
    expect(await search.execute({ query: 'gerty' })).toContain('## GERTY (gerty) — verified 2026-07-01')
    searchTopics.mockResolvedValueOnce([])
    expect(await search.execute({ query: 'zilch' })).toContain('gap worth filling')
  })

  it('wiki_read returns the verbatim file; red link suggests candidates; bad slug rejected', async () => {
    const { tools } = handle()
    const read = tools.find((t) => t.name === 'wiki_read')!
    const md = await read.execute({ slug: 'gerty' })
    expect(md).toContain('## Current state')
    expect(md).toContain('### 2026-07-01 — Setup')

    resolveTopic.mockResolvedValueOnce({ candidates: [{ slug: 'gerty' }] })
    expect(await read.execute({ slug: 'gertee' })).toContain('Did you mean: gerty')
    expect(await read.execute({ slug: '../etc/passwd' })).toContain('Invalid slug')
  })

  it('malformed page degrades to raw-with-warning instead of throwing', async () => {
    writeFileSync(join(wikiDir, 'topics', 'broken.md'), 'no frontmatter here, human scribbles')
    const { tools } = handle()
    const read = tools.find((t) => t.name === 'wiki_read')!
    const out = await read.execute({ slug: 'broken' })
    expect(out).toContain('malformed')
    expect(out).toContain('human scribbles')
  })
})
