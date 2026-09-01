/**
 * Unit tests for assembleStatsReport — alerts-first ordering so truncated
 * MCP / capture payloads still surface stuck jobs and compaction health.
 * Pure string assembly — no Postgres required.
 */
import { describe, expect, it } from 'vitest'
import {
  assembleStatsReport,
  formatQueueHealth,
  fmtQueueAge,
  queryQueueHealth,
  QUEUE_HEALTH_SQL,
  type StatsReportBlocks,
} from './stats-tool.js'

function censusBlocks(overrides: Partial<StatsReportBlocks> = {}): StatsReportBlocks {
  return {
    headline: '\n**Messages:** 10\n**Date range:** 2026-02-15 → 2026-08-20',
    embeddingQueue: '\n**Embedding queue:** ⏳ 26 pending',
    unsummarized: '\n**Unsummarized messages:** 100 total',
    conversations: '\n**Conversations:** 5 total, 3 active',
    summaries: '\n**Summaries:** 12 total\n  leaf: 10 (max depth: 0)',
    embeddingCoverage: '\n**Embedding coverage:**\n  Messages: 9/10 (90.0%)',
    tree: '\n**Summary tree:**\n  Max depth: 2',
    freshness: '\n**Freshness:**\n  Newest message: just now',
    byAgent: '\n**By agent:**\n  rivet-claude: 8\n  rivet-grok: 2',
    byRole: '\n**By role:**\n  assistant: 6\n  user: 4',
    ...overrides,
  }
}

function sectionIndex(report: string, heading: string): number {
  return report.indexOf(heading)
}

describe('assembleStatsReport', () => {
  it('puts stuck jobs and orphans before the agent census', () => {
    const report = assembleStatsReport(
      censusBlocks({
        stuckJobs:
          "\n**⚠️ Stuck queue jobs (at max attempts, won't retry):**\n  extract-wiki: 25 dead",
        orphans: '\n**⚠️ Orphan leaf summaries (no source messages):** 3',
      }),
    )

    expect(report.startsWith('## Memory System Health')).toBe(true)

    const stuck = sectionIndex(report, '⚠️ Stuck queue jobs')
    const orphans = sectionIndex(report, '⚠️ Orphan leaf summaries')
    const queue = sectionIndex(report, '**Embedding queue:**')
    const unsum = sectionIndex(report, '**Unsummarized messages:**')
    const agent = sectionIndex(report, '**By agent:**')
    const summaries = sectionIndex(report, '**Summaries:**')

    expect(stuck).toBeGreaterThan(-1)
    expect(orphans).toBeGreaterThan(-1)
    expect(stuck).toBeLessThan(orphans)
    expect(orphans).toBeLessThan(queue)
    expect(queue).toBeLessThan(unsum)
    expect(unsum).toBeLessThan(agent)
    expect(agent).toBeLessThan(summaries)
  })

  it('keeps headline immediately after the header, before alerts', () => {
    const report = assembleStatsReport(
      censusBlocks({
        stuckJobs: "\n**⚠️ Stuck queue jobs (at max attempts, won't retry):**\n  x: 1 dead",
      }),
    )
    const header = sectionIndex(report, '## Memory System Health')
    const messages = sectionIndex(report, '**Messages:**')
    const stuck = sectionIndex(report, '⚠️ Stuck queue jobs')
    expect(header).toBe(0)
    expect(messages).toBeGreaterThan(header)
    expect(stuck).toBeGreaterThan(messages)
  })

  it('omits optional alert and census sections when absent', () => {
    const report = assembleStatsReport(
      censusBlocks({
        stuckJobs: undefined,
        orphans: undefined,
        eligibleConvs: undefined,
        byAgent: undefined,
        byRole: undefined,
      }),
    )
    expect(report).not.toContain('Stuck queue jobs')
    expect(report).not.toContain('Orphan leaf summaries')
    expect(report).not.toContain('By agent:')
    expect(report).not.toContain('By role:')
    expect(report).not.toContain('Top conversations eligible')
    expect(report).toContain('**Embedding queue:**')
    expect(report).toContain('**Unsummarized messages:**')
  })

  it('places eligible conversations with health, before the agent census', () => {
    const report = assembleStatsReport(
      censusBlocks({
        eligibleConvs:
          '\n**Top conversations eligible for compaction:**\n  rivet-grok: 31 unsummarized',
        stuckJobs:
          "\n**⚠️ Stuck queue jobs (at max attempts, won't retry):**\n  extract-wiki: 1 dead",
      }),
    )
    const stuck = sectionIndex(report, '⚠️ Stuck queue jobs')
    const eligible = sectionIndex(report, 'Top conversations eligible for compaction')
    const agent = sectionIndex(report, '**By agent:**')
    expect(stuck).toBeLessThan(eligible)
    expect(eligible).toBeLessThan(agent)
  })

  it('places queue health with the alerts, before the embedding queue', () => {
    const report = assembleStatsReport(
      censusBlocks({
        stuckJobs:
          "\n**⚠️ Stuck queue jobs (at max attempts, won't retry):**\n  extract-wiki: 1 dead",
        queueHealth:
          '\n**Queue health (graphile-worker):**\n  extract-wiki: 3 pending (oldest 45m), ⚠️ 1 dead',
      }),
    )
    const stuck = sectionIndex(report, '⚠️ Stuck queue jobs')
    const health = sectionIndex(report, '**Queue health (graphile-worker):**')
    const embedQueue = sectionIndex(report, '**Embedding queue:**')
    expect(health).toBeGreaterThan(stuck)
    expect(health).toBeLessThan(embedQueue)
  })
})

