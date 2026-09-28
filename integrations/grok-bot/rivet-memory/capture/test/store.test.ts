import { mkdtempSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { normalizeRecords, toIngestRows } from '../src/normalize.js'
import {
  entryToRecord,
  listTranscriptEntries,
  openStoreReadonly,
  readStoreSince,
  v3StoreSession,
  writeRedactedStoreFixture,
} from '../src/store.js'
import { SESSION_SUFFIX_V3_STORE } from '../src/types.js'
import { BETA_ID, ALPHA_ID } from './ids.js'

const T0 = Date.parse('2026-09-20T20:04:00.000Z')

/**
 * Redacted sqlite fixture on the real schema from 13 live stores:
 *   transcript_entries(seq INTEGER PRIMARY KEY, id TEXT, entry TEXT)
 * plus unused kv / blobs / automation_completion_inbox.
 * seq is 1..N. Content is synthetic only.
 */
function redactedRows() {
  return [
    {
      seq: 1,
      id: 'e1',
      entry: {
        kind: 'message',
        role: 'user',
        content: '<timestamp>Sunday, Sep 20, 2026, 3:04 PM (UTC-05:00)</timestamp>\nredacted user',
        timestampMs: T0,
      },
    },
    {
      seq: 2,
      id: 'e2',
      entry: {
        kind: 'send-message',
        message: { content: 'redacted assistant' },
        timestampMs: T0 + 2000,
      },
    },
    {
      seq: 3,
      id: 'e3',
      entry: {
        kind: 'event',
        text: '[event] calendar ping',
        timestampMs: T0 + 3000,
      },
    },
    {
      seq: 4,
      id: 'e4',
      entry: {
        kind: 'message',
        role: 'user',
        content: 'agent to agent body',
        fromAgent: { name: 'Beta', id: BETA_ID },
        toAgent: { name: 'Alpha', id: ALPHA_ID },
        timestampMs: T0 + 4000,
      },
    },
    {
      seq: 5,
      id: 'e5',
      entry: {
        kind: 'spend-initiation',
        amount: { tokens: 12 },
        timestampMs: T0 + 5000,
      },
    },
    {
      seq: 6,
      id: 'e6',
      entry: {
        kind: 'user-attachment',
        name: 'note.txt',
        bytes: 'not-a-real-blob',
        timestampMs: T0 + 6000,
      },
    },
    {
      seq: 7,
      id: 'e7',
      entry: {
        kind: 'feedback',
        rating: 1,
        timestampMs: T0 + 7000,
      },
    },
    {
      seq: 8,
      id: 'e8',
      entry: {
        kind: 'mystery-kind',
        blob: { nested: true },
        timestampMs: T0 + 8000,
      },
    },
  ]
}

describe('store.db read-only reader (real seq/id/entry schema)', () => {
  it('opens SQLITE_OPEN_READONLY and refuses writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-'))
    const path = join(dir, 'store.db')
    writeRedactedStoreFixture(path, redactedRows())
    const db = openStoreReadonly(path)
    expect(() => db.exec('INSERT INTO transcript_entries (seq, id, entry) VALUES (99, \'x\', \'{}\')')).toThrow()
    db.close()
  })

  it('selects seq, id, entry and maps kinds without raw JSON content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-'))
    const path = join(dir, 'store.db')
    writeRedactedStoreFixture(path, redactedRows())
    const entries = listTranscriptEntries(path)
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(entries.map((e) => e.kind)).toEqual([
      'message',
      'send-message',
      'event',
      'message',
      'spend-initiation',
      'user-attachment',
      'feedback',
      'mystery-kind',
    ])
    const recs = entries.map(entryToRecord)
    expect(recs[0]).toMatchObject({ role: 'user' })
    expect(recs[1]).toMatchObject({ role: 'assistant' })
    expect(JSON.stringify(recs[1])).toContain('redacted assistant')
    expect(JSON.stringify(recs[1])).not.toContain('"kind":"send-message"')
    expect(JSON.stringify(recs[4])).toContain('[grokbot.spend-initiation]')
    expect(JSON.stringify(recs[4])).not.toContain('tokens')
    expect(JSON.stringify(recs[5])).toContain('[grokbot.attachment]')
    expect(JSON.stringify(recs[5])).toContain('note.txt')
    expect(JSON.stringify(recs[5])).not.toContain('not-a-real-blob')
    expect(recs[7]).toBeNull()
  })

  it('created_at comes from timestampMs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-'))
    const path = join(dir, 'store.db')
    writeRedactedStoreFixture(path, redactedRows())
    const entries = listTranscriptEntries(path)
    expect(entries[0]?.created_at).toBe('2026-09-20T20:04:00.000Z')
    expect(entries[1]?.created_at).toBe('2026-09-20T20:04:02.000Z')
  })

  it('honors a persisted seq cursor (exclusive) and advances maxSeq past skipped kinds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-'))
    const path = join(dir, 'store.db')
    writeRedactedStoreFixture(path, redactedRows())
    const later = readStoreSince(path, { afterSeq: 1 })
    expect(later.entries.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(later.maxSeq).toBe(8)
    expect(later.skipped).toBe(1)
    expect(later.unknownKinds['mystery-kind']).toBe(1)
    expect(later.positions).not.toContain(8)
  })

  it('feeds the same normalizer with seq as position into -v3-store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-'))
    const path = join(dir, 'store.db')
    writeRedactedStoreFixture(path, redactedRows())
    const read = readStoreSince(path)
    const session = v3StoreSession('grokbot-beta')
    expect(session).toBe(`grokbot-beta${SESSION_SUFFIX_V3_STORE}`)
    const result = normalizeRecords(read.records, {
      sessionKey: session,
      agent: 'grokbot-beta',
      format: 'store',
      positions: read.positions,
      useStoredCreatedAt: true,
    })
    expect(result.messages.some((m) => m.metadata?.position === 1)).toBe(true)
    expect(result.messages.some((m) => m.metadata?.position === 2)).toBe(true)
    expect(result.messages.every((m) => m.metadata?.source === 'grokbot-store')).toBe(true)
    expect(result.messages.some((m) => m.metadata?.kind === 'event')).toBe(true)
    expect(result.messages.some((m) => m.metadata?.kind === 'agent_message')).toBe(true)
    const ingest = result.messages.map((m) => toIngestRows([m])[0])
    expect(ingest.every((r) => r?.metadata?.capture_source === 'grokbot-store')).toBe(true)
    expect(ingest.some((r) => typeof r?.content === 'string' && r.content.includes('{'))).toBe(false)
  })

  it('returns empty when transcript_entries is missing (server-side chats)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-'))
    const path = join(dir, 'empty.db')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)')
    db.close()
    expect(listTranscriptEntries(path)).toEqual([])
    unlinkSync(path)
  })

  it('convert-store CLI with no cursor (default after-seq=-1) writes ingest jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-cli-'))
    const path = join(dir, 'store.db')
    const dst = join(dir, 'out.jsonl')
    writeRedactedStoreFixture(path, redactedRows())
    const logs: string[] = []
    const log = console.log
    const warn = console.warn
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    }
    console.warn = () => {
      /* unknown kind */
    }
    try {
      const code = await main([
        'convert-store',
        path,
        dst,
        '--agent-id',
        BETA_ID,
      ])
      expect(code).toBe(0)
      const info = JSON.parse(logs[logs.length - 1] ?? '{}') as {
        max_seq?: number
        session?: string
        after_seq?: number
        skipped?: number
      }
      expect(info.max_seq).toBe(8)
      expect(info.after_seq).toBe(-1)
      expect(info.skipped).toBe(1)
      expect(info.session).toBe('grokbot-beta-v3-store')
    } finally {
      console.log = log
      console.warn = warn
    }
  })

  it('convert-store accepts space-form --after-seq -1 via coalesceDashArgs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-dash-'))
    const path = join(dir, 'store.db')
    const dst = join(dir, 'out.jsonl')
    writeRedactedStoreFixture(path, redactedRows().slice(0, 2))
    const logs: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    }
    try {
      const code = await main([
        'convert-store',
        path,
        dst,
        '--agent-id',
        BETA_ID,
        '--after-seq',
        '-1',
      ])
      expect(code).toBe(0)
      const info = JSON.parse(logs[logs.length - 1] ?? '{}') as { max_seq?: number }
      expect(info.max_seq).toBe(2)
    } finally {
      console.log = log
    }
  })
})
