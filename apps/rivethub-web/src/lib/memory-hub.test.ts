import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  hubViewTabs,
  tocMode,
  topicRowDensity,
  topicRowModel,
  wikiShellMode,
} from './memory-hub.js'

describe('hubViewTabs', () => {
  it('is main · all · recent · gaps in that order', () => {
    expect(hubViewTabs().map((t) => t.id)).toEqual(['main', 'all', 'recent', 'gaps'])
  })

  it('keeps the desktop aside labels (pixel-identical wide chrome)', () => {
    expect(hubViewTabs().map((t) => t.label)).toEqual([
      'Main page',
      'All topics',
      'Recent changes',
      'Gaps',
    ])
    expect(hubViewTabs(12).find((t) => t.id === 'all')?.label).toBe('All topics (12)')
  })

  it('shortLabels are compact chips, not the wide nav copy', () => {
    expect(hubViewTabs(99).map((t) => t.shortLabel)).toEqual(['Main', 'All', 'Recent', 'Gaps'])
    for (const tab of hubViewTabs(99)) {
      expect(tab.shortLabel.includes('(')).toBe(false)
      expect(tab.shortLabel.length).toBeLessThan(tab.label.length + 1)
    }
  })
})

describe('topicRowModel', () => {
  it('taps through to /memory/$slug with title + staleness', () => {
    const row = topicRowModel({
      title: 'Task engine',
      slug: 'task-engine',
      updatedAt: new Date().toISOString(),
      excerpt: 'The engine that runs tasks',
    })
    expect(row.href).toBe('/memory/task-engine')
    expect(row.title).toBe('Task engine')
    expect(row.excerpt).toBe('The engine that runs tasks')
    expect(row.staleness.kind).toBe('fresh')
    expect(row.staleness.label).toBe('current')
  })

  it('falls excerpt back to the slug and flags never-verified', () => {
    const row = topicRowModel({ title: 'Orphan', slug: 'orphan' })
    expect(row.excerpt).toBe('orphan')
    expect(row.staleness.kind).toBe('never')
    expect(row.staleness.label).toBe('never verified')
  })
})

describe('narrow vs wide chrome', () => {
  it('stacks the wiki shell only on narrow', () => {
    expect(wikiShellMode(false)).toBe('aside')
    expect(wikiShellMode(true)).toBe('stacked')
  })

  it('moves Contents to a disclosure only on narrow', () => {
    expect(tocMode(false)).toBe('panel')
    expect(tocMode(true)).toBe('disclosure')
  })

  it('compacts topic rows (no excerpt) only on narrow', () => {
    expect(topicRowDensity(false)).toBe('full')
    expect(topicRowDensity(true)).toBe('compact')
  })
})

describe('narrow wiki wiring (memory.tsx source)', () => {
  const src = readFileSync(new URL('../pages/memory.tsx', import.meta.url), 'utf8')

  it('branches WikiShell on wikiShellMode stacked vs the desktop aside', () => {
    expect(src).toContain("wikiShellMode(narrow) === 'stacked'")
    expect(src).toContain(
      'flex w-52 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel/90',
    )
  })

  it('renders Contents as a <details> disclosure on narrow', () => {
    expect(src).toContain("tocMode(narrow) === 'disclosure'")
    expect(src).toContain('<details')
    expect(src).toContain('Contents')
  })

  it('compact topic rows hide the excerpt', () => {
    expect(src).toContain('topicRowDensity(narrow)')
    expect(src).toContain("=== 'compact'")
  })

  it('topic back affordance still targets /memory', () => {
    expect(src).toContain('to="/memory"')
    expect(src).toContain("search={{ tab: 'wiki' }}")
  })
})

describe('narrow MemoryHubNav (MemoryHubNav.tsx source)', () => {
  const src = readFileSync(new URL('../memory/MemoryHubNav.tsx', import.meta.url), 'utf8')

  it('scrolls the Search/Wiki/Browse/Stats strip on narrow without changing the wide class string', () => {
    expect(src).toContain(
      'flex shrink-0 items-center gap-1 border-b border-line bg-panel/60 px-3 py-2',
    )
    expect(src).toContain('overflow-x-auto')
  })
})
