import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentTupleHash } from '@rivetos/capture-core'
import { cmdIngestPages, main, resolveMemoryPostgresEntry } from '../src/cli.js'
import { discoverModels, identityForSlug } from '../src/identity.js'
import type { GrokbotIngestInput } from '../src/ingest-rows.js'
import {
  applyBackfillTimestamps,
  attachBackfillMeta,
  BACKFILL_SOURCE,
  BACKFILL_SOURCE_IDS_SQL,
  backfillSession,
  backfillSourceId,
  compareParsedPages,
  contentHashForRow,
  dropSystemMessages,
  filterOverlap,
  formatIngestPagesCounts,
  ingestPages,
  listPageSpoolFiles,
  liveV4Session,
  loadOverlapIndex,
  NEWEST_CREATED_SQL,
  OVERLAP_TIME_TOLERANCE_MS,
  parsePageFileName,
  ROWS_SINCE_SQL,
  type OverlapIndex,
  type OverlapRow,
  type OverlapStore,
} from '../src/ingest-pages.js'
import { normalizeRecords } from '../src/normalize.js'
import { mergeParsedInputs } from '../src/pages.js'
import { parseInput, parsePageHeader } from '../src/parse.js'
import { assertReadOnlySql } from '../src/pg-readonly.js'
import { CONTENT_LIMIT, stripSessionSuffix } from '../src/types.js'
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

function sessionOverlap(
  bySession: Record<string, { newest?: Date; rows: OverlapRow[] }>,
): OverlapStore {
  return {
    newestCreatedAt: async (sessionKey) => bySession[sessionKey]?.newest,
    rowsSince: async (sessionKey, _agent, since) => {
      const rows = bySession[sessionKey]?.rows ?? []
      if (!since) return rows
      return rows.filter((r) => {
        if (!r.created_at) return false
        return new Date(r.created_at).getTime() >= since.getTime()
      })
    },
  }
}

function memoryOverlap(rows: OverlapRow[], newest?: Date): OverlapStore {
  return sessionOverlap({
    'grokbot-alpha-v4': { newest, rows },
    'grokbot-alpha-v4-backfill': { rows },
  })
}

function hashOf(role: string, content: string): string {
  return contentHashForRow({ role, content })
}

function msg(
  role: CaptureRole,
  content: string,
  sourceId: string,
  extras?: Record<string, unknown>,
) {
  const createdAt = typeof extras?.created_at === 'string' ? extras.created_at : undefined
  const meta = { ...(extras ?? {}) }
  delete meta.created_at
  return {
    event_id: sourceId,
    role,
    content,
    created_at: createdAt,
    metadata: { source_id: sourceId, ...meta },
  }
}

const WHEN = '2026-10-03T04:00:00.000Z'

