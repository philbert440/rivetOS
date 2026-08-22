/**
 * Unit tests for assembleStatsReport — alerts-first ordering so truncated
 * MCP / capture payloads still surface stuck jobs and compaction health.
 * Pure string assembly — no Postgres required.
 */
import { describe, expect, it } from 'vitest'
import { assembleStatsReport, type StatsReportBlocks } from './stats-tool.js'

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
})
