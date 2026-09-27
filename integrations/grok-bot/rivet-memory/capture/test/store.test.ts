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

/**
 * Redacted sqlite fixture from the published grok-bot-mcp / xopc schema
 * (entry_id, session_id, seq, entry_kind, role, payload_json, created_at).
 * Not a live store.db dump.
 */
function redactedRows() {
  return [
    {
      entry_id: 'e1',
      session_id: 's1',
      seq: 0,
      entry_kind: 'message',
      role: 'user',
      payload: {
        role: 'user',
        message: {
          content: [{ type: 'text', text: '<timestamp>Sunday, Sep 20, 2026, 3:04 PM (UTC-05:00)</timestamp>\nredacted user' }],
        },
      },
      created_at: '2026-09-20T20:04:00.000Z',
    },
    {
      entry_id: 'e2',
      session_id: 's1',
      seq: 1,
      entry_kind: 'message',
      role: 'assistant',
      payload: {
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'redacted assistant' }] },
      },
      created_at: '2026-09-20T20:04:02.000Z',
    },
    {
      entry_id: 'e3',
      session_id: 's1',
      seq: 4,
      entry_kind: 'message',
      role: 'user',
      payload: { text: 'gapped seq is the position' },
      created_at: '2026-09-20T20:05:00.000Z',
    },
  ]
}

describe('store.db read-only reader', () => {
  it('opens SQLITE_OPEN_READONLY and refuses writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-'))
    const path = join(dir, 'store.db')
    writeRedactedStoreFixture(path, redactedRows())
    const db = openStoreReadonly(path)
    expect(() => db.exec('INSERT INTO transcript_entries (entry_id, seq) VALUES (\'x\', 99)')).toThrow()
    db.close()
  })

  it('reads transcript_entries and maps payload_json onto on-disk records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-'))
    const path = join(dir, 'store.db')
    writeRedactedStoreFixture(path, redactedRows())
    const entries = listTranscriptEntries(path)
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 4])
    const rec0 = entryToRecord(entries[0])
    expect(rec0).toMatchObject({ role: 'user' })
    const rec2 = entryToRecord(entries[2])
    expect(rec2).toMatchObject({ role: 'user' })
  })

  it('honors a persisted seq cursor (exclusive)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-'))
    const path = join(dir, 'store.db')
    writeRedactedStoreFixture(path, redactedRows())
    const later = readStoreSince(path, { afterSeq: 0 })
    expect(later.entries.map((e) => e.seq)).toEqual([1, 4])
    expect(later.maxSeq).toBe(4)
  })

  it('feeds the same normalizer with seq as position into -v3-store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-'))
    const path = join(dir, 'store.db')
    writeRedactedStoreFixture(path, redactedRows())
    const read = readStoreSince(path)
    const session = v3StoreSession('grokbot-bob')
    expect(session).toBe(`grokbot-bob${SESSION_SUFFIX_V3_STORE}`)
    const result = normalizeRecords(read.records, {
      sessionKey: session,
      agent: 'rivet-bob',
      format: 'store',
      positions: read.positions,
      useStoredCreatedAt: true,
    })
    expect(result.messages.some((m) => m.metadata?.position === 4)).toBe(true)
    expect(result.messages.some((m) => m.metadata?.position === 0)).toBe(true)
    expect(result.messages.every((m) => m.metadata?.capture_source === 'grokbot-store')).toBe(true)
    const ingest = result.messages.map((m) => toIngestRows([m])[0])
    expect(ingest[0]?.ordinal).toBe(0)
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

  it('convert-store CLI writes ingest jsonl and reports max_seq', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-store-cli-'))
    const path = join(dir, 'store.db')
    const dst = join(dir, 'out.jsonl')
    writeRedactedStoreFixture(path, redactedRows())
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
        '00df02ea-4f5f-4d3e-945a-864e1c9c78dc',
        '--after-seq',
        '-1',
      ])
      expect(code).toBe(0)
      const info = JSON.parse(logs[logs.length - 1] ?? '{}') as { max_seq?: number; session?: string }
      expect(info.max_seq).toBe(4)
      expect(info.session).toBe('grokbot-bob-v3-store')
    } finally {
      console.log = log
    }
  })
})
