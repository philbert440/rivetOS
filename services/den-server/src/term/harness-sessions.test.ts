import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as codexRoom from './codex-room.js'
import { isBareSlashCommand } from '../harness/adapters/claude.js'
import { extractTurnText } from '../harness/adapters/parse-helpers.js'
import {
  describeClaudeSession,
  describeGrokSession,
  describeKimiSession,
  describeCodexSession,
  describeDshSession,
  describePiSession,
  claudeTurnsFromLines,
  grokTurnsFromLines,
  listHarnessSessions,
  harnessSessionExists,
  readGrokTranscript,
  readHarnessTranscript,
  readHermesTranscript,
  readKimiTranscript,
  readCodexTranscript,
  readPiTranscript,
  resolveHarnessStore,
  setTranscriptMaxBytesForTest,
  kimiTurnsFromLines,
} from './harness-sessions.js'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  setTranscriptMaxBytesForTest()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.GROK_HOME
  delete process.env.HERMES_HOME
  delete process.env.KIMI_CODE_HOME
  delete process.env.DSH_HOME
  delete process.env.CODEX_HOME
  delete process.env.PI_HOME
})

/**
 * A kimi store with BOTH state shapes in it, because a real box has both: kimi
 * ≥0.34 writes `"version": 2` state with epoch-ms numbers, an `id` and a `cwd`
 * and NO title, while an older install writes ISO strings, `workDir`, `title`
 * and `lastPrompt` — and the two coexist in one `~/.kimi-code/sessions` when a
 * node has both installed (observed on ct116).
 */