type CaptureRole = 'user' | 'assistant' | 'system' | 'tool'

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
    expect(stripSessionSuffix('grokbot-alpha-v4-backfill')).toBe('grokbot-alpha-v4-backfill')
    expect(backfillSourceId('alpha', 919)).toBe('readtranscript:alpha:919')
    expect(backfillSourceId('alpha', 919, 0)).toBe('readtranscript:alpha:919:0')
    expect(backfillSourceId('alpha', 0, 1)).toBe('readtranscript:alpha:0:1')
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

  it('hashes plain text like the normalizer tuple and matches reordered tool args', () => {
    const row = { role: 'assistant', content: 'hi', toolName: undefined, toolArgs: undefined }
    expect(contentHashForRow(row)).toBe(
      contentTupleHash({
        role: 'assistant',
        content: 'hi',
        toolName: undefined,
        toolArgs: undefined,
      }),
    )
    const left = { path: '/tmp/a', flag: true }
    const right = { flag: true, path: '/tmp/a' }
    const bare = contentHashForRow({
      role: 'assistant',
      content: '',
      toolName: 'shell',
      toolArgs: left,
    })
    const rewritten = contentHashForRow({
      role: 'assistant',
      content: 'synthesized prose that replaced the empty tool row',
      toolName: 'shell',
      toolArgs: right,
    })
    expect(bare).toBe(rewritten)
    expect(
      contentHashForRow({ role: 'user', content: 'ok', toolName: undefined, toolArgs: undefined }),
    ).not.toBe(
      contentHashForRow({ role: 'user', content: 'no', toolName: undefined, toolArgs: undefined }),
    )
    const overlap = filterOverlap(
      [msg('assistant', 'hi', 'readtranscript:alpha:1:0', { position: 1, created_at: WHEN })],
      {
        sourceIds: new Set(),
        v4Hits: [{ hash: contentHashForRow(row), createdAtMs: Date.parse(WHEN) }],
      },
    )
    expect(overlap.skippedOverlap).toBe(1)
    expect(overlap.kept).toHaveLength(0)
  })

  it('dedupes existing backfill rows by source_id, not content hash', () => {
    const index: OverlapIndex = {
      sourceIds: new Set(['readtranscript:alpha:5:0']),
      v4Hits: [],
    }
    const sameTextNewPos = filterOverlap(
      [msg('assistant', 'ok', 'readtranscript:alpha:6:0', { position: 6 })],
      index,
    )
    expect(sameTextNewPos.kept).toHaveLength(1)
    expect(sameTextNewPos.skippedOverlap).toBe(0)
    const samePos = filterOverlap(
      [msg('assistant', 'different text', 'readtranscript:alpha:5:0', { position: 5 })],
      index,
    )
    expect(samePos.kept).toHaveLength(0)
    expect(samePos.skippedOverlap).toBe(1)
  })

  it('suppresses at most k backfill copies of a repeated short -v4 message', () => {
    const hi = hashOf('assistant', 'hi')
    const ok = hashOf('user', 'ok')
    const ms = Date.parse(WHEN)
    const overlap = filterOverlap(
      [
        msg('assistant', 'hi', 'readtranscript:alpha:10:0', { position: 10, created_at: WHEN }),
        msg('assistant', 'hi', 'readtranscript:alpha:11:0', { position: 11, created_at: WHEN }),
        msg('assistant', 'hi', 'readtranscript:alpha:12:0', { position: 12, created_at: WHEN }),
        msg('user', 'ok', 'readtranscript:alpha:13:0', { position: 13, created_at: WHEN }),
        msg('user', 'ok', 'readtranscript:alpha:14:0', { position: 14, created_at: WHEN }),
      ],
      {
        sourceIds: new Set(),
        v4Hits: [
          { hash: hi, createdAtMs: ms },
          { hash: hi, createdAtMs: ms + 1_000 },
          { hash: ok, createdAtMs: ms },
        ],
      },
    )
    expect(overlap.skippedOverlap).toBe(3)
    expect(overlap.kept.map((m) => m.metadata?.source_id)).toEqual([
      'readtranscript:alpha:12:0',
      'readtranscript:alpha:14:0',
    ])
  })

  it('skips entries without a resolvable position and never invents :0', () => {
    const tagged = attachBackfillMeta(
      [
        { event_id: 'a', role: 'assistant', content: 'zero is real', metadata: { position: 0 } },
        { event_id: 'b', role: 'assistant', content: 'missing' },
        { event_id: 'c', role: 'assistant', content: 'nan', metadata: { position: Number.NaN } },
        { event_id: 'd', role: 'user', content: 'later', metadata: { position: 3 } },
      ],
      'alpha',
    )
    expect(tagged.skippedNoPosition).toBe(2)
    expect(tagged.kept.map((m) => m.metadata?.source_id)).toEqual([
      'readtranscript:alpha:0:0',
      'readtranscript:alpha:3:0',
    ])
    expect(tagged.kept.every((m) => m.metadata?.source === BACKFILL_SOURCE)).toBe(true)
    expect(tagged.kept.every((m) => m.metadata?.capture_source === BACKFILL_SOURCE)).toBe(true)
    expect(tagged.kept.every((m) => m.metadata?.backfill === true)).toBe(true)
    expect(tagged.kept.some((m) => m.content === 'missing' || m.content === 'nan')).toBe(false)
  })

  it('overlap SQL stays read-only, including the distinct source_id lookup', () => {
    expect(() => assertReadOnlySql(NEWEST_CREATED_SQL)).not.toThrow()
    expect(() => assertReadOnlySql(ROWS_SINCE_SQL)).not.toThrow()
    expect(() => assertReadOnlySql(BACKFILL_SOURCE_IDS_SQL)).not.toThrow()
    expect(BACKFILL_SOURCE_IDS_SQL).toMatch(/SELECT DISTINCT/i)
    expect(BACKFILL_SOURCE_IDS_SQL).toContain("metadata->>'source_id'")
    expect(BACKFILL_SOURCE_IDS_SQL).not.toMatch(/\bcontent\b/i)
    expect(() => assertReadOnlySql('INSERT INTO ros_messages (content) VALUES (1)')).toThrow(
      /read-only/,
    )
  })

  it('loads backfill source ids without scanning row bodies, and not from -v4 newest', async () => {
    const calls: string[] = []
    const store: OverlapStore = {
      newestCreatedAt: async () => {
        calls.push('newest')
        return new Date('2020-01-01T00:00:00.000Z')
      },
      rowsSince: async (sessionKey) => {
        calls.push(`rows:${sessionKey}`)
        return []
      },
      sourceIds: async (sessionKey) => {
        calls.push(`ids:${sessionKey}`)
        return ['readtranscript:alpha:4:0']
      },
    }
    const index = await loadOverlapIndex(
      store,
      { id: ALPHA_ID, session: 'grokbot-alpha', agent: 'grokbot-alpha', persona: 'Alpha' },
      { overlapHours: 48, candidateCreatedAt: [WHEN] },
    )
    expect(index.sourceIds.has('readtranscript:alpha:4:0')).toBe(true)
    expect(calls).toContain('ids:grokbot-alpha-v4-backfill')
    expect(calls).toContain('rows:grokbot-alpha-v4')
    expect(calls.some((c) => c.startsWith('rows:grokbot-alpha-v4-backfill'))).toBe(false)
    expect(calls).not.toContain('newest')
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
    expect(formatIngestPagesCounts(result)).toMatch(/skipped_no_position=/)
    expect(bot?.skippedNoPosition).toBe(0)
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

  it('keeps extra copies of a repeated short message after -v4 multiplicity is used up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-hi-'))
    pageFile(dir, 'alpha', 6, 4, [
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 4:00 AM (UTC+0)</timestamp>\n<user_query>\nok\n</user_query>',
      ),
      assistantTurn('hi'),
      assistantTurn('hi'),
      assistantTurn('hi'),
    ])
    const newest = new Date('2026-10-03T05:00:00.000Z')
    const store = sessionOverlap({
      'grokbot-alpha-v4': {
        newest,
        rows: [
          { role: 'assistant', content: 'hi', created_at: '2026-10-03T04:50:00.000Z' },
          { role: 'assistant', content: 'hi', created_at: '2026-10-03T04:51:00.000Z' },
        ],
      },
      'grokbot-alpha-v4-backfill': {
        rows: [
          {
            role: 'user',
            content: 'already stored',
            metadata: { source_id: 'readtranscript:alpha:1' },
          },
        ],
      },
    })
    const index = await loadOverlapIndex(
      store,
      { id: ALPHA_ID, session: 'grokbot-alpha', agent: 'grokbot-alpha', persona: 'Alpha' },
      { overlapHours: 48, candidateCreatedAt: ['2026-10-03T04:00:00.000Z'] },
    )
    expect(index.sourceIds.has('readtranscript:alpha:1')).toBe(true)
    expect(index.v4Hits.filter((hit) => hit.hash === hashOf('assistant', 'hi'))).toHaveLength(2)
    const result = await ingestPages(dir, {
      overlapHours: 48,
      deps: { overlap: store },
    })
    const bot = result.bots[0]
    expect(bot?.skippedOverlap).toBe(2)
    expect(bot?.new).toBe(2)
    expect(bot?.skippedNoPosition).toBe(0)
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
    const commit = async (input: {
      sessionId: string
      source?: string
      messages: Array<{
        role: string
        content: string
        metadata?: { source_id?: string; source?: string; backfill?: boolean; capture_source?: string }
      }>
    }) => {
      writes.push({ sessionId: input.sessionId, n: input.messages.length })
      expect(input.source).toBe(BACKFILL_SOURCE)
      for (const row of input.messages) {
        expect(row.metadata?.source_id).toMatch(/^readtranscript:alpha:\d+:\d+$/)
        expect(row.metadata?.source).toBe(BACKFILL_SOURCE)
        expect(row.metadata?.capture_source).toBe(BACKFILL_SOURCE)
        expect(row.metadata?.backfill).toBe(true)
        existing.push({
          role: row.role,
          content: row.content,
          metadata: { source_id: row.metadata?.source_id },
        })
      }
      return {
        session_id: input.sessionId,
        ingested: input.messages.length,
        skipped: 0,
        ids: input.messages.map((_, i) => `id-${String(i)}`),
        source: BACKFILL_SOURCE,
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

  it('counts unknown slugs and malformed pages instead of reporting success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-bad-'))
    pageFile(dir, 'no-such-bot', 1, 0, [userTurn('orphan')])
    writeFileSync(join(dir, 'alpha-9.txt'), 'not a transcript page\n')
    const result = await ingestPages(dir, { commit: false })
    expect(result.wrote).toBe(false)
    const unknown = result.bots.find((b) => b.slug === 'no-such-bot')
    const alpha = result.bots.find((b) => b.slug === 'alpha')
    expect(unknown?.unknownSlugs).toBe(1)
    expect(unknown?.new).toBe(0)
    expect(alpha?.pagesFailed).toBe(1)
    expect(alpha?.entriesParsed).toBe(0)
    expect(alpha?.new).toBe(0)
    const printed = formatIngestPagesCounts(result)
    expect(printed).toMatch(/unknown_slugs=1/)
    expect(printed).toMatch(/pages_failed=1/)
  })
})

