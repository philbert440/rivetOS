/**
 * Unit tests for memory_search degraded-mode banner.
 */
import { describe, expect, it } from 'vitest'
import type { SearchEngine, SearchHit, SearchResults } from '../search.js'
import type { Expander } from '../expand.js'
import { createSearchTool } from './search-tool.js'
import { formatVectorArmUnavailable } from './helpers.js'

const HIT: SearchHit = {
  id: 'm1',
  type: 'message',
  content: 'we decided families.app is the package name',
  role: 'user',
  agent: 'grok',
  conversationId: 'c1',
  score: 0.42,
  createdAt: new Date('2026-08-12T18:00:00.000Z'),
}

const expander = { expandDeep: async () => null } as unknown as Expander

function fakeEngine(results: SearchResults): SearchEngine {
  return { search: async () => results } as unknown as SearchEngine
}

describe('formatVectorArmUnavailable', () => {
  it('matches the specified banner line for hybrid/fts', () => {
    expect(formatVectorArmUnavailable('timeout')).toBe(
      '⚠ vector arm unavailable (timeout) — results are fts/trigram only',
    )
    expect(formatVectorArmUnavailable('timeout', 'hybrid')).toBe(
      '⚠ vector arm unavailable (timeout) — results are fts/trigram only',
    )
    expect(formatVectorArmUnavailable('timeout', 'fts')).toBe(
      '⚠ vector arm unavailable (timeout) — results are fts/trigram only',
    )
  })

  it('uses vector-mode copy', () => {
    expect(formatVectorArmUnavailable('timeout', 'vector')).toBe(
      '⚠ vector arm unavailable (timeout) — no results',
    )
    expect(formatVectorArmUnavailable('timeout', 'vector', 0)).toBe(
      '⚠ vector arm unavailable (timeout) — no results',
    )
    expect(formatVectorArmUnavailable('timeout', 'vector', 3)).toBe(
      '⚠ vector arm unavailable (timeout) — showing fts fallback results',
    )
  })

  it('is empty for trigram and regex', () => {
    expect(formatVectorArmUnavailable('timeout', 'trigram')).toBe('')
    expect(formatVectorArmUnavailable('timeout', 'regex')).toBe('')
  })
})

describe('memory_search degraded banner', () => {
  it('prints the warning as the first line when the vector arm dropped', async () => {
    const results = Object.assign([HIT], {
      degraded: { vector: true as const, reason: 'timeout' },
    }) as SearchResults
    const tool = createSearchTool(fakeEngine(results), expander)
    const out = await tool.execute({ query: 'families.app', expand: false })
    expect(out.startsWith('⚠ vector arm unavailable (timeout) — results are fts/trigram only')).toBe(
      true,
    )
    expect(out).toContain('## Memory Search:')
    expect(out).toContain('families.app')
  })

  it('still prints the warning on an empty result set', async () => {
    const results = Object.assign([], {
      degraded: { vector: true as const, reason: 'http 503' },
    }) as SearchResults
    const tool = createSearchTool(fakeEngine(results), expander)
    const out = await tool.execute({ query: 'nope', expand: false })
    expect(out.startsWith('⚠ vector arm unavailable (http 503) — results are fts/trigram only')).toBe(
      true,
    )
    expect(out).toContain('No results found')
  })

  it('does not print the warning when the vector arm ran', async () => {
    const results = [HIT] as SearchResults
    const tool = createSearchTool(fakeEngine(results), expander)
    const out = await tool.execute({ query: 'families.app', expand: false })
    expect(out).not.toContain('vector arm unavailable')
    expect(out).toContain('## Memory Search:')
  })

  it('uses vector-mode banner copy', async () => {
    const results = Object.assign([], {
      degraded: { vector: true as const, reason: 'timeout' },
    }) as SearchResults
    const tool = createSearchTool(fakeEngine(results), expander)
    const out = await tool.execute({ query: 'nope', mode: 'vector', expand: false })
    expect(out.startsWith('⚠ vector arm unavailable (timeout) — no results')).toBe(true)
  })

  it('uses vector-mode banner copy when FTS fallback returned hits', async () => {
    const results = Object.assign([HIT], {
      degraded: { vector: true as const, reason: 'timeout' },
    }) as SearchResults
    const tool = createSearchTool(fakeEngine(results), expander)
    const out = await tool.execute({ query: 'families.app', mode: 'vector', expand: false })
    expect(
      out.startsWith('⚠ vector arm unavailable (timeout) — showing fts fallback results'),
    ).toBe(true)
    expect(out).toContain('## Memory Search:')
    expect(out).toContain(HIT.content)
  })

  it('never emits the banner in trigram or regex mode', async () => {
    const results = Object.assign([HIT], {
      degraded: { vector: true as const, reason: 'timeout' },
    }) as SearchResults
    const tool = createSearchTool(fakeEngine(results), expander)
    const trigram = await tool.execute({ query: 'families.app', mode: 'trigram', expand: false })
    const regex = await tool.execute({ query: 'families.app', mode: 'regex', expand: false })
    expect(trigram).not.toContain('vector arm unavailable')
    expect(regex).not.toContain('vector arm unavailable')
  })

  it('renders degraded banner together with fallback hits', async () => {
    const hit = { ...HIT, fallback: 'trigram' as const }
    const results = Object.assign([hit], {
      degraded: { vector: true as const, reason: 'timeout' },
      fallback: 'trigram' as const,
    }) as SearchResults
    const tool = createSearchTool(fakeEngine(results), expander)
    const out = await tool.execute({ query: 'state-of-the-art model', expand: false })
    expect(out.startsWith('⚠ vector arm unavailable (timeout) — results are fts/trigram only')).toBe(
      true,
    )
    expect(out).toContain('## Memory Search:')
    expect(out).toContain(HIT.content)
  })
})
