import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cmdIngestPages, main } from '../src/cli.js'
import type { GrokbotIngestInput } from '../src/ingest-rows.js'
import { BACKFILL_SOURCE, ingestPages, loadOverlapIndex } from '../src/ingest-pages.js'
import { ALPHA_ID } from './ids.js'

function userTurn(text: string) {
  return { role: 'user', message: { content: [{ type: 'text', text }] } }
}

function assistantTurn(text: string) {
  return { role: 'assistant', message: { content: [{ type: 'text', text }] } }
}

function livePage(
  dir: string,
  slug: string,
  before: number,
  a: number,
  records: unknown[],
  total = 40,
) {
  const b = a + records.length - 1
  const header = `Transcript of ${slug}, positions ${String(a)}–${String(b)} of ${String(total)}:`
  writeFileSync(join(dir, `${slug}-${String(before)}.txt`), [header, ...records.map((r) => JSON.stringify(r)), ''].join('\n'))
}

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

const STAMP =
  '<timestamp>Saturday, Oct 3, 2026, 4:00 AM (UTC+0)</timestamp>\n<user_query>\nhello live\n</user_query>'

describe('ingest-pages --live', () => {
  it('tags grokbot-<slug>-v4-live and refuses --revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-live-tag-'))
    livePage(dir, 'alpha', 13, 12, [userTurn(STAMP), assistantTurn('hi')])
    const first = await ingestPages(dir, { live: true })
    expect(first.bots[0]?.session).toBe('grokbot-alpha-v4-live')
    const code = await cmdIngestPages(['--input', dir, '--live', '--revision', 'r2'])
    expect(code).toBe(2)
    const helpOut: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => {
      helpOut.push(a.map(String).join(' '))
    }
    try {
      expect(await main(['help'])).toBe(0)
    } finally {
      console.log = log
    }
    expect(helpOut.join('\n')).toContain('--live')
    expect(helpOut.join('\n')).toContain('grokbot-<slug>-v4-live')
    expect(helpOut.join('\n')).toContain('cannot be combined with')
  })

  it('does not insert duplicate rows when the same live page is ingested twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-live-dedupe-'))
    livePage(dir, 'alpha', 13, 12, [userTurn(STAMP), assistantTurn('hi')])
    const stored = new Map<string, Array<{ sourceId: string; contentHash?: string }>>()
    const writes: Array<{ sessionId: string; n: number; ids: string[] }> = []
    const store = {
      newestCreatedAt: async () => undefined,
      rowsSince: async () => [],
      sourceIds: async (sessionKey: string) => stored.get(sessionKey) ?? [],
    }
    const commit = async (input: GrokbotIngestInput) => {
      const ids = input.messages.map((row) => String(row.metadata?.source_id ?? ''))
      writes.push({ sessionId: input.sessionId, n: input.messages.length, ids })
      const list = stored.get(input.sessionId) ?? []
      for (const row of input.messages) {
        const sourceId = String(row.metadata?.source_id ?? '')
        const contentHash =
          typeof row.metadata?.content_hash === 'string' ? row.metadata.content_hash : undefined
        list.push(contentHash ? { sourceId, contentHash } : { sourceId })
      }
      stored.set(input.sessionId, list)
      return commitResult(input)
    }
    const first = await ingestPages(dir, { commit: true, live: true, deps: { overlap: store, commit } })
    expect(first.wrote).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.sessionId).toBe('grokbot-alpha-v4-live')
    expect(writes[0]?.n).toBeGreaterThan(0)
    livePage(dir, 'alpha', 12, 12, [userTurn(STAMP), assistantTurn('hi')])
    const second = await ingestPages(dir, { commit: true, live: true, deps: { overlap: store, commit } })
    expect(second.bots[0]?.session).toBe('grokbot-alpha-v4-live')
    expect(second.bots[0]?.new).toBe(0)
    expect(second.bots[0]?.skippedOverlap).toBeGreaterThan(0)
    expect(writes).toHaveLength(1)
  })

  it('loads live-session source ids from -v4-live, not -v4-backfill', async () => {
    const sessions: string[] = []
    const index = await loadOverlapIndex(
      {
        newestCreatedAt: async () => undefined,
        rowsSince: async () => [],
        sourceIds: async (sessionKey) => {
          sessions.push(sessionKey)
          return [{ sourceId: 'readtranscript:alpha:12:0', contentHash: 'abc' }]
        },
      },
      { id: ALPHA_ID, session: 'grokbot-alpha', agent: 'grokbot-alpha', persona: 'Alpha' },
      { live: true, overlapHours: 0 },
    )
    expect(sessions).toEqual(['grokbot-alpha-v4-live'])
    expect(index.sourceIds.get('readtranscript:alpha:12:0')).toBe('abc')
  })
})