function fakeKimiStore(): { home: string; v1: string; v2: string; untitled: string } {
  const home = mkdtempSync(join(tmpdir(), 'kimi-store-'))
  dirs.push(home)
  const v2 = 'session_11111111-1111-4111-8111-111111111111'
  const v1 = 'session_22222222-2222-4222-8222-222222222222'
  const untitled = 'session_33333333-3333-4333-8333-333333333333'
  const write = (wd: string, id: string, state: unknown, wire?: unknown[]): void => {
    const dir = join(home, 'sessions', wd, id)
    mkdirSync(join(dir, 'agents', 'main'), { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
    if (wire) {
      writeFileSync(
        join(dir, 'agents', 'main', 'wire.jsonl'),
        wire.map((l) => JSON.stringify(l)).join('\n') + '\n',
      )
    }
  }
  write('wd_rivet_abc123', v2, {
    id: v2,
    version: 2,
    cwd: '/home/rivet',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_200_000,
    archived: false,
  })
  write('wd_rivetos_def456', v1, {
    createdAt: '2023-11-14T22:13:20.000Z', // 1_700_000_000_000
    updatedAt: '2023-11-14T22:14:20.000Z', // 1_700_000_060_000
    title: 'ship the release',
    isCustomTitle: false,
    workDir: '/rivet-shared',
    lastPrompt: 'ship the release',
  })
  // v2 state carries no title at all — the only title source that works across
  // both shapes is the transcript's opening human turn.
  write(
    'wd_rivet_abc123',
    untitled,
    { id: untitled, version: 2, cwd: '/home/rivet', createdAt: 1, updatedAt: 2 },
    [
      { type: 'metadata', protocol_version: '1.5' },
      // An injected banner is user-ROLE but not a human turn — it must never
      // become a drawer label.
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Auto permission mode is active.' }],
          origin: { kind: 'injection', variant: 'permission_mode' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'review the harness driver' }],
          origin: { kind: 'user' },
        },
      },
    ],
  )
  process.env.KIMI_CODE_HOME = home
  return { home, v1, v2, untitled }
}

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

  it('agrees with describeClaudeSession on createdAt/updatedAt for the same session', async () => {
    // The harness control plane reads sessions through both paths; a session
    // whose createdAt differed between the list and the single lookup would
    // show two different creation times in the same UI.
    fakeClaudeStore()
    const id = '22222222-2222-2222-2222-222222222222'
    const listed = (await listHarnessSessions(['claude'])).find((x) => x.id === id)
    const described = await describeClaudeSession(id)
    expect(listed?.createdAt).toBeTypeOf('number')
    expect(described?.createdAt).toBe(listed?.createdAt)
    expect(described?.updatedAt).toBe(listed?.updatedAt)
    expect(described?.title).toBe(listed?.title)
  })

  it('describeClaudeSession returns undefined for an unknown or unsafe id', async () => {
    fakeClaudeStore()
    expect(await describeClaudeSession('33333333-3333-3333-3333-333333333333')).toBeUndefined()
    expect(await describeClaudeSession('../escape')).toBeUndefined()
    expect(await describeClaudeSession('')).toBeUndefined()
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
    expect(sessions[0]).toMatchObject({
      command: 'grok',
      id: 'aaaa-1111',
      title: 'plan the migration',
    })
    expect(sessions.some((s) => s.command === 'claude')).toBe(true)
    // sorted last-updated first across harnesses
    expect(sessions[0].updatedAt).toBeGreaterThan(sessions[sessions.length - 1].updatedAt)
    delete process.env.GROK_HOME
  })

  it('carries grok created_at onto the row so list and describe cannot disagree', async () => {
    const grokBase = mkdtempSync(join(tmpdir(), 'grok-created-'))
    dirs.push(grokBase)
    const id = 'cccc-3333'
    const sess = join(grokBase, 'sessions', '%2Fhome%2Frivet', id)
    mkdirSync(sess, { recursive: true })
    writeFileSync(
      join(sess, 'summary.json'),
      JSON.stringify({
        info: { id },
        session_summary: 'quantize the thing',
        created_at: '2026-07-07T00:00:00.000Z',
        updated_at: '2026-07-07T01:00:00.000Z',
      }),
    )
    process.env.GROK_HOME = grokBase

    const [listed] = await listHarnessSessions(['grok'])
    const described = await describeGrokSession(id)
    expect(listed.createdAt).toBe(Date.parse('2026-07-07T00:00:00.000Z'))
    expect(described).toEqual(listed)
  })

  it('describeGrokSession: no summary yet → undefined (existence is a separate question)', async () => {
    const grokBase = mkdtempSync(join(tmpdir(), 'grok-describe-'))
    dirs.push(grokBase)
    // The window right after a fresh spawn: dir written, summary not yet.
    mkdirSync(join(grokBase, 'sessions', '%2Fhome%2Frivet', 'dddd-4444'), { recursive: true })
    process.env.GROK_HOME = grokBase
    expect(await describeGrokSession('dddd-4444')).toBeUndefined()
    expect(harnessSessionExists('grok', 'dddd-4444')).toBe(true)
    // Path-ish ids never escape the store root.
    expect(await describeGrokSession('../../etc')).toBeUndefined()
    expect(await describeGrokSession('')).toBeUndefined()
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

  it('harnessSessionExists rejects path-ish ids — the harness drivers make it caller-reachable', () => {
    // `POST /api/harness-sessions/:enc/resume` and `.../turns` reach this with
    // an id from the wire, not just with a den key the term manager minted.
    const grokBase = mkdtempSync(join(tmpdir(), 'grok-traversal-'))
    dirs.push(grokBase)
    mkdirSync(join(grokBase, 'sessions', '%2Fhome%2Frivet'), { recursive: true })
    process.env.GROK_HOME = grokBase
    process.env.CLAUDE_CONFIG_DIR = grokBase
    for (const command of ['grok', 'claude', 'hermes']) {
      expect(harnessSessionExists(command, '')).toBe(false)
      expect(harnessSessionExists(command, '..')).toBe(false)
      expect(harnessSessionExists(command, '../../etc/passwd')).toBe(false)
      expect(harnessSessionExists(command, 'a/b')).toBe(false)
    }
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

  it('strips a Hermes Reasoning box from the sqlite transcript', async () => {
    let DatabaseSync: (new (p: string) => { exec(sql: string): void; close(): void }) | undefined
    try {
      ;({ DatabaseSync } = await import('node:sqlite'))
    } catch {
      return
    }
    const base = mkdtempSync(join(tmpdir(), 'hermes-box-'))
    dirs.push(base)
    const boxed = [
      '┌─ Reasoning ──────────────────────────────────────────────────────────────────────────────────────┐',
      '│ thinking about the leak',
      '└──────────────────────────────────────────────────────────────────────────────────────────────────┘',
      '',
      'The reply.',
    ]
      .join('\n')
      .replace(/'/g, "''")
    const db = new DatabaseSync(join(base, 'state.db'))
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp INTEGER);
      INSERT INTO sessions VALUES ('sess_box', 1000, 2000);
      INSERT INTO messages VALUES ('sess_box','user','hi',1000);
      INSERT INTO messages VALUES ('sess_box','assistant','${boxed}',1001);
    `)
    db.close()
    process.env.HERMES_HOME = base
    const tx = await readHermesTranscript('sess_box')
    expect(tx.turns.map((t) => t.text)).toEqual(['hi', 'The reply.'])
    delete process.env.HERMES_HOME
  })

  it('pairs hermes tool_calls with tool rows and stamps complete from finish_reason', async () => {
    let DatabaseSync: (new (p: string) => { exec(sql: string): void; close(): void }) | undefined
    try {
      ;({ DatabaseSync } = await import('node:sqlite'))
    } catch {
      return
    }
    const base = mkdtempSync(join(tmpdir(), 'hermes-tools-'))
    dirs.push(base)
    const tools = JSON.stringify([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
      },
    ]).replace(/'/g, "''")
    const db = new DatabaseSync(join(base, 'state.db'))
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE messages (
        session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT,
        tool_name TEXT, timestamp INTEGER, finish_reason TEXT, reasoning TEXT,
        reasoning_content TEXT, active INTEGER, compacted INTEGER
      );
      INSERT INTO sessions VALUES ('sess_tools', 1000, 2000);
      INSERT INTO messages VALUES ('sess_tools','user','read a.ts',NULL,NULL,NULL,1000,NULL,NULL,NULL,1,0);
      INSERT INTO messages VALUES ('sess_tools','assistant','','call_1','${tools}','read_file',1001,'tool_calls','looking it up',NULL,1,0);
    `)
    db.close()
    process.env.HERMES_HOME = base
    const running = await readHermesTranscript('sess_tools')
    const asst = running.turns.find((t) => t.role === 'assistant')
    expect(asst?.complete).toBeUndefined()
    expect(asst?.stopReason).toBe('tool_use')
    expect(asst?.thinking).toBe('looking it up')
    expect(asst?.tools).toEqual([
      { name: 'read_file', status: 'running', id: 'call_1', args: { path: 'a.ts' } },
    ])

    const db2 = new DatabaseSync(join(base, 'state.db'))
    db2.exec(`
      INSERT INTO messages VALUES ('sess_tools','tool','export const a = 1','call_1',NULL,'read_file',1002,NULL,NULL,NULL,1,0);
      INSERT INTO messages VALUES ('sess_tools','assistant','it exports a',NULL,NULL,NULL,1003,'stop',NULL,NULL,1,0);
    `)
    db2.close()
    const full = await readHermesTranscript('sess_tools')
    const last = full.turns[full.turns.length - 1]
    expect(last?.role).toBe('assistant')
    expect(last?.text).toBe('it exports a')
    expect(last?.stopReason).toBe('end_turn')
    expect(last?.lastBlock).toBe('text')
    expect(last?.complete).toBe(true)
    expect(last?.tools?.[0]?.status).toBe('done')
    delete process.env.HERMES_HOME
  })

  it('reads kimi sessions across BOTH on-disk state shapes', async () => {
    const { v1, v2, untitled } = fakeKimiStore()
    const sessions = await listHarnessSessions(['kimi'])
    expect(sessions.map((s) => s.id)).toEqual([v2, v1, untitled]) // newest first
    expect(sessions[0]).toEqual({
      id: v2,
      command: 'kimi',
      // v2 state carries no title, and this session has no transcript either —
      // the id is the honest fallback, never a guess.
      title: v2,
      updatedAt: 1_700_000_200_000,
      createdAt: 1_700_000_000_000,
    })
    // The older shape's ISO strings parse to the same epoch-ms the newer
    // shape's numbers are, so a mixed store sorts correctly.
    expect(sessions[1]).toMatchObject({
      id: v1,
      title: 'ship the release',
      updatedAt: 1_700_000_060_000,
      createdAt: 1_700_000_000_000,
    })
    expect(sessions[2].title).toBe('review the harness driver')
  })

  it('finds the opening human turn past the old 64K head bound', async () => {
    // Measured on a real 55-session store: a 64K window finds the first human
    // turn in only 37 of 54, because kimi's transcript opens with a
    // `config.update` carrying the whole system prompt and, on a session
    // started from a large pasted prompt, a `turn.prompt` echo of it. A third
    // of the drawer would be labelled with the raw session id.
    const { home } = fakeKimiStore()
    const id = 'session_55555555-5555-4555-8555-555555555555'
    const dir = join(home, 'sessions', 'wd_rivet_abc123', id)
    mkdirSync(join(dir, 'agents', 'main'), { recursive: true })
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ id, version: 2, createdAt: 9, updatedAt: 9 }),
    )
    writeFileSync(
      join(dir, 'agents', 'main', 'wire.jsonl'),
      [
        // one record far larger than a single chunk read, so this also pins
        // that a line spanning chunk boundaries is reassembled rather than
        // split into two unparseable halves
        JSON.stringify({ type: 'config.update', systemPrompt: 'x'.repeat(200_000) }),
        JSON.stringify({
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'y'.repeat(50_000) }],
        }),
        JSON.stringify({
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'deep opening turn' }],
            origin: { kind: 'user' },
          },
        }),
      ].join('\n') + '\n',
    )
    expect((await describeKimiSession(id))?.title).toBe('deep opening turn')
  })

  it('agrees with describeKimiSession on the same session', async () => {
    const { v1, v2 } = fakeKimiStore()
    const listed = await listHarnessSessions(['kimi'])
    for (const id of [v1, v2]) {
      expect(await describeKimiSession(id)).toEqual(listed.find((s) => s.id === id))
    }
    expect(await describeKimiSession('session_nope')).toBeUndefined()
    expect(await describeKimiSession('../../etc/passwd')).toBeUndefined()
  })

  it('describeKimiSession takes the fast path through session_index.jsonl', async () => {
    const { home, v1 } = fakeKimiStore()
    writeFileSync(
      join(home, 'session_index.jsonl'),
      JSON.stringify({
        sessionId: v1,
        sessionDir: join(home, 'sessions', 'wd_rivetos_def456', v1),
        workDir: '/rivet-shared',
      }) + '\n',
    )
    expect((await describeKimiSession(v1))?.title).toBe('ship the release')

    // An index line whose dir does not END in the id is never trusted — the
    // index is data on disk and a caller-reachable id must not be able to point
    // a read somewhere else.
    writeFileSync(
      join(home, 'session_index.jsonl'),
      JSON.stringify({ sessionId: v1, sessionDir: join(home, 'sessions', 'wd_rivet_abc123') }) +
        '\n',
    )
    expect((await describeKimiSession(v1))?.title).toBe('ship the release') // scan fallback
  })

  it('harnessSessionExists: kimi checks the session DIR, written before state.json', () => {
    const { home, v2 } = fakeKimiStore()
    expect(harnessSessionExists('kimi', v2)).toBe(true)
    expect(harnessSessionExists('kimi', 'session_deadbeef')).toBe(false)
    // A dir that exists but has no state.json yet is still taken: kimi creates
    // the dir first, so describability is a strict subset of existence.
    mkdirSync(join(home, 'sessions', 'wd_rivet_abc123', 'session_fresh'), { recursive: true })
    expect(harnessSessionExists('kimi', 'session_fresh')).toBe(true)
    expect(describeKimiSession('session_fresh')).resolves.toBeUndefined()
  })

  it('empty when the harness has no store / is not a known harness', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'does-not-exist-' + String(process.pid))
    process.env.GROK_HOME = join(tmpdir(), 'no-grok-' + String(process.pid))
    process.env.HERMES_HOME = join(tmpdir(), 'no-hermes-' + String(process.pid))
    process.env.KIMI_CODE_HOME = join(tmpdir(), 'no-kimi-' + String(process.pid))
    process.env.DSH_HOME = join(tmpdir(), 'no-dsh-' + String(process.pid))
    process.env.CODEX_HOME = join(tmpdir(), 'no-codex-' + String(process.pid))
    process.env.PI_HOME = join(tmpdir(), 'no-pi-' + String(process.pid))
    expect(
      await listHarnessSessions(['claude', 'grok', 'hermes', 'kimi', 'dsh', 'codex', 'pi']),
    ).toEqual([])
    expect(await listHarnessSessions(['shell'])).toEqual([]) // no reader wired
    delete process.env.GROK_HOME
    delete process.env.HERMES_HOME
    delete process.env.KIMI_CODE_HOME
    delete process.env.DSH_HOME
    delete process.env.CODEX_HOME
    delete process.env.PI_HOME
  })

  it('reads dsh sessions from ~/.dsh/sessions/<cwd-slug>/session-<uuid>/', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-store-'))
    dirs.push(home)
    process.env.DSH_HOME = home
    const id = 'session-86ffe759-cd7b-49a7-955d-c282631a935d'
    const dir = join(home, 'sessions', 'home-rivet-workspace', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), '')
    const sessions = await listHarnessSessions(['dsh'])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id, command: 'dsh', title: id })
    expect(await describeDshSession(id)).toEqual(sessions[0])
    expect(harnessSessionExists('dsh', id)).toBe(true)
    expect(harnessSessionExists('dsh', 'session-nope')).toBe(false)
    expect(await describeDshSession('../../etc/passwd')).toBeUndefined()
    expect(await resolveHarnessStore(`deepseek-harness:${id}`)).toEqual({
      command: 'dsh',
      path: join(dir, 'session.jsonl.zstd'),
    })
  })

  it('reads pi sessions from ~/.pi/sessions/<id>/transcript.jsonl', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-store-'))
    dirs.push(home)
    process.env.PI_HOME = home
    const id = '89965427-b96f-4d5e-8ad5-c3dd138e33dc'
    const dir = join(home, 'sessions', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'transcript.jsonl'),
      [
        JSON.stringify({ role: 'user', content: 'ship the pi wiring' }),
        JSON.stringify({ role: 'assistant', content: 'on it' }),
      ].join('\n') + '\n',
    )
    const sessions = await listHarnessSessions(['pi'])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id, command: 'pi', title: 'ship the pi wiring' })
    expect(await describePiSession(id)).toEqual(sessions[0])
    expect(harnessSessionExists('pi', id)).toBe(true)
    expect(harnessSessionExists('pi', 'deadbeef')).toBe(false)
    expect(await describePiSession('../../etc/passwd')).toBeUndefined()
    expect(harnessSessionExists('pi', '../x')).toBe(false)
    const tx = await readPiTranscript(id)
    expect(tx).toMatchObject({
      id,
      command: 'pi',
      turns: [
        { role: 'user', text: 'ship the pi wiring' },
        { role: 'assistant', text: 'on it' },
      ],
    })
    expect((await readHarnessTranscript(`pi:${id}`)).command).toBe('pi')
    expect(await resolveHarnessStore(`pi:${id}`)).toEqual({
      command: 'pi',
      path: join(dir, 'transcript.jsonl'),
    })
  })

  it('reads a flat ~/.pi/sessions/<id>.jsonl as a pi session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-flat-'))
    dirs.push(home)
    process.env.PI_HOME = home
    const id = '42accb06-524a-47a6-b4b3-0991552914d7'
    mkdirSync(join(home, 'sessions'), { recursive: true })
    writeFileSync(
      join(home, 'sessions', `${id}.jsonl`),
      JSON.stringify({ type: 'user', text: 'flat transcript' }) + '\n',
    )
    const sessions = await listHarnessSessions(['pi'])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id, command: 'pi', title: 'flat transcript' })
    expect(harnessSessionExists('pi', id)).toBe(true)
    expect((await readPiTranscript(id)).turns).toEqual([{ role: 'user', text: 'flat transcript' }])
  })

  it('treats a pi session DIR without a transcript as existing but untitled', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-empty-'))
    dirs.push(home)
    process.env.PI_HOME = home
    const id = '15cb936c-3364-49d6-8769-21f0c635f160'
    mkdirSync(join(home, 'sessions', id), { recursive: true })
    expect(harnessSessionExists('pi', id)).toBe(true)
    const row = await describePiSession(id)
    expect(row).toMatchObject({ id, command: 'pi', title: id })
    expect(await readPiTranscript(id)).toEqual({ id, command: '', turns: [] })
  })
})

