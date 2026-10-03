import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentTupleHash } from '@rivetos/capture-core'
import { discoverModels } from '../src/identity.js'
import {
  applyBackfillTimestamps,
  backfillSession,
  backfillSourceId,
  contentHashForRow,
  dropSystemMessages,
  filterOverlap,
  formatIngestPagesCounts,
  ingestPages,
  listPageSpoolFiles,
  liveV4Session,
  parsePageFileName,
  type OverlapRow,
  type OverlapStore,
} from '../src/ingest-pages.js'
import { normalizeRecords } from '../src/normalize.js'
import { parsePageHeader } from '../src/parse.js'
import { assertReadOnlySql } from '../src/pg-readonly.js'
import { NEWEST_CREATED_SQL, ROWS_SINCE_SQL } from '../src/ingest-pages.js'
import { stripSessionSuffix } from '../src/types.js'
import { ALPHA_ID } from './ids.js'

function userTurn(text: string) {
  return { role: 'user', message: { content: [{ type: 'text', text }] } }
}

function assistantTurn(text: string) {
  return { role: 'assistant', message: { content: [{ type: 'text', text }] } }
}

function pageFile(
  dir: string,
  slug: string,
  before: number,
  a: number,
  records: unknown[],
  target = slug,
) {
  const b = a + records.length - 1
  const header = `Transcript of ${target}, positions ${String(a)}–${String(b)} of ${String(b + 1)}:`
  const body = [header, ...records.map((r) => JSON.stringify(r)), ''].join('\n')
  const name = `${slug}-${String(before)}.txt`
  writeFileSync(join(dir, name), body)
  return name
}

function memoryOverlap(rows: OverlapRow[], newest?: Date): OverlapStore {
  return {
    newestCreatedAt: async () => newest,
    rowsSince: async (_session, _agent, since) => {
      if (!since) return rows
      return rows.filter((r) => {
        if (!r.created_at) return false
        return new Date(r.created_at).getTime() >= since.getTime()
      })
    },
  }
}

describe('ingest-pages helpers', () => {
  it('parses <bot-slug>-<before>.txt and a generic Transcript of <target> header', () => {
    expect(parsePageFileName('alpha-919.txt')).toEqual({ slug: 'alpha', before: 919 })
    expect(parsePageFileName('my-bot-2.txt')).toEqual({ slug: 'my-bot', before: 2 })
    expect(parsePageFileName('notes.txt')).toBeUndefined()
    const hdr = parsePageHeader('Transcript of alpha, positions 919–920 of 921:')
    expect(hdr).toMatchObject({ target: 'alpha', a: 919, b: 920, total: 921, thisConversation: false })
    expect(hdr?.id).toBeUndefined()
  })

  it('keeps -v4-backfill off the live -v4 session', () => {
    expect(backfillSession('grokbot-alpha')).toBe('grokbot-alpha-v4-backfill')
    expect(liveV4Session('grokbot-alpha')).toBe('grokbot-alpha-v4')
    expect(stripSessionSuffix('grokbot-alpha-v4-backfill')).toBe('grokbot-alpha')
    expect(backfillSourceId('alpha', 919)).toBe('readtranscript:alpha:919')
  })

  it('carries the user <timestamp> forward and skips rows before the first tag', () => {
    const records = [
      assistantTurn('too early'),
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 12:00 AM (UTC-4)</timestamp>\n<user_query>\nhello\n</user_query>',
      ),
      assistantTurn('after'),
      userTurn('<user_query>\nlater same stamp\n</user_query>'),
    ]
    const { messages } = normalizeRecords(records, {
      sessionKey: 'grokbot-alpha-v4-backfill',
      agent: 'grokbot-alpha',
      agentId: ALPHA_ID,
      format: 'page',
    })
    const tags = new Map<number, string>([[1, '2026-10-03T04:00:00.000Z']])
    const stamped = applyBackfillTimestamps(messages, tags)
    expect(stamped.skippedNoTimestamp).toBeGreaterThan(0)
    expect(stamped.kept.every((m) => m.metadata?.ts_approx === true)).toBe(true)
    expect(stamped.kept[0]?.created_at).toBe('2026-10-03T04:00:00.000Z')
    const times = stamped.kept.map((m) => Date.parse(m.created_at ?? ''))
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true)
    expect(stamped.kept.some((m) => m.content === 'too early')).toBe(false)
  })

  it('drops hidden system / agent-wake rows the normalizer classified as system', () => {
    const records = [
      userTurn('[SAND_HIDDEN_PROMPT]\n[first run]\nwelcome'),
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 1:00 AM (UTC+0)</timestamp>\n<user_query>\nreal ask\n</user_query>',
      ),
    ]
    const { messages, stats } = normalizeRecords(records, {
      sessionKey: 'grokbot-alpha-v4-backfill',
      agent: 'grokbot-alpha',
    })
    expect(stats.systemEvents).toBeGreaterThan(0)
    const dropped = dropSystemMessages(messages)
    expect(dropped.droppedSystem).toBeGreaterThan(0)
    expect(dropped.kept.every((m) => m.role !== 'system')).toBe(true)
    expect(dropped.kept.some((m) => m.content.includes('real ask'))).toBe(true)
  })

  it('hashes the same content tuple the normalizer already uses', () => {
    const row = { role: 'assistant', content: 'hi', toolName: undefined, toolArgs: undefined }
    expect(contentHashForRow(row)).toBe(
      contentTupleHash({ role: 'assistant', content: 'hi', toolName: undefined, toolArgs: undefined }),
    )
    const overlap = filterOverlap(
      [
        {
          event_id: 'e1',
          role: 'assistant',
          content: 'hi',
          metadata: { source_id: 'readtranscript:alpha:1', position: 1 },
        },
      ],
      new Set([contentHashForRow(row)]),
    )
    expect(overlap.skippedOverlap).toBe(1)
    expect(overlap.kept).toHaveLength(0)
  })

  it('overlap SELECTs are read-only', () => {
    expect(() => assertReadOnlySql(NEWEST_CREATED_SQL)).not.toThrow()
    expect(() => assertReadOnlySql(ROWS_SINCE_SQL)).not.toThrow()
  })
})