describe('formatQueueHealth', () => {
  it('renders pending, dead, oldest age, and a truncated error per task', () => {
    const block = formatQueueHealth([
      {
        task: 'extract-wiki',
        pending: '12',
        dead: '3435',
        oldest_pending_age_min: 45.2,
        last_error: 'LLM unreachable at http://pve3:8003/v1 (fetch failed)',
      },
      {
        task: 'compact-conversation',
        pending: '0',
        dead: '510',
        oldest_pending_age_min: null,
        last_error: 'deadlock detected',
      },
      {
        task: 'embed-target',
        pending: '7',
        dead: '0',
        oldest_pending_age_min: 900,
        last_error: null,
      },
    ])

    expect(block).toContain('**Queue health (graphile-worker):**')
    expect(block).toContain('extract-wiki: 12 pending (oldest 45m), ⚠️ 3,435 dead')
    expect(block).toContain('— LLM unreachable')
    expect(block).toContain('compact-conversation: 0 pending, ⚠️ 510 dead — deadlock detected')
    expect(block).toContain('embed-target: 7 pending (oldest 15h), 0 dead')
  })

  it('renders a present-but-empty queue as (empty), not omit/undefined', () => {
    expect(formatQueueHealth([])).toContain('(empty)')
  })

  it('clamps negative oldest ages to 0m', () => {
    expect(fmtQueueAge(-5)).toBe('0m')
    const block = formatQueueHealth([
      {
        task: 'embed-target',
        pending: '1',
        dead: '0',
        oldest_pending_age_min: -5,
        last_error: null,
      },
    ])
    expect(block).toContain('(oldest 0m)')
    expect(block).not.toContain('-5')
  })
})

describe('queryQueueHealth', () => {
  it('returns null on 42P01 (schema absent) instead of throwing', async () => {
    const rows = await queryQueueHealth(async () => {
      throw Object.assign(new Error('undefined table'), { code: '42P01' })
    })
    expect(rows).toBeNull()
  })

  it('returns [] for a present empty queue and uses QUEUE_HEALTH_SQL', async () => {
    const rows = await queryQueueHealth(async (sql) => {
      expect(sql).toBe(QUEUE_HEALTH_SQL)
      return { rows: [] }
    })
    expect(rows).toEqual([])
  })

  it('pending filter excludes locked/future run_at and last_error is latest not lex MAX', () => {
    expect(QUEUE_HEALTH_SQL).toContain("j.locked_at < now() - interval '4 hours'")
    expect(QUEUE_HEALTH_SQL).toContain('j.run_at <= now()')
    expect(QUEUE_HEALTH_SQL).toContain('array_agg(j.last_error ORDER BY j.updated_at DESC')
    expect(QUEUE_HEALTH_SQL).toContain('CASE WHEN MIN(')
    expect(QUEUE_HEALTH_SQL).toContain('IS NULL THEN NULL ELSE GREATEST(0,')
  })
})
