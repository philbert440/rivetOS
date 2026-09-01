/**
 * Unit tests for memory_stats search-runtime counters.
 */
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { assembleStatsReport, createStatsTool, formatSearchRuntimeStats } from './stats-tool.js'
import type { StatsReportBlocks } from './stats-tool.js'

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

describe('formatSearchRuntimeStats', () => {
  it('exposes vectorArmDropped, last-hour, and query-embed cache counters', () => {
    const block = formatSearchRuntimeStats({
      vectorArmDropped: 3,
      vectorArmDroppedLastHour: 1,
      queryEmbedCacheHits: 12,
      queryEmbedCacheMisses: 4,
      chunkArmHits: 7,
      parentArmHits: 5,
      chunkArmUnavailable: 0,
    })
    expect(block).toContain('**Search runtime:**')
    expect(block).toContain('vectorArmDropped: 3')
    expect(block).toContain('vectorArmDroppedLastHour: 1')
    expect(block).toContain('queryEmbedCacheHits: 12')
    expect(block).toContain('queryEmbedCacheMisses: 4')
    expect(block).toContain('chunkArmHits: 7')
    expect(block).toContain('parentArmHits: 5')
    expect(block).toContain('chunkArmUnavailable: 0')
  })
})

describe('assembleStatsReport search runtime', () => {
  it('places search runtime after the embedding queue and before unsummarized', () => {
    const report = assembleStatsReport(
      censusBlocks({
        searchRuntime: formatSearchRuntimeStats({
          vectorArmDropped: 0,
          vectorArmDroppedLastHour: 0,
          queryEmbedCacheHits: 4,
          queryEmbedCacheMisses: 1,
          chunkArmHits: 0,
          parentArmHits: 0,
          chunkArmUnavailable: 0,
        }),
      }),
    )
    const queue = report.indexOf('**Embedding queue:**')
    const runtime = report.indexOf('**Search runtime:**')
    const unsum = report.indexOf('**Unsummarized messages:**')
    expect(runtime).toBeGreaterThan(queue)
    expect(unsum).toBeGreaterThan(runtime)
    expect(report).toContain('queryEmbedCacheHits: 4')
  })

  it('omits search runtime when not provided (backward compatible)', () => {
    const report = assembleStatsReport(censusBlocks())
    expect(report).not.toContain('Search runtime')
    expect(report).not.toContain('vectorArmDropped')
  })
})

describe('createStatsTool searchRuntime integration', () => {
  it('renders fake-engine counters in the report', async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            total: '0',
            oldest: null,
            newest: null,
            agent: 'grok',
            count: '0',
            role: 'user',
            active: '0',
            kind: 'leaf',
            max_depth: 0,
            msg_queue: '0',
            sum_queue: '0',
            unembeddable: '0',
            embedded: '0',
            eligible_msgs: '0',
            eligible_convs: '0',
            active_tail_msgs: '0',
            active_tail_convs: '0',
            below_floor_msgs: '0',
            below_floor_convs: '0',
            conversation_id: 'c',
            unsummarized: '0',
            trigger: 'idle_floor',
            task: 'x',
            oldest_run_at: null,
            sample_error: null,
            root_count: '0',
            child_count: '0',
            newest_message: null,
            newest_summary: null,
          },
        ],
      }),
    } as unknown as pg.Pool
    const tool = createStatsTool(pool, {
      searchRuntime: () => ({
        vectorArmDropped: 2,
        vectorArmDroppedLastHour: 1,
        queryEmbedCacheHits: 9,
        queryEmbedCacheMisses: 3,
        chunkArmHits: 4,
        parentArmHits: 11,
        chunkArmUnavailable: 1,
      }),
    })
    const out = await tool.execute({})
    expect(out).toContain('vectorArmDropped: 2')
    expect(out).toContain('vectorArmDroppedLastHour: 1')
    expect(out).toContain('queryEmbedCacheHits: 9')
    expect(out).toContain('queryEmbedCacheMisses: 3')
    expect(out).toContain('chunkArmHits: 4')
    expect(out).toContain('parentArmHits: 11')
    expect(out).toContain('chunkArmUnavailable: 1')
  })
})