describe('ingest-pages dry-run / commit', () => {
  it('prints per-bot counts and writes nothing without --commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-'))
    pageFile(dir, 'alpha', 2, 1, [
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 12:00 AM (UTC-4)</timestamp>\n<user_query>\nhello alpha\n</user_query>',
      ),
      assistantTurn('hi alpha'),
    ])
    pageFile(dir, 'alpha', 1, 0, [
      userTurn('[SAND_HIDDEN_PROMPT]\n<system_reminder>stay on task</system_reminder>'),
    ])
    const committed: unknown[] = []
    const result = await ingestPages(dir, {
      commit: false,
      deps: {
        discover: () => discoverModels(),
        commit: async (input) => {
          committed.push(input)
          return {
            session_id: input.sessionId,
            ingested: 0,
            skipped: 0,
            ids: [],
            source: 'grokbot',
            agent: input.agent ?? 'grokbot-alpha',
            channel: 'grokbot',
          }
        },
      },
    })
    expect(result.dryRun).toBe(true)
    expect(result.wrote).toBe(false)
    expect(committed).toHaveLength(0)
    expect(result.bots).toHaveLength(1)
    const bot = result.bots[0]
    expect(bot?.slug).toBe('alpha')
    expect(bot?.session).toBe('grokbot-alpha-v4-backfill')
    expect(bot?.agent).toBe('grokbot-alpha')
    expect(bot?.pages).toBe(2)
    expect(bot?.entriesParsed).toBe(3)
    expect(bot?.droppedSystem).toBeGreaterThan(0)
    expect(bot?.new).toBeGreaterThan(0)
    expect(formatIngestPagesCounts(result)).toMatch(/DRY slug=alpha/)
    expect(formatIngestPagesCounts(result)).toMatch(/dropped_system=/)
    expect(listPageSpoolFiles(dir)).toHaveLength(2)
  })

  it('skips overlap against recent -v4 rows and existing -v4-backfill rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-ov-'))
    pageFile(dir, 'alpha', 3, 2, [
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 2:00 AM (UTC-4)</timestamp>\n<user_query>\noverlap me\n</user_query>',
      ),
      assistantTurn('fresh reply'),
    ])
    const newest = new Date('2026-10-03T06:00:00.000Z')
    const store = memoryOverlap(
      [
        {
          role: 'user',
          content: 'overlap me',
          created_at: '2026-10-03T05:50:00.000Z',
        },
        {
          role: 'assistant',
          content: 'old copy',
          created_at: '2026-10-01T00:00:00.000Z',
        },
      ],
      newest,
    )
    const result = await ingestPages(dir, {
      overlapHours: 48,
      deps: { overlap: store },
    })
    const bot = result.bots[0]
    expect(bot?.skippedOverlap).toBeGreaterThan(0)
    expect(bot?.new).toBeGreaterThan(0)
    expect(bot?.session).toBe('grokbot-alpha-v4-backfill')
  })

  it('commit INSERTs only and a second run is a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-w-'))
    pageFile(dir, 'alpha', 4, 3, [
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 3:00 AM (UTC+5:30)</timestamp>\n<user_query>\nwrite me\n</user_query>',
      ),
      assistantTurn('written'),
    ])
    const existing: OverlapRow[] = []
    const store: OverlapStore = {
      newestCreatedAt: async () => undefined,
      rowsSince: async () => existing,
    }
    const writes: Array<{ sessionId: string; n: number }> = []
    const commit = async (input: { sessionId: string; messages: unknown[] }) => {
      writes.push({ sessionId: input.sessionId, n: input.messages.length })
      for (const msg of input.messages as Array<{
        role: string
        content: string
        metadata?: { source_id?: string }
      }>) {
        existing.push({
          role: msg.role,
          content: msg.content,
          metadata: { source_id: msg.metadata?.source_id },
        })
      }
      return {
        session_id: input.sessionId,
        ingested: input.messages.length,
        skipped: 0,
        ids: input.messages.map((_, i) => `id-${String(i)}`),
        source: 'grokbot',
        agent: 'grokbot-alpha',
        channel: 'grokbot',
      }
    }
    const first = await ingestPages(dir, { commit: true, deps: { overlap: store, commit } })
    expect(first.wrote).toBe(true)
    expect(first.dryRun).toBe(false)
    expect(writes[0]?.sessionId).toBe('grokbot-alpha-v4-backfill')
    expect(writes[0]?.n).toBeGreaterThan(0)
    const second = await ingestPages(dir, { commit: true, deps: { overlap: store, commit } })
    expect(second.bots[0]?.new).toBe(0)
    expect(second.bots[0]?.skippedOverlap).toBeGreaterThan(0)
    expect(writes).toHaveLength(1)
  })

  it('skips unknown slugs and malformed pages without writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-bad-'))
    pageFile(dir, 'no-such-bot', 1, 0, [userTurn('orphan')])
    writeFileSync(join(dir, 'alpha-9.txt'), 'not a transcript page\n')
    const result = await ingestPages(dir, { commit: false })
    expect(result.wrote).toBe(false)
    expect(result.bots.every((b) => b.new === 0 || b.slug === 'alpha')).toBe(true)
  })
})
