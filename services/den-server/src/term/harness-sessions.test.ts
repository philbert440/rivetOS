import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listHarnessSessions,
  harnessSessionExists,
  readHarnessTranscript,
} from './harness-sessions.js'

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.GROK_HOME
  delete process.env.HERMES_HOME
})

function fakeClaudeStore(): string {
  const base = mkdtempSync(join(tmpdir(), 'claude-store-'))
  dirs.push(base)
  const projects = join(base, 'projects')
  // two cwd-slug dirs, a session in each, newest one has a user message
  const a = join(projects, '-home-rivet')
  const b = join(projects, '-rivet-shared')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  const s1 = join(a, '11111111-1111-1111-1111-111111111111.jsonl')
  writeFileSync(
    s1,
    [
      JSON.stringify({ type: 'session', mode: 'interactive', sessionId: 'x' }),
      JSON.stringify({ type: 'user', message: { content: 'fix the flaky test' } }),
    ].join('\n') + '\n',
  )
  const s2 = join(b, '22222222-2222-2222-2222-222222222222.jsonl')
  writeFileSync(
    s2,
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'deploy the thing' }] },
    }) + '\n',
  )
  // a non-jsonl file that must be ignored
  writeFileSync(join(a, 'notes.txt'), 'ignore me')
  // make s2 the most recent
  utimesSync(s1, new Date(1000), new Date(1000))
  utimesSync(s2, new Date(2000), new Date(2000))
  process.env.CLAUDE_CONFIG_DIR = base
  return base
}

