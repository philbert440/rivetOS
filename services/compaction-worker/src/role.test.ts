import { describe, expect, it } from 'vitest'
import { ALL_TASK_NAMES, buildWorkerPlan, parseWorkerRole, WORKER_ROLES } from './role.js'

describe('parseWorkerRole', () => {
  it('defaults unset to all', () => {
    expect(parseWorkerRole(undefined)).toBe('all')
  })

  it('accepts the three allowed values', () => {
    expect(parseWorkerRole('all')).toBe('all')
    expect(parseWorkerRole('compaction')).toBe('compaction')
    expect(parseWorkerRole('wiki')).toBe('wiki')
  })

  it('throws on anything else, naming the allowed values', () => {
    expect(() => parseWorkerRole('embedder')).toThrow(/all, compaction, wiki/)
    expect(() => parseWorkerRole('')).toThrow(/all, compaction, wiki/)
    expect(() => parseWorkerRole('Wiki')).toThrow(/WORKER_ROLE/)
  })
})

describe('buildWorkerPlan', () => {
  it("all + wikiExtraction on: union of today's tasks and crons including stale-wiki-sweep", () => {
    const plan = buildWorkerPlan({ workerRole: 'all', wikiExtraction: true })
    expect(plan.taskNames).toEqual([...ALL_TASK_NAMES])
    expect(plan.cronIdentifiers).toEqual([
      'idle-enqueue',
      'wiki-backfill',
      'stale-compaction-sweep',
      'reap-dead-jobs',
      'stale-wiki-sweep',
    ])
  })

  it('all + wikiExtraction off: same tasks, no stale-wiki-sweep cron', () => {
    const plan = buildWorkerPlan({ workerRole: 'all', wikiExtraction: false })
    expect(plan.taskNames).toEqual([...ALL_TASK_NAMES])
    expect(plan.cronIdentifiers).toEqual([
      'idle-enqueue',
      'wiki-backfill',
      'stale-compaction-sweep',
      'reap-dead-jobs',
    ])
    expect(plan.cronIdentifiers).not.toContain('stale-wiki-sweep')
  })

  it('compaction: compaction tasks/crons only, regardless of WIKI_EXTRACTION', () => {
    for (const wikiExtraction of [true, false]) {
      const plan = buildWorkerPlan({ workerRole: 'compaction', wikiExtraction })
      expect(plan.taskNames).toEqual([
        'compact-conversation',
        'synthesize-tool-call',
        'enqueue-idle',
        'enqueue-stale-compaction',
        'reap-dead-jobs',
      ])
      expect(plan.cronIdentifiers).toEqual([
        'idle-enqueue',
        'stale-compaction-sweep',
        'reap-dead-jobs',
      ])
      expect(plan.taskNames).not.toContain('extract-wiki')
      expect(plan.cronIdentifiers).not.toContain('wiki-backfill')
      expect(plan.cronIdentifiers).not.toContain('stale-wiki-sweep')
    }
  })

  it('wiki + wikiExtraction on: wiki tasks, wiki-backfill + stale-wiki-sweep', () => {
    const plan = buildWorkerPlan({ workerRole: 'wiki', wikiExtraction: true })
    expect(plan.taskNames).toEqual([
      'extract-wiki',
      'enqueue-wiki-backfill',
      'consolidate-wiki',
      'recompile-wiki',
      'enqueue-stale-wiki',
    ])
    expect(plan.cronIdentifiers).toEqual(['wiki-backfill', 'stale-wiki-sweep'])
    expect(plan.taskNames).not.toContain('compact-conversation')
    expect(plan.cronIdentifiers).not.toContain('idle-enqueue')
  })

  it('wiki + wikiExtraction off: wiki tasks still registered; only wiki-backfill cron', () => {
    const plan = buildWorkerPlan({ workerRole: 'wiki', wikiExtraction: false })
    expect(plan.taskNames).toEqual([
      'extract-wiki',
      'enqueue-wiki-backfill',
      'consolidate-wiki',
      'recompile-wiki',
      'enqueue-stale-wiki',
    ])
    expect(plan.cronIdentifiers).toEqual(['wiki-backfill'])
    expect(plan.cronIdentifiers).not.toContain('stale-wiki-sweep')
  })

  it('covers every declared WORKER_ROLE', () => {
    expect([...WORKER_ROLES]).toEqual(['all', 'compaction', 'wiki'])
  })
})
