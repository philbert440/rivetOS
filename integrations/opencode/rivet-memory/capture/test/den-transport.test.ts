import { mkdtempSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CaptureBatch } from '@rivetos/capture-core'

vi.mock('pg', () => {
  class Pool {
    constructor() {
      throw new Error('pg loaded on den path')
    }
  }
  return { default: { Pool }, Pool }
})

let dir: string
let bodies: CaptureBatch[]
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'opencode-den-'))
  bodies = []
  vi.stubEnv('RIVETOS_CAPTURE_TRANSPORT', 'den')
  vi.stubEnv('RIVET_DEN_URL', 'https://127.0.0.1:5174')
  vi.stubEnv('RIVETOS_USER_ID', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})
function sink(offline = false, failedSpool = false, rejected = false) {
  const spoolDir = path.join(dir, 'spool')
  if (failedSpool) writeFileSync(spoolDir, 'not a directory')
  const fetch: typeof globalThis.fetch = async (url, init) => {
    expect(String(url)).toBe('https://127.0.0.1:5174/api/capture')
    bodies.push(JSON.parse(String(init?.body)) as CaptureBatch)
    if (rejected) return new Response('bad request', { status: 400 })
    if (offline) throw new Error('offline')
    return new Response(
      JSON.stringify({ ok: true, conversation_id: 'conv', inserted: 1, skipped: 0 }),
    )
  }
  return { fetch, spoolDir }
}
import { DatabaseSync } from 'node:sqlite'
import {
  ingestMessages,
  ingestSession,
  createWatcherState,
  emptyState,
  loadState,
} from '../src/opencode-memory-capture.js'

it('posts exact sqlite pointers and lengths with uncapped content and finalize', async () => {
  const content = 'x'.repeat(17000)
  await ingestMessages(
    null,
    'sid',
    [
      {
        eventId: 'prt_1',
        role: 'tool',
        content,
        toolArgs: content,
        extra: { session_sqlite_part_id: 'prt_1' },
        createdAt: '2026-09-27T00:00:00Z',
      },
    ],
    { ...sink(), title: 'Title', dbPath: '/opencode.db', finalize: true },
  )
  expect(bodies).toEqual([
    {
      session_key: 'opencode:sid',
      agent: 'rivet-glm',
      channel: 'opencode',
      title: 'Title',
      finalize: true,
      settings: {
        source: 'opencode-sqlite',
        sessionId: 'sid',
        cwd: null,
        triggerEvent: 'ingest',
        session_sqlite_path: '/opencode.db',
      },
      messages: [
        {
          event_id: 'prt_1',
          role: 'tool',
          content,
          tool_args: content.slice(0, 16000),
          created_at: '2026-09-27T00:00:00Z',
          metadata: {
            source: 'opencode-sqlite',
            event_id: 'prt_1',
            session_sqlite_path: '/opencode.db',
            session_sqlite_part_id: 'prt_1',
            full_tool_args_length: 17000,
            truncated: true,
          },
        },
      ],
    },
  ])
})
it.each(['delivered', 'spooled', 'failed', 'rejected'] as const)(
  'cursor acknowledgment: %s',
  async (mode) => {
    const file = path.join(dir, 'opencode.db')
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_updated INTEGER);
    CREATE TABLE message (id TEXT, data TEXT, time_updated INTEGER);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('sid', 'Title', '/tmp', 100)
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(
      'msg',
      JSON.stringify({ role: 'user' }),
      100,
    )
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
      'prt_1',
      'msg',
      'sid',
      100,
      100,
      JSON.stringify({ type: 'text', text: 'hello' }),
    )
    db.close()
    const stateFile = path.join(dir, 'state.json')
    const options = sink(mode !== 'delivered', mode === 'failed', mode === 'rejected')
    const state = createWatcherState(emptyState())
    const ingest = ingestSession(file, 'sid', null, state, {
      ...options,
      stateFile,
      source: 'session.deleted',
    })
    if (mode === 'failed' || mode === 'rejected') {
      await expect(ingest).rejects.toThrow(
        mode === 'rejected' ? 'capture HTTP 400' : 'spool failed',
      )
      expect(existsSync(stateFile)).toBe(false)
      expect(state.capture.sessions).toEqual({})
    } else {
      await ingest
      expect(loadState(stateFile).sessions?.sid).toEqual({
        partTimeUpdated: 100,
        messageTimeUpdated: 100,
      })
      if (mode === 'spooled') expect(readdirSync(options.spoolDir)).toHaveLength(1)
    }
    expect(bodies[0].finalize).toBe(true)
    expect(bodies[0].messages[0].metadata).toMatchObject({
      session_sqlite_path: file,
      session_sqlite_part_id: 'prt_1',
    })
  },
)
