/**
 * wire tests — SQLite session capture, the post-hoc usage reconcile,
 * and parseOpencodeEvent against `opencode run --format json` (message/part rows).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  listSessionIds,
  newestSessionAfter,
  opencodeDbPath,
  opencodeHome,
  effectiveOpencodeHome,
  parseOpencodeEvent,
  reconcileTurn,
  xdgDataHomeFor,
} from './wire.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-wire-'))
  tmpDirs.push(dir)
  return dir
}

async function openWritable(home: string): Promise<{
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
} | null> {
  let DatabaseSync: new (
    p: string,
  ) => {
    exec(sql: string): void
    prepare(sql: string): { run(...params: unknown[]): void }
    close(): void
  }
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return null
  }
  const db = new DatabaseSync(opencodeDbPath(home))
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `)
  return db
}

describe('home resolution', () => {
  it('honours XDG_DATA_HOME/opencode, else ~/.local/share/opencode', () => {
    expect(opencodeHome({ XDG_DATA_HOME: '/xdg' })).toBe(path.join('/xdg', 'opencode'))
    expect(opencodeHome({})).toBe(path.join(os.homedir(), '.local', 'share', 'opencode'))
    expect(xdgDataHomeFor('/tmp/share/opencode')).toBe('/tmp/share')
    expect(xdgDataHomeFor('/tmp/opencode-home')).toBe('/tmp/opencode-home')
    expect(effectiveOpencodeHome('/tmp/share/opencode')).toBe('/tmp/share/opencode')
    expect(effectiveOpencodeHome('/tmp/oc-data')).toBe(path.join('/tmp/oc-data', 'opencode'))
  })
})

describe('listSessionIds / newestSessionAfter', () => {
  it('is scoped to the working directory via session.directory', async () => {
    const home = tmpHome()
    const db = await openWritable(home)
    if (!db) return
    db.prepare(
      'INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)',
    ).run('ses_d1d1d1d1d1d1d1d1d1d1', '/work/d', 1000, 1000)
    db.prepare(
      'INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)',
    ).run('ses_d2d2d2d2d2d2d2d2d2d2', '/work/d', 2000, 2000)
    db.prepare(
      'INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)',
    ).run('ses_oooooooooooooooooooo', '/work/other', 3000, 3000)
    db.close()

    expect([...listSessionIds(home, '/work/d')].sort()).toEqual([
      'ses_d1d1d1d1d1d1d1d1d1d1',
      'ses_d2d2d2d2d2d2d2d2d2d2',
    ])
    expect(newestSessionAfter(home, '/work/d', 1500)).toBe('ses_d2d2d2d2d2d2d2d2d2d2')
    expect(newestSessionAfter(home, '/work/d', 5000)).toBeUndefined()
  })
})

describe('reconcileTurn', () => {
  it('sums assistant tokens at or after the floor and ignores user rows', async () => {
    const home = tmpHome()
    const db = await openWritable(home)
    if (!db) return
    const sid = 'ses_eeeeeeeeeeeeeeeeeeee'
    db.prepare(
      'INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)',
    ).run(sid, '/work/e', 1000, 2050)
    const insert = db.prepare(
      'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
    )
    insert.run(
      'msg_old',
      sid,
      1000,
      JSON.stringify({
        role: 'assistant',
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 5, write: 0 } },
        time: { created: 1000, completed: 1000 },
      }),
    )
    insert.run(
      'msg_a',
      sid,
      2000,
      JSON.stringify({
        role: 'assistant',
        tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2000, completed: 2000 },
      }),
    )
    insert.run(
      'msg_user',
      sid,
      2000,
      JSON.stringify({
        role: 'user',
        tokens: { input: 9999, output: 9999, cache: { read: 0, write: 0 } },
        time: { created: 2000, completed: 2000 },
      }),
    )
    insert.run(
      'msg_b',
      sid,
      2050,
      JSON.stringify({
        role: 'assistant',
        tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2050, completed: 2050 },
      }),
    )
    db.close()

    const facts = reconcileTurn({ home, sessionId: sid, sinceMs: 1500 })
    expect(facts.usage).toEqual({ inputTokens: 250, outputTokens: 25, totalTokens: 275 })
    expect(facts.usageRecords).toBe(2)
    expect(facts.turnEnded).toMatchObject({ reason: 'completed' })
    expect(facts.files).toBe(4)
  })

  it('tolerates a torn message row', async () => {
    const home = tmpHome()
    const db = await openWritable(home)
    if (!db) return
    const sid = 'ses_ffffffffffffffffffff'
    db.prepare(
      'INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)',
    ).run(sid, '/work/f', 3000, 3000)
    const insert = db.prepare(
      'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
    )
    insert.run(
      'msg_ok',
      sid,
      3000,
      JSON.stringify({
        role: 'assistant',
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 5, write: 0 } },
        time: { created: 3000, completed: 3000 },
      }),
    )
    insert.run('msg_torn', sid, 3001, '{"id":"torn","role":"assistant","tokens":')
    db.close()
    const facts = reconcileTurn({ home, sessionId: sid, sinceMs: 0 })
    expect(facts.malformed).toBe(1)
    expect(facts.usage.totalTokens).toBe(115)
  })

  it('reports zero rather than throwing when there is no transcript', () => {
    const facts = reconcileTurn({ home: '/nonexistent/home', sessionId: 'ses_nope', sinceMs: 0 })
    expect(facts.usage.totalTokens).toBe(0)
    expect(facts.files).toBe(0)
  })
})

describe('parseOpencodeEvent', () => {
  it('maps text parts', () => {
    const ev = parseOpencodeEvent({ type: 'text', text: 'hello' })
    expect(ev).toMatchObject({ kind: 'text', text: 'hello' })
  })

  it('maps running tool to tool-start and completed to tool-end', () => {
    const start = parseOpencodeEvent({
      type: 'tool',
      tool: 'bash',
      state: { status: 'running', input: { command: 'ls' } },
    })
    const end = parseOpencodeEvent({
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', output: 'a', title: 'ls' },
    })
    expect(start).toMatchObject({ kind: 'tool-start', tool: 'bash' })
    expect(end).toMatchObject({ kind: 'tool-end', tool: 'bash' })
  })

  it('maps assistant envelope tokens including cache read', () => {
    const ev = parseOpencodeEvent({
      role: 'assistant',
      tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 10, write: 2 } },
    })
    expect(ev).toMatchObject({
      kind: 'usage',
      usage: { inputTokens: 112, outputTokens: 23 },
    })
  })

  it('reads part.tokens from a real step_finish line', () => {
    const ev = parseOpencodeEvent({
      type: 'step_finish',
      timestamp: 9,
      sessionID: 'ses_aaaaaaaaaaaaaaaaaaaa',
      part: {
        type: 'step_finish',
        tokens: { input: 100, output: 25, reasoning: 0, cache: { read: 10, write: 0 } },
      },
    })
    expect(ev).toMatchObject({
      kind: 'usage',
      sessionId: 'ses_aaaaaaaaaaaaaaaaaaaa',
      usage: { inputTokens: 110, outputTokens: 25 },
    })
  })

  it('maps error events', () => {
    const ev = parseOpencodeEvent({ type: 'error', error: { message: 'boom' } })
    expect(ev).toMatchObject({ kind: 'error', error: 'boom' })
  })

  it('ignores unknown types', () => {
    expect(parseOpencodeEvent({ type: 'step-start' })?.kind).toBe('other')
    expect(parseOpencodeEvent({ type: 'nope' })?.kind).toBe('other')
  })

  it('returns undefined for non-objects', () => {
    expect(parseOpencodeEvent(null)).toBeUndefined()
    expect(parseOpencodeEvent('x')).toBeUndefined()
  })
})