function commitResult(input: GrokbotIngestInput) {
  return {
    session_id: input.sessionId,
    ingested: input.messages.length,
    skipped: 0,
    ids: input.messages.map((_, i) => `id-${String(i)}`),
    source: input.source ?? BACKFILL_SOURCE,
    agent: input.agent ?? 'grokbot-alpha',
    channel: 'grokbot',
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function withoutPgUrl<T>(fn: () => Promise<T>): Promise<T> {
  const prev = {
    url: process.env.RIVETOS_PG_URL,
    file: process.env.RIVETOS_ENV_FILE,
    root: process.env.RIVETOS_ROOT,
    pages: process.env.GROKBOT_PAGES_DIR,
  }
  const scratch = mkdtempSync(join(tmpdir(), 'gb-pg-env-'))
  delete process.env.RIVETOS_PG_URL
  delete process.env.GROKBOT_PAGES_DIR
  process.env.RIVETOS_ENV_FILE = join(scratch, 'missing.env')
  try {
    return await fn()
  } finally {
    restoreEnv('RIVETOS_PG_URL', prev.url)
    restoreEnv('RIVETOS_ENV_FILE', prev.file)
    restoreEnv('RIVETOS_ROOT', prev.root)
    restoreEnv('GROKBOT_PAGES_DIR', prev.pages)
  }
}

async function captureMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...a: unknown[]) => {
    out.push(a.map(String).join(' '))
  }
  console.error = (...a: unknown[]) => {
    err.push(a.map(String).join(' '))
  }
  try {
    const code = await main(argv)
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally {
    console.log = log
    console.error = error
  }
}

const STAMP_4AM =
  '<timestamp>Saturday, Oct 3, 2026, 4:00 AM (UTC+0)</timestamp>\n<user_query>\nok\n</user_query>'

describe('ingest-pages review regressions', () => {
  it('orders pages by numeric before, then header position, not the filename', () => {
    expect(
      compareParsedPages(
        { before: 5, path: '/p/b.txt', headerA: 40 },
        { before: 5, path: '/p/a.txt', headerA: 3 },
      ),
    ).toBeGreaterThan(0)
    expect(
      compareParsedPages(
        { before: 1000, path: '/p/alpha-1000.txt', headerA: 1 },
        { before: 999, path: '/p/alpha-999.txt', headerA: 50 },
      ),
    ).toBeGreaterThan(0)

    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-order-'))
    pageFile(dir, 'alpha', 1000, 10, [
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 4:00 AM (UTC+0)</timestamp>\n<user_query>\nfrom-1000\n</user_query>',
      ),
    ])
    pageFile(dir, 'alpha', 999, 10, [
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 1:00 AM (UTC+0)</timestamp>\n<user_query>\nfrom-999\n</user_query>',
      ),
    ])
    const listed = listPageSpoolFiles(dir)
    expect(listed.map((file) => file.before)).toEqual([999, 1000])
    const parsed = listed.map((file) => ({
      ...parseInput(readFileSync(file.path, 'utf8'), 'page'),
      sourcePath: file.path,
    }))
    const merged = mergeParsedInputs(parsed)
    expect(JSON.stringify(merged.records)).toContain('from-999')
    expect(JSON.stringify(merged.records)).not.toContain('from-1000')
    expect(merged.conflicts).toEqual([10])
  })

  it('does not let a stale -v4 newest suppress a missed short message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-stale-'))
    pageFile(dir, 'alpha', 8, 20, [
      userTurn(STAMP_4AM),
      userTurn('<user_query>\nok \n</user_query>'),
      userTurn('ok'),
    ])
    const candidateMs = Date.parse('2026-10-03T04:00:00.000Z')
    const oldMs = Date.parse('2026-10-02T04:00:00.000Z')
    const dupMs = Date.parse('2026-10-03T04:10:00.000Z')
    expect(candidateMs - oldMs).toBeGreaterThan(OVERLAP_TIME_TOLERANCE_MS)
    expect(Math.abs(dupMs - candidateMs)).toBeLessThanOrEqual(OVERLAP_TIME_TOLERANCE_MS)
    const v4Rows: OverlapRow[] = [
      { role: 'user', content: 'ok', created_at: '2020-01-01T00:00:00.000Z' },
      { role: 'user', content: 'ok', created_at: '2026-10-02T04:00:00.000Z' },
      { role: 'user', content: 'ok', created_at: '2026-10-03T04:10:00.000Z' },
    ]
    let sinceSeen: Date | undefined
    let newestCalled = false
    const store: OverlapStore = {
      newestCreatedAt: async () => {
        newestCalled = true
        return new Date('2020-01-01T00:00:00.000Z')
      },
      rowsSince: async (sessionKey, _agent, since) => {
        if (sessionKey !== 'grokbot-alpha-v4') return []
        sinceSeen = since
        if (!since) return v4Rows
        return v4Rows.filter((row) => new Date(String(row.created_at)).getTime() >= since.getTime())
      },
      sourceIds: async () => [],
    }
    const result = await ingestPages(dir, { overlapHours: 48, deps: { overlap: store } })
    const bot = result.bots[0]
    expect(newestCalled).toBe(false)
    expect(sinceSeen?.toISOString()).toBe(new Date(candidateMs - 48 * 3_600_000).toISOString())
    expect(bot?.skippedOverlap).toBe(1)
    expect(bot?.new).toBe(2)
  })

  it('overlap-hours 0 does not read or suppress live -v4 rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-zero-'))
    pageFile(dir, 'alpha', 3, 1, [userTurn(STAMP_4AM)])
    let v4Reads = 0
    const store: OverlapStore = {
      newestCreatedAt: async () => new Date('2026-10-03T04:00:00.000Z'),
      rowsSince: async (sessionKey) => {
        if (sessionKey === 'grokbot-alpha-v4') v4Reads += 1
        return [{ role: 'user', content: 'ok', created_at: '2026-10-03T04:00:00.000Z' }]
      },
      sourceIds: async () => [],
    }
    const result = await ingestPages(dir, { overlapHours: 0, deps: { overlap: store } })
    expect(v4Reads).toBe(0)
    expect(result.bots[0]?.skippedOverlap).toBe(0)
    expect(result.bots[0]?.new).toBe(1)
  })

  it('carries a hidden turn tag onto later kept rows, not the run wall clock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-hidden-'))
    pageFile(dir, 'alpha', 1, 0, [
      userTurn(
        '[SAND_HIDDEN_PROMPT]\n<timestamp>Saturday, Oct 3, 2026, 1:00 AM (UTC+0)</timestamp>\n[first run]\nwelcome',
      ),
      assistantTurn('kept after hidden'),
      userTurn('<user_query>\nstill kept\n</user_query>'),
    ])
    const written: Array<{ content: string; createdAt?: string }> = []
    await ingestPages(dir, {
      commit: true,
      deps: {
        commit: async (input) => {
          for (const row of input.messages) {
            const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt
            written.push({ content: row.content, createdAt })
          }
          return commitResult(input)
        },
      },
    })
    expect(written.some((row) => row.content.includes('welcome'))).toBe(false)
    expect(written.find((row) => row.content === 'kept after hidden')?.createdAt).toBe(
      '2026-10-03T01:00:00.000Z',
    )
    expect(written.find((row) => row.content.includes('still kept'))?.createdAt).toBe(
      '2026-10-03T01:00:00.001Z',
    )
  })

  it('completes a partially inserted position and honors legacy source ids', async () => {
    const legacyOnly = filterOverlap(
      [msg('assistant', 'only', 'readtranscript:alpha:5:0', { position: 5 })],
      { sourceIds: new Set(['readtranscript:alpha:5']), v4Hits: [] },
    )
    expect(legacyOnly.kept).toHaveLength(0)
    const legacyMany = filterOverlap(
      [
        msg('assistant', 'text', 'readtranscript:alpha:5:0', { position: 5 }),
        msg('assistant', 'tool', 'readtranscript:alpha:5:1', { position: 5 }),
      ],
      { sourceIds: new Set(['readtranscript:alpha:5']), v4Hits: [] },
    )
    expect(legacyMany.kept).toHaveLength(0)
    const partial = filterOverlap(
      [
        msg('assistant', 'text', 'readtranscript:alpha:5:0', { position: 5 }),
        msg('assistant', 'tool', 'readtranscript:alpha:5:1', { position: 5 }),
      ],
      { sourceIds: new Set(['readtranscript:alpha:5:0']), v4Hits: [] },
    )
    expect(partial.kept.map((m) => m.metadata?.source_id)).toEqual(['readtranscript:alpha:5:1'])

    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-sub-'))
    pageFile(dir, 'alpha', 4, 3, [
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 3:00 AM (UTC+0)</timestamp>\n<user_query>\nwrite me\n</user_query>',
      ),
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'using a tool' },
            { type: 'tool_use', name: 'shell', input: { cmd: 'ls', flag: true } },
          ],
        },
      },
    ])
    const stored = new Set<string>()
    const commits: string[][] = []
    const store: OverlapStore = {
      newestCreatedAt: async () => undefined,
      rowsSince: async () => [],
      sourceIds: async () => [...stored],
    }
    const commit = async (input: GrokbotIngestInput) => {
      const ids = input.messages.map((row) => String(row.metadata?.source_id ?? ''))
      commits.push(ids)
      if (commits.length === 1) {
        for (const id of ids) if (id.endsWith(':0')) stored.add(id)
      }
      return commitResult(input)
    }
    await ingestPages(dir, { commit: true, deps: { overlap: store, commit } })
    await ingestPages(dir, { commit: true, deps: { overlap: store, commit } })
    expect(commits[0]?.some((id) => id.endsWith(':1'))).toBe(true)
    expect(commits[1]?.length).toBeGreaterThan(0)
    expect(commits[1]?.every((id) => id.endsWith(':1'))).toBe(true)
    expect(commits[1]?.some((id) => stored.has(id))).toBe(false)
  })

  it('points a truncated row at the numerically earlier page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-ptr-'))
    const huge = 'h'.repeat(CONTENT_LIMIT + 32)
    const records = [
      userTurn(
        `<timestamp>Saturday, Oct 3, 2026, 4:00 AM (UTC+0)</timestamp>\n<user_query>\n${huge}\n</user_query>`,
      ),
    ]
    pageFile(dir, 'alpha', 1000, 10, records)
    pageFile(dir, 'alpha', 999, 10, records)
    let path = ''
    let line: unknown
    await ingestPages(dir, {
      commit: true,
      deps: {
        commit: async (input) => {
          const row = input.messages.find((message) => message.metadata?.truncated === true)
          path = String(row?.metadata?.session_jsonl_path ?? '')
          line = row?.metadata?.session_jsonl_line
          return commitResult(input)
        },
      },
    })
    expect(path).toBe(resolve(join(dir, 'alpha-999.txt')))
    expect(typeof line).toBe('number')
  })

  it('reuses the catalog already passed in and does not rescan agentsDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-cat-'))
    pageFile(dir, 'alpha', 1, 0, [userTurn(STAMP_4AM)])
    const catalog = discoverModels()
    let calls = 0
    const direct = identityForSlug('alpha', { agentsDir: '/no/such/agents/dir', catalog })
    expect(direct?.agent).toBe('grokbot-alpha')
    const result = await ingestPages(dir, {
      agentsDir: '/no/such/agents/dir',
      deps: {
        discover: () => {
          calls += 1
          return catalog
        },
      },
    })
    expect(calls).toBe(1)
    expect(result.bots[0]?.slug).toBe('alpha')
    expect(result.bots[0]?.unknownSlugs).toBe(0)
    expect(formatIngestPagesCounts(result)).not.toContain('overlap=unavailable')
  })

  it('blocks the conflicting bot and still commits the others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-conflict-'))
    pageFile(dir, 'alpha', 1, 10, [
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 4:00 AM (UTC+0)</timestamp>\n<user_query>\nfrom-a1\n</user_query>',
      ),
    ])
    pageFile(dir, 'alpha', 2, 10, [
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 4:00 AM (UTC+0)</timestamp>\n<user_query>\nfrom-a2\n</user_query>',
      ),
    ])
    pageFile(dir, 'beta', 3, 0, [
      userTurn(
        '<timestamp>Saturday, Oct 3, 2026, 5:00 AM (UTC+0)</timestamp>\n<user_query>\nbeta ok\n</user_query>',
      ),
    ])
    const sessions: string[] = []
    const errs: string[] = []
    const err = console.error
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(' '))
    }
    try {
      const code = await cmdIngestPages(['--input', dir, '--commit'], {
        loadDeps: async () => ({
          overlap: {
            newestCreatedAt: async () => undefined,
            rowsSince: async () => [],
          },
          commit: async (input) => {
            sessions.push(input.sessionId)
            return commitResult(input)
          },
        }),
      })
      expect(code).toBe(3)
    } finally {
      console.error = err
    }
    expect(sessions).toEqual(['grokbot-beta-v4-backfill'])
    const text = errs.join('\n')
    expect(text).toContain('Nothing written for this bot')
    expect(text).toContain('Other bots in this run are still ingested')
    expect(text).not.toMatch(/Nothing written\. Investigate/)
  })

  it('exits 2 for a bad --input, an unknown slug, and a malformed page', async () => {
    await withoutPgUrl(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gb-pages-cli-'))
      const missing = await captureMain(['ingest-pages', '--input', join(dir, 'nope')])
      expect(missing.code).toBe(2)
      expect(missing.err).toMatch(/cannot read --input/)
      const file = join(dir, 'not-a-dir.txt')
      writeFileSync(file, 'x')
      const notDir = await captureMain(['ingest-pages', '--input', file])
      expect(notDir.code).toBe(2)
      expect(notDir.err).toMatch(/not a directory/)
      const bad = mkdtempSync(join(tmpdir(), 'gb-pages-malformed-'))
      writeFileSync(join(bad, 'alpha-9.txt'), 'not a transcript page\n')
      pageFile(bad, 'no-such-bot', 1, 0, [userTurn('orphan')])
      const failed = await captureMain(['ingest-pages', '--input', bad])
      expect(failed.code).toBe(2)
      expect(failed.out).toMatch(/pages_failed=1/)
      expect(failed.out).toMatch(/unknown_slugs=1/)
    })
  })

  it('says overlap is unavailable only when the CLI has no database URL', async () => {
    await withoutPgUrl(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gb-pages-nounurl-'))
      pageFile(dir, 'alpha', 1, 0, [userTurn(STAMP_4AM)])
      const got = await captureMain(['ingest-pages', '--input', dir, '--commit', '--dry-run'])
      expect(got.code).toBe(0)
      expect(got.out).toContain('overlap=unavailable (no RIVETOS_PG_URL)')
      expect(got.err).toMatch(/--dry-run overrides --commit/)
    })
  })

  it('surfaces a commit failure and still closes the overlap pool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pages-close-'))
    let closed = false
    let sawCommit = true
    const errs: string[] = []
    const err = console.error
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(' '))
    }
    try {
      const code = await cmdIngestPages(['--input', dir, '--commit'], {
        loadDeps: async (commit) => {
          sawCommit = commit
          return {
            commitError: 'ingest-pages --commit failed: memory-postgres is not built (plugins/memory/postgres)',
            overlap: {
              newestCreatedAt: async () => undefined,
              rowsSince: async () => [],
              close: async () => {
                closed = true
              },
            },
          }
        },
      })
      expect(code).toBe(2)
    } finally {
      console.error = err
    }
    expect(sawCommit).toBe(true)
    expect(closed).toBe(true)
    const text = errs.join('\n')
    expect(text).toMatch(/memory-postgres is not built/)
    expect(text).not.toMatch(/needs RIVETOS_PG_URL/)
  })

  it('resolves the dev fallback to plugins/memory/postgres and names that path', () => {
    const packageDir = '/tmp/capture-pkg'
    const local = resolve(packageDir, '../../../..', 'plugins/memory/postgres/dist/index.js')
    expect(
      resolveMemoryPostgresEntry((path) => path === local, {
        root: '/opt/missing',
        packageDir,
      }),
    ).toBe(local)
    expect(() => resolveMemoryPostgresEntry(() => false, { root: '/opt/missing', packageDir })).toThrow(
      /memory-postgres is not built/,
    )
    expect(() => resolveMemoryPostgresEntry(() => false)).toThrow(/plugins\/memory\/postgres/)
  })
})