describe('listHarnessSessions', () => {
  it('lists Claude sessions across all project dirs, newest first, with titles', async () => {
    fakeClaudeStore()
    const sessions = await listHarnessSessions(['claude', 'shell'])
    expect(sessions.map((s) => s.id)).toEqual([
      '22222222-2222-2222-2222-222222222222', // newest
      '11111111-1111-1111-1111-111111111111',
    ])
    expect(sessions[0]).toMatchObject({ command: 'claude', title: 'deploy the thing' })
    expect(sessions[1].title).toBe('fix the flaky test') // array + string content both parse
    expect(sessions[0].updatedAt).toBeGreaterThan(sessions[1].updatedAt)
  })

  it('lists grok sessions from summary.json, merged + sorted with claude', async () => {
    fakeClaudeStore() // one claude session at mtime 2000
    const grokBase = mkdtempSync(join(tmpdir(), 'grok-store-'))
    dirs.push(grokBase)
    const sess = join(grokBase, 'sessions', '%2Fhome%2Frivet', 'aaaa-1111')
    mkdirSync(sess, { recursive: true })
    writeFileSync(
      join(sess, 'summary.json'),
      JSON.stringify({
        info: { id: 'aaaa-1111' },
        session_summary: 'plan the migration',
        updated_at: '2026-07-07T00:00:00.000Z', // newer than the claude one
      }),
    )
    // a non-dir entry (grok's sqlite index) must be ignored
    writeFileSync(join(grokBase, 'sessions', '%2Fhome%2Frivet', 'session_search.sqlite'), 'x')
    process.env.GROK_HOME = grokBase

    const sessions = await listHarnessSessions(['claude', 'grok'])
    expect(sessions[0]).toMatchObject({ command: 'grok', id: 'aaaa-1111', title: 'plan the migration' })
    expect(sessions.some((s) => s.command === 'claude')).toBe(true)
    // sorted last-updated first across harnesses
    expect(sessions[0].updatedAt).toBeGreaterThan(sessions[sessions.length - 1].updatedAt)
    delete process.env.GROK_HOME
  })

  it('harnessSessionExists: grok checks the session DIR, not summary.json (written later)', async () => {
    const grokBase = mkdtempSync(join(tmpdir(), 'grok-exists-'))
    dirs.push(grokBase)
    // a brand-new grok session: the dir exists but summary.json not written yet
    mkdirSync(join(grokBase, 'sessions', '%2Fhome%2Frivet', 'bbbb-2222'), { recursive: true })
    process.env.GROK_HOME = grokBase
    expect(harnessSessionExists('grok', 'bbbb-2222')).toBe(true) // dir present → resume
    expect(harnessSessionExists('grok', 'nope-0000')).toBe(false)
    expect(harnessSessionExists('hermes', 'bbbb-2222')).toBe(false) // unknown harness
    delete process.env.GROK_HOME
  })

  it('lists hermes sessions from state.db (title = first user message)', async () => {
    let DatabaseSync: (new (p: string) => { exec(sql: string): void; close(): void }) | undefined
    try {
      ;({ DatabaseSync } = await import('node:sqlite'))
    } catch {
      return // node:sqlite unavailable — skip (Node < 22.5)
    }
    const base = mkdtempSync(join(tmpdir(), 'hermes-store-'))
    dirs.push(base)
    const db = new DatabaseSync(join(base, 'state.db'))
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp INTEGER);
      INSERT INTO sessions VALUES ('sess_a', 1000, 2000), ('sess_b', 3000, 5000);
      INSERT INTO messages VALUES ('sess_a','user','fix the parser',1000);
      INSERT INTO messages VALUES ('sess_b','user','ship the release',3000);
    `)
    db.close()
    process.env.HERMES_HOME = base

    const sessions = await listHarnessSessions(['hermes'])
    expect(sessions.map((s) => `${s.id}:${s.title}`)).toEqual([
      'sess_b:ship the release', // ended_at 5000 → newest
      'sess_a:fix the parser',
    ])
    expect(sessions[0].command).toBe('hermes')
    expect(harnessSessionExists('hermes', 'sess_a')).toBe(true)
    expect(harnessSessionExists('hermes', 'nope')).toBe(false)
    delete process.env.HERMES_HOME
  })

  it('empty when the harness has no store / is not a known harness', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'does-not-exist-' + String(process.pid))
    process.env.GROK_HOME = join(tmpdir(), 'no-grok-' + String(process.pid))
    process.env.HERMES_HOME = join(tmpdir(), 'no-hermes-' + String(process.pid))
    expect(await listHarnessSessions(['claude', 'grok', 'hermes'])).toEqual([])
    expect(await listHarnessSessions(['shell'])).toEqual([]) // no reader wired
    delete process.env.GROK_HOME
    delete process.env.HERMES_HOME
  })
})

describe('readHarnessTranscript', () => {
  it('reads Claude user/assistant turns and skips sidechains + wrappers', async () => {
    const base = mkdtempSync(join(tmpdir(), 'claude-tx-'))
    dirs.push(base)
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const dir = join(base, 'projects', '-home-rivet')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { content: '<user_info>noise</user_info>' } }),
        JSON.stringify({ type: 'user', message: { content: 'hello claude' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi there' }, { type: 'thinking', text: 'x' }] },
        }),
        JSON.stringify({
          type: 'user',
          isSidechain: true,
          message: { content: 'sidechain skip me' },
        }),
        JSON.stringify({ type: 'user', message: { content: 'second turn' } }),
      ].join('\n') + '\n',
    )
    process.env.CLAUDE_CONFIG_DIR = base

    const t = await readHarnessTranscript(id)
    expect(t.command).toBe('claude')
    expect(t.turns).toEqual([
      { role: 'user', text: 'hello claude' },
      { role: 'assistant', text: 'hi there' },
      { role: 'user', text: 'second turn' },
    ])
  })

  it('reads Grok chat_history and unwraps <user_query>', async () => {
    const base = mkdtempSync(join(tmpdir(), 'grok-tx-'))
    dirs.push(base)
    const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const sess = join(base, 'sessions', '%2Fhome%2Frivet', id)
    mkdirSync(sess, { recursive: true })
    writeFileSync(
      join(sess, 'chat_history.jsonl'),
      [
        JSON.stringify({ type: 'user', content: '<user_info>env</user_info>' }),
        JSON.stringify({ type: 'user', content: '<user_query>plan the migrate</user_query>' }),
        JSON.stringify({ type: 'assistant', content: 'ok, planning' }),
      ].join('\n') + '\n',
    )
    process.env.GROK_HOME = base

    const t = await readHarnessTranscript(id)
    expect(t.command).toBe('grok')
    expect(t.turns).toEqual([
      { role: 'user', text: 'plan the migrate' },
      { role: 'assistant', text: 'ok, planning' },
    ])
  })

  it('returns empty for unknown session ids', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'none-' + String(process.pid))
    const t = await readHarnessTranscript('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')
    expect(t).toEqual({ id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', command: '', turns: [] })
  })
})