describe('readHarnessTranscript', () => {
  it('stamps truncated when the store exceeds the parse window', async () => {
    const base = mkdtempSync(join(tmpdir(), 'claude-trunc-'))
    dirs.push(base)
    const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const dir = join(base, 'projects', '-home-rivet')
    mkdirSync(dir, { recursive: true })
    const lines = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: `turn-${String(i)}-${'x'.repeat(20)}` } }),
    )
    writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
    process.env.CLAUDE_CONFIG_DIR = base
    setTranscriptMaxBytesForTest(180)
    const t = await readHarnessTranscript(id)
    expect(t.truncated).toBe(true)
    expect(t.turns.length).toBeGreaterThan(0)
    expect(t.turns[0]?.text).not.toBe('turn-0-xxxxxxxxxxxxxxxxxxxx')
  })

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
          message: {
            model: 'claude-opus-4',
            content: [
              { type: 'text', text: 'hi there' },
              { type: 'thinking', text: 'x' },
            ],
            usage: {
              input_tokens: 1000,
              output_tokens: 40,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 50,
            },
          },
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
      {
        role: 'assistant',
        text: 'hi there',
        thinking: 'x', // thinking blocks ride the turn now (text variant tolerated)
        lastBlock: 'thinking',
        model: 'claude-opus-4',
        // prompt = input + cache_read + cache_creation (den-hook parity)
        usage: { promptTokens: 1250, completionTokens: 40, cachedTokens: 200 },
      },
      { role: 'user', text: 'second turn' },
    ])
  })

  it('folds one Claude turn from many store lines: tools, results, summed usage', async () => {
    const base = mkdtempSync(join(tmpdir(), 'claude-fold-'))
    dirs.push(base)
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const dir = join(base, 'projects', '-home-rivet')
    mkdirSync(dir, { recursive: true })
    const usage = (out: number, inp: number) => ({
      input_tokens: inp,
      output_tokens: out,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { content: 'run the tests' } }),
        // block 1: a tool_use line (no text yet)
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-opus-4',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm test' } },
            ],
            usage: usage(10, 500),
          },
        }),
        // its result rides a user-role line — status update, NOT a user turn
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
        }),
        // block 2: a failing tool
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tu_2', name: 'Edit', input: {} }],
            usage: usage(5, 600),
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'boom' },
            ],
          },
        }),
        // final text block carries the reply + final context size
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'tests pass, edit failed' }],
            usage: usage(25, 700),
          },
        }),
        JSON.stringify({ type: 'user', message: { content: 'thanks' } }),
      ].join('\n') + '\n',
    )
    process.env.CLAUDE_CONFIG_DIR = base

    const t = await readHarnessTranscript(id)
    expect(t.turns).toEqual([
      { role: 'user', text: 'run the tests' },
      {
        role: 'assistant',
        text: 'tests pass, edit failed',
        lastBlock: 'text',
        tools: [
          { name: 'Bash', status: 'done', args: { command: 'npm test' }, id: 'tu_1' },
          { name: 'Edit', status: 'error', id: 'tu_2' },
        ],
        model: 'claude-opus-4',
        // output SUMMED across the turn's lines; prompt from the LAST line
        usage: { promptTokens: 700, completionTokens: 40, cachedTokens: 0 },
      },
      { role: 'user', text: 'thanks' },
    ])
  })

  it('filters harness-injected wrappers: task-notification, isMeta, compact summary', async () => {
    const base = mkdtempSync(join(tmpdir(), 'claude-filter-'))
    dirs.push(base)
    const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    const dir = join(base, 'projects', '-home-rivet')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          isCompactSummary: true,
          message: { content: 'This session is being continued from a previous conversation…' },
        }),
        JSON.stringify({ type: 'user', message: { content: 'real question' } }),
        JSON.stringify({
          type: 'user',
          message: {
            content: '<task-notification>\n<task-id>a1b2</task-id>\n</task-notification>',
          },
        }),
        JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta noise' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'real answer' }] },
        }),
        // Claude Code 2.1.263 writes the raw slash line BEFORE the <command-name> echo;
        // neither is conversation, and a trailing bare "/compact" must not read as a
        // pending user turn (status stuck on "thinking" until the stale release).
        JSON.stringify({ type: 'user', message: { role: 'user', content: '/compact' } }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '<command-name>/compact</command-name>' },
        }),
        JSON.stringify({ type: 'system', subtype: 'local_command', content: 'x' }),
      ].join('\n') + '\n',
    )
    process.env.CLAUDE_CONFIG_DIR = base

    const t = await readHarnessTranscript(id)
    expect(t.turns).toEqual([
      { role: 'user', text: 'real question' },
      { role: 'assistant', text: 'real answer', lastBlock: 'text' },
    ])
  })

  it('turns a compact_boundary into a complete marker carrying the post-compaction context size', async () => {
    const base = mkdtempSync(join(tmpdir(), 'claude-compact-'))
    dirs.push(base)
    const id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    const dir = join(base, 'projects', '-home-rivet')
    mkdirSync(dir, { recursive: true })
    const usage = { input_tokens: 900_000, output_tokens: 5, cache_read_input_tokens: 0 }
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'big question' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            usage,
            content: [{ type: 'text', text: 'big answer' }],
          },
        }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: '/compact' } }),
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          compactMetadata: { trigger: 'manual', preTokens: 949_579, postTokens: 19_624 },
        }),
        JSON.stringify({
          type: 'user',
          isCompactSummary: true,
          message: { role: 'user', content: 'This session is being continued…' },
        }),
      ].join('\n') + '\n',
    )
    process.env.CLAUDE_CONFIG_DIR = base

    const t = await readHarnessTranscript(id)
    expect(t.turns.map((x) => x.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(t.turns[1]?.usage?.promptTokens).toBe(900_000)
    expect(t.turns[2]).toEqual({
      role: 'assistant',
      text: 'Conversation compacted (950k tokens → 20k tokens)',
      stopReason: 'end_turn',
      lastBlock: 'text',
      complete: true,
      compact: true,
      usage: { promptTokens: 19_624, completionTokens: 0, cachedTokens: 0 },
    })
    // a boundary without metadata still closes the turn and marks the compaction
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'q' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'a' }],
          },
        }),
        JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      ].join('\n') + '\n',
    )
    const bare = await readHarnessTranscript(id)
    expect(bare.turns[2]).toEqual({
      role: 'assistant',
      text: 'Conversation compacted',
      stopReason: 'end_turn',
      lastBlock: 'text',
      complete: true,
      compact: true,
    })
  })

  it('an auto compact_boundary MID-turn (after a tool_result) neither splits the turn nor completes it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'claude-autocompact-'))
    dirs.push(base)
    const id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    const dir = join(base, 'projects', '-home-rivet')
    mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          usage: { input_tokens: 800_000, output_tokens: 5 },
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'auto', preTokens: 800_000, postTokens: 30_000 },
      }),
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'This session is being continued…' },
      }),
    ]
    writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
    process.env.CLAUDE_CONFIG_DIR = base

    const mid = await readHarnessTranscript(id)
    expect(mid.turns.map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(mid.turns[1]?.complete).toBeUndefined()
    expect(mid.turns[1]?.compact).toBeUndefined()
    expect(mid.turns[1]?.tools?.[0]?.status).toBe('done')

    // the continuation folds into the SAME turn and its usage resets the meter
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          usage: { input_tokens: 31_000, output_tokens: 7 },
          content: [{ type: 'text', text: 'done' }],
        },
      }),
    )
    writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
    const after = await readHarnessTranscript(id)
    expect(after.turns.map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(after.turns[1]?.complete).toBe(true)
    expect(after.turns[1]?.usage?.promptTokens).toBe(31_000)
    expect(after.turns[1]?.text).toBe('done')
  })

  it('an auto compact_boundary BEFORE the first assistant line of a turn adds no marker', async () => {
    const base = mkdtempSync(join(tmpdir(), 'claude-precompact-'))
    dirs.push(base)
    const id = 'abababab-abab-abab-abab-abababababab'
    const dir = join(base, 'projects', '-home-rivet')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'huge paste' } }),
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          compactMetadata: { trigger: 'auto', preTokens: 900_000, postTokens: 40_000 },
        }),
      ].join('\n') + '\n',
    )
    process.env.CLAUDE_CONFIG_DIR = base
    const t = await readHarnessTranscript(id)
    expect(t.turns).toEqual([{ role: 'user', text: 'huge paste' }])
  })

  it('a bare slash line in a Claude store is a command, not a user turn (claude-only filter)', () => {
    expect(isBareSlashCommand('/compact')).toBe(true)
    expect(isBareSlashCommand('/model haiku')).toBe(true)
    expect(isBareSlashCommand('/exit')).toBe(true)
    expect(isBareSlashCommand('//not a command')).toBe(false)
    expect(isBareSlashCommand('/opt/rivetos is the runtime')).toBe(false)
    expect(isBareSlashCommand('see /compact for details')).toBe(false)
    expect(isBareSlashCommand('/compact\nthen more text')).toBe(false)
    expect(extractTurnText('/tmp is full, clean it', 'user')).toBe('/tmp is full, clean it')
    expect(extractTurnText('<environment_context>cwd</environment_context>', 'user')).toBeNull()
    expect(extractTurnText('<skills_instructions>x</skills_instructions>', 'user')).toBeNull()
    expect(extractTurnText('<multi_agent_foo>x</multi_agent_foo>', 'user')).toBeNull()
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
      {
        role: 'assistant',
        text: 'ok, planning',
        lastBlock: 'text',
        stopReason: 'end_turn',
        complete: true,
      },
    ])
  })

  it('folds grok tool_calls/tool_result/reasoning and stamps complete only on the final text line', () => {
    const lines: Record<string, unknown>[] = [
      { type: 'system', content: 'boot' },
      {
        type: 'user',
        content: [{ type: 'text', text: 'read the file' }],
        prompt_index: 0,
      },
      {
        type: 'user',
        content: [{ type: 'text', text: 'ignore me' }],
        synthetic_reason: 'system_reminder',
        prompt_index: 0,
      },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'need the contents' }],
        encrypted_content: 'enc',
        status: 'completed',
      },
      {
        type: 'assistant',
        content: 'opening it',
        tool_calls: [
          {
            id: 'call-abc-0',
            name: 'read_file',
            arguments: '{"target_file":"src/a.ts"}',
          },
        ],
        model_id: 'grok-4.6',
      },
      { type: 'tool_result', tool_call_id: 'call-abc-0', content: 'export const a = 1' },
      { type: 'assistant', content: 'it exports a', model_id: 'grok-4.6' },
    ]
    const mid = grokTurnsFromLines(lines.slice(0, 5))
    const midAsst = mid.find((t) => t.role === 'assistant')
    expect(midAsst?.complete).toBeUndefined()
    expect(midAsst?.stopReason).toBe('tool_use')
    expect(midAsst?.tools).toEqual([
      { name: 'read_file', status: 'running', id: 'call-abc-0', args: { target_file: 'src/a.ts' } },
    ])
    expect(midAsst?.thinking).toBe('need the contents')

    const paired = grokTurnsFromLines(lines.slice(0, 6))
    expect(paired.find((t) => t.role === 'assistant')?.tools?.[0]?.status).toBe('done')
    expect(paired.find((t) => t.role === 'assistant')?.complete).toBeUndefined()

    const full = grokTurnsFromLines(lines)
    const last = full[full.length - 1]
    expect(last?.role).toBe('assistant')
    expect(last?.text).toBe('opening it\n\nit exports a')
    expect(last?.stopReason).toBe('end_turn')
    expect(last?.lastBlock).toBe('text')
    expect(last?.complete).toBe(true)
    expect(last?.tools?.[0]).toMatchObject({
      id: 'call-abc-0',
      name: 'read_file',
      status: 'done',
    })
    expect(last?.model).toBe('grok-4.6')
    expect(full.some((t) => t.text === 'ignore me')).toBe(false)
  })

  it('returns empty for unknown session ids', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'none-' + String(process.pid))
    const t = await readHarnessTranscript('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')
    expect(t).toEqual({ id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', command: '', turns: [] })
  })

  it('reads by canonical SessionId and echoes the id the caller asked with', async () => {
    // Hub chat keys threads canonically, so the resync read has to accept that
    // shape — and answer under it, or the client cannot match the response to
    // the thread it asked about (§ Legacy keys).
    const base = mkdtempSync(join(tmpdir(), 'claude-canon-'))
    dirs.push(base)
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const dir = join(base, 'projects', '-home-rivet')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${id}.jsonl`),
      JSON.stringify({ type: 'user', message: { content: 'canonical read' } }) + '\n',
    )
    process.env.CLAUDE_CONFIG_DIR = base

    const bare = await readHarnessTranscript(id)
    const canonical = await readHarnessTranscript(`claude-code:${id}`)
    expect(canonical.turns).toEqual(bare.turns)
    expect(canonical.command).toBe('claude')
    expect(canonical.id).toBe(`claude-code:${id}`)
    // …including the path-fallback capture key, which aliases onto the uuid
    const pathForm = await readHarnessTranscript(`claude-code:-home-rivet/${id}`)
    expect(pathForm.turns).toEqual(bare.turns)
  })

  it('a canonical id never falls through to another harness store', async () => {
    // A canonical id NAMES its store (§ Collision rules, rule 2: a different
    // harness id is a different session). The bare probe order is claude →
    // grok → hermes → kimi, so a uuid present in BOTH stores is exactly where
    // a fall-through would show up — and a wrong transcript here is worse than
    // an empty one, because the chat would resync a whole other conversation.
    const id = 'cafe1111-0000-4000-8000-000000000002'
    const claudeBase = mkdtempSync(join(tmpdir(), 'canon-claude-'))
    const grokBase = mkdtempSync(join(tmpdir(), 'canon-grok-'))
    dirs.push(claudeBase, grokBase)

    const slug = join(claudeBase, 'projects', '-home-rivet')
    mkdirSync(slug, { recursive: true })
    writeFileSync(
      join(slug, `${id}.jsonl`),
      JSON.stringify({ type: 'user', message: { content: 'claude turn' } }) + '\n',
    )
    const grokDir = join(grokBase, 'sessions', 'cwd', id)
    mkdirSync(grokDir, { recursive: true })
    writeFileSync(
      join(grokDir, 'chat_history.jsonl'),
      JSON.stringify({ role: 'user', content: 'grok turn' }) + '\n',
    )
    process.env.CLAUDE_CONFIG_DIR = claudeBase
    process.env.GROK_HOME = grokBase

    // bare: legacy probe order wins, claude first — unchanged behavior
    expect((await readHarnessTranscript(id)).command).toBe('claude')
    // canonical: each id reads its OWN store, never the other's
    const claude = await readHarnessTranscript(`claude-code:${id}`)
    expect(claude.command).toBe('claude')
    expect(claude.turns.map((t) => t.text)).toEqual(['claude turn'])
    const grok = await readHarnessTranscript(`grok-build:${id}`)
    expect(grok.command).toBe('grok')
    expect(grok.turns.map((t) => t.text)).toEqual(['grok turn'])
    // a harness with no row for this uuid answers empty, not someone else's
    expect(await readHarnessTranscript(`hermes:${id}`)).toEqual({
      id: `hermes:${id}`,
      command: '',
      turns: [],
    })
    // …and the watcher resolves the same way (a wrong ref here is cached for
    // the life of the watch)
    expect((await resolveHarnessStore(`claude-code:${id}`))?.command).toBe('claude')
    expect((await resolveHarnessStore(`grok-build:${id}`))?.command).toBe('grok')
    expect(await resolveHarnessStore(`hermes:${id}`)).toBeUndefined()
  })

  it('resolveHarnessStore points a canonical id at the same store file', async () => {
    // The transcript watcher resolves once and then parses that path on every
    // change; a canonical watch key that failed to resolve would silently
    // downgrade the whole session to the slow full-scan path.
    const base = mkdtempSync(join(tmpdir(), 'claude-canon-store-'))
    dirs.push(base)
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const dir = join(base, 'projects', '-home-rivet')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), '')
    process.env.CLAUDE_CONFIG_DIR = base

    expect(await resolveHarnessStore(`claude-code:${id}`)).toEqual(await resolveHarnessStore(id))
    expect((await resolveHarnessStore(`claude-code:${id}`))?.command).toBe('claude')
  })

  it('readGrokTranscript never falls through to another harness store', async () => {
    // The id-only drawer read probes claude → grok → hermes; the grok DRIVER
    // must not serve a Claude transcript for an id it was handed, however
    // improbable a cross-store uuid collision is.
    const id = 'cafe0000-0000-4000-8000-000000000001'
    const claudeBase = mkdtempSync(join(tmpdir(), 'claude-only-'))
    dirs.push(claudeBase)
    const slug = join(claudeBase, 'projects', '-home-rivet')
    mkdirSync(slug, { recursive: true })
    writeFileSync(
      join(slug, `${id}.jsonl`),
      JSON.stringify({ type: 'user', message: { content: 'claude turn' } }) + '\n',
    )
    process.env.CLAUDE_CONFIG_DIR = claudeBase
    process.env.GROK_HOME = join(tmpdir(), 'no-grok-' + String(process.pid))

    expect((await readHarnessTranscript(id)).command).toBe('claude')
    expect(await readGrokTranscript(id)).toEqual({ id, command: '', turns: [] })
  })

  it('folds one kimi turn out of wire.jsonl loop events: text, thinking, tools, usage', async () => {
    // kimi's transcript is an event log of the agent loop, not a message list —
    // and it is the ONLY place a kimi reply or thought exists at all, because
    // its hooks carry neither. This is what the `kimi-code` driver's
    // hard-resync has to reconstruct.
    const home = mkdtempSync(join(tmpdir(), 'kimi-tx-'))
    dirs.push(home)
    const id = 'session_44444444-4444-4444-8444-444444444444'
    // No state.json on purpose: the dir is what makes the session real, and a
    // transcript must be readable in the window before the state file lands.
    const dir = join(home, 'sessions', 'wd_rivet_abc123', id, 'agents', 'main')
    mkdirSync(dir, { recursive: true })
    const step = { turnId: '0', step: 1, stepUuid: 's1' }
    writeFileSync(
      join(dir, 'wire.jsonl'),
      [
        { type: 'metadata', protocol_version: '1.5' },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'review the diff' }],
            origin: { kind: 'user' },
          },
        },
        // injected noise: user-role, but kimi talking to itself
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '<system-reminder>todo</system-reminder>' }],
            origin: { kind: 'injection' },
          },
        },
        { type: 'llm.request', model: 'kimi-k2', kind: 'chat' },
        { type: 'context.append_loop_event', event: { type: 'step.begin', ...step } },
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', ...step, part: { type: 'think', think: 'weighing it' } },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            ...step,
            toolCallId: 'Bash_0',
            name: 'Bash',
            args: { command: 'git diff', timeout: 30 },
          },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            ...step,
            toolCallId: 'Read_0',
            name: 'Read',
            args: { path: '/tmp/x' },
          },
        },
        {
          type: 'context.append_loop_event',
          // kimi records a real isError, unlike den's tool.end — so a resynced
          // transcript can report a failed tool honestly where the live stream
          // cannot.
          event: {
            type: 'tool.result',
            toolCallId: 'Bash_0',
            result: { output: 'boom', isError: true },
          },
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'tool.result', toolCallId: 'Read_0', result: { output: 'file' } },
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', ...step, part: { type: 'text', text: 'looks good' } },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'step.end',
            ...step,
            usage: { inputOther: 100, inputCacheRead: 20, inputCacheCreation: 5, output: 40 },
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    )
    process.env.KIMI_CODE_HOME = home

    expect(await readKimiTranscript(id)).toEqual({
      id,
      command: 'kimi',
      turns: [
        { role: 'user', text: 'review the diff' },
        {
          role: 'assistant',
          text: 'looks good',
          stopReason: 'end_turn',
          lastBlock: 'text',
          complete: true,
          thinking: 'weighing it',
          tools: [
            {
              name: 'Bash',
              status: 'error',
              args: { command: 'git diff', timeout: 30 },
              id: 'Bash_0',
            },
            { name: 'Read', status: 'done', args: { path: '/tmp/x' }, id: 'Read_0' },
          ],
          usage: { promptTokens: 125, completionTokens: 40, cachedTokens: 20 },
          model: 'kimi-k2',
        },
      ],
    })
    // The drawer's id-only probe reaches it too, and a deleted store reads
    // empty rather than falling through to another harness.
    expect((await readHarnessTranscript(id)).command).toBe('kimi')
    expect(await readKimiTranscript('session_gone')).toEqual({
      id: 'session_gone',
      command: '',
      turns: [],
    })
  })

  it('stamps stopReason/lastBlock/complete from the real Claude sequence; complete absent in-flight', () => {
    const asst = (stop: string, block: Record<string, unknown>): Record<string, unknown> => ({
      type: 'assistant',
      message: { stop_reason: stop, content: [block] },
    })
    const toolResults = (...ids: string[]): Record<string, unknown> => ({
      type: 'user',
      message: {
        content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
      },
    })
    const lines: Record<string, unknown>[] = [
      { type: 'user', message: { content: 'do the thing' } },
      asst('tool_use', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo 1' } }),
      asst('tool_use', { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo 2' } }),
      toolResults('t1', 't2'),
      asst('tool_use', { type: 'thinking', thinking: 'next step' }),
      asst('tool_use', { type: 'tool_use', id: 't3', name: 'Read', input: { path: 'x' } }),
      toolResults('t3'),
      asst('end_turn', { type: 'thinking', thinking: 'done thinking' }),
      asst('end_turn', { type: 'text', text: 'all done' }),
    ]

    const early = claudeTurnsFromLines(lines.slice(0, 3))
    expect(early.find((t) => t.role === 'assistant')?.complete).toBeUndefined()
    expect(early.find((t) => t.role === 'assistant')?.stopReason).toBe('tool_use')

    const prefix = claudeTurnsFromLines(lines.slice(0, -1))
    const prefixAsst = prefix.filter((t) => t.role === 'assistant')
    expect(prefixAsst.length).toBeGreaterThan(0)
    expect(prefixAsst[prefixAsst.length - 1]?.complete).toBeUndefined()
    expect(prefixAsst[prefixAsst.length - 1]?.stopReason).toBe('end_turn')
    expect(prefixAsst[prefixAsst.length - 1]?.lastBlock).toBe('thinking')

    const full = claudeTurnsFromLines(lines)
    const last = full[full.length - 1]
    expect(last?.role).toBe('assistant')
    expect(last?.stopReason).toBe('end_turn')
    expect(last?.lastBlock).toBe('text')
    expect(last?.complete).toBe(true)
    expect(last?.text).toBe('all done')
  })

  it('preserves AskUserQuestion id/input/resultText and stays incomplete while unanswered', () => {
    const questions = [
      {
        question: 'Which auth?',
        header: 'Auth',
        multiSelect: false,
        options: [
          { label: 'OAuth', description: 'browser' },
          { label: 'API key', description: 'token' },
        ],
      },
    ]
    const ask = {
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'ask_1',
            name: 'AskUserQuestion',
            input: { questions },
          },
        ],
      },
    }
    const unanswered = claudeTurnsFromLines([{ type: 'user', message: { content: 'ask me' } }, ask])
    const tool = unanswered.find((t) => t.role === 'assistant')?.tools?.[0]
    expect(tool?.id).toBe('ask_1')
    expect(
      (tool?.input as { questions: Array<{ options: Array<{ label: string }> }> }).questions[0]
        .options[1].label,
    ).toBe('API key')
    expect(unanswered.find((t) => t.role === 'assistant')?.complete).toBeUndefined()

    const answered = claudeTurnsFromLines([
      { type: 'user', message: { content: 'ask me' } },
      ask,
      {
        type: 'user',
        toolUseResult: { answers: [{ question: 0, labels: ['API key'] }] },
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'ask_1',
              content: 'Your questions have been answered: Auth: API key',
            },
          ],
        },
      },
    ])
    const after = answered.find((t) => t.role === 'assistant')?.tools?.[0]
    expect(after?.resultText).toBe('Your questions have been answered: Auth: API key')
    expect(after?.status).toBe('done')
    expect(answered.find((t) => t.role === 'assistant')?.complete).toBeUndefined()
  })

  it('still summarises away array args on a non-prompt Bash tool', () => {
    const turns = claudeTurnsFromLines([
      { type: 'user', message: { content: 'run' } },
      {
        type: 'assistant',
        message: {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'b1',
              name: 'Bash',
              input: { command: 'ls', files: ['a', 'b'] },
            },
          ],
        },
      },
    ])
    const bash = turns.find((t) => t.role === 'assistant')?.tools?.[0]
    expect(bash?.id).toBe('b1')
    expect(bash?.args).toEqual({ command: 'ls' })
    expect(bash?.args).not.toHaveProperty('files')
    expect(bash?.input).toBeUndefined()
  })
})

describe('kimi completion (hook-free turn-complete)', () => {
  const step = { stepId: 's1' }
  const user = {
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'run it' }],
      origin: { kind: 'user' },
    },
  }
  const ev = (event: Record<string, unknown>): Record<string, unknown> => ({
    type: 'context.append_loop_event',
    event: { ...step, ...event },
  })
  const usage = { inputOther: 10, inputCacheRead: 0, inputCacheCreation: 0, output: 5 }
  const toolStep = [
    { type: 'llm.request', model: 'kimi-k2', kind: 'chat' },
    ev({ type: 'step.begin' }),
    ev({ type: 'content.part', part: { type: 'think', think: 'plan' } }),
    ev({ type: 'tool.call', toolCallId: 'Bash_0', name: 'Bash', args: { command: 'ls' } }),
    ev({ type: 'step.end', usage }),
  ]
  const result = [ev({ type: 'tool.result', toolCallId: 'Bash_0', result: { isError: false } })]
  const finalStep = [
    { type: 'llm.request', model: 'kimi-k2', kind: 'chat' },
    ev({ type: 'step.begin' }),
    ev({ type: 'content.part', part: { type: 'text', text: 'done' } }),
    ev({ type: 'step.end', usage }),
  ]
  it('a step that issued a tool call is tool_use / not complete; the final text step is end_turn + complete', () => {
    const mid = kimiTurnsFromLines([user, ...toolStep])
    const midTurn = mid[mid.length - 1]
    expect(midTurn.role).toBe('assistant')
    expect(midTurn.stopReason).toBe('tool_use')
    expect(midTurn.complete).toBeUndefined()
    expect(midTurn.tools?.[0]).toMatchObject({ name: 'Bash', status: 'running', id: 'Bash_0' })

    const done = kimiTurnsFromLines([user, ...toolStep, ...result, ...finalStep])
    const last = done[done.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.tools?.[0].status).toBe('done')
    expect(last.stopReason).toBe('end_turn')
    expect(last.lastBlock).toBe('text')
    expect(last.complete).toBe(true)
  })
})

describe('codex store: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl', () => {
  const ID = '89965427-b96f-4d5e-8ad5-c3dd138e33dc'
  const ID2 = '42accb06-524a-47a6-b4b3-0991552914d7'

  function fakeCodexStore(): string {
    const home = mkdtempSync(join(tmpdir(), 'codex-store-'))
    dirs.push(home)
    process.env.CODEX_HOME = home
    const day = join(home, 'sessions', '2026', '09', '07')
    mkdirSync(day, { recursive: true })
    const lines = [
      { type: 'session_meta', payload: { id: ID } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [
            { type: 'input_text', text: '<environment_context>skip</environment_context>' },
          ],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'review the rollout parser' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      },
    ]
    writeFileSync(
      join(day, `rollout-2026-09-07T12-00-00-${ID}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    )
    return home
  }

  it('lists newest-first by mtime and titles from the first user input_text', async () => {
    const home = fakeCodexStore()
    const older = join(home, 'sessions', '2026', '09', '06')
    mkdirSync(older, { recursive: true })
    const olderFile = join(older, `rollout-2026-09-06T01-00-00-${ID2}.jsonl`)
    writeFileSync(
      olderFile,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'older session' }],
        },
      }) + '\n',
    )
    const newer = join(
      home,
      'sessions',
      '2026',
      '09',
      '07',
      `rollout-2026-09-07T12-00-00-${ID}.jsonl`,
    )
    utimesSync(newer, 2_000_000_000, 2_000_000_000)
    utimesSync(olderFile, 1_000_000_000, 1_000_000_000)

    const sessions = await listHarnessSessions(['codex'])
    expect(sessions.map((s) => s.id)).toEqual([ID, ID2])
    expect(sessions[0]).toMatchObject({
      id: ID,
      command: 'codex',
      title: 'review the rollout parser',
    })
    expect(sessions[1].title).toBe('older session')
  })

  it('agrees with describeCodexSession on the same session', async () => {
    fakeCodexStore()
    const listed = await listHarnessSessions(['codex'])
    expect(await describeCodexSession(ID)).toEqual(listed.find((s) => s.id === ID))
    expect(await describeCodexSession('00000000-0000-4000-8000-000000000000')).toBeUndefined()
    expect(await describeCodexSession('../../etc/passwd')).toBeUndefined()
    expect(await describeCodexSession('session_' + ID)).toBeUndefined()
  })

  it('harnessSessionExists: codex checks the rollout file', () => {
    fakeCodexStore()
    expect(harnessSessionExists('codex', ID)).toBe(true)
    expect(harnessSessionExists('codex', '00000000-0000-4000-8000-000000000000')).toBe(false)
    expect(harnessSessionExists('codex', 'not-a-uuid')).toBe(false)
  })

  it('readCodexTranscript folds the rollout and resolveHarnessStore names the file', async () => {
    fakeCodexStore()
    const t = await readCodexTranscript(ID)
    expect(t.command).toBe('codex')
    expect(t.turns[0]).toEqual({ role: 'user', text: 'review the rollout parser' })
    expect(t.turns[1]).toMatchObject({ role: 'assistant', text: 'ok', complete: true })
    const ref = await resolveHarnessStore(`codex:${ID}`)
    expect(ref?.command).toBe('codex')
    expect(ref?.path).toContain(ID)
    expect(ref?.path).toContain('rollout-')
  })

  it('resolves room UUIDs through driver resync, canonical reads and watches', async () => {
    const home = fakeCodexStore()
    const path = join(
      home,
      'sessions',
      '2026',
      '09',
      '07',
      `rollout-2026-09-07T12-00-00-${ID}.jsonl`,
    )
    const discover = vi.spyOn(codexRoom, 'resolveCodexRoomRollout').mockResolvedValue(path)
    const expected = await readCodexTranscript(ID)
    expect(discover).not.toHaveBeenCalled()
    expect(await readCodexTranscript(ID2)).toEqual({ ...expected, id: ID2 })
    expect(await readHarnessTranscript(`codex:${ID2}`)).toEqual({ ...expected, id: `codex:${ID2}` })
    expect(await resolveHarnessStore(`codex:${ID2}`)).toEqual({ command: 'codex', path })
    expect(discover).toHaveBeenCalledWith(ID2, join(home, 'sessions'))
    discover.mockClear()
    await readHarnessTranscript(`grok-build:${ID2}`)
    await resolveHarnessStore(`grok-build:${ID2}`)
    expect(discover).not.toHaveBeenCalled()
  })

  it('empty when CODEX_HOME has no sessions', async () => {
    process.env.CODEX_HOME = join(tmpdir(), 'no-codex-' + String(process.pid))
    expect(await listHarnessSessions(['codex'])).toEqual([])
  })
})
