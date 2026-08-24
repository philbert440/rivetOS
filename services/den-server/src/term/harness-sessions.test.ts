import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeClaudeSession,
  describeGrokSession,
  describeKimiSession,
  describeDshSession,
  listHarnessSessions,
  harnessSessionExists,
  readGrokTranscript,
  readHarnessTranscript,
  readKimiTranscript,
  resolveHarnessStore,
  setTranscriptMaxBytesForTest,
} from './harness-sessions.js'

const dirs: string[] = []
afterEach(() => {
  setTranscriptMaxBytesForTest()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.GROK_HOME
  delete process.env.HERMES_HOME
  delete process.env.KIMI_CODE_HOME
  delete process.env.DSH_HOME
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
    expect(await listHarnessSessions(['claude', 'grok', 'hermes', 'kimi', 'dsh'])).toEqual([])
    expect(await listHarnessSessions(['shell'])).toEqual([]) // no reader wired
    delete process.env.GROK_HOME
    delete process.env.HERMES_HOME
    delete process.env.KIMI_CODE_HOME
    delete process.env.DSH_HOME
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
        tools: [
          { name: 'Bash', status: 'done', args: { command: 'npm test' } },
          { name: 'Edit', status: 'error' },
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
      ].join('\n') + '\n',
    )
    process.env.CLAUDE_CONFIG_DIR = base

    const t = await readHarnessTranscript(id)
    expect(t.turns).toEqual([
      { role: 'user', text: 'real question' },
      { role: 'assistant', text: 'real answer' },
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
          thinking: 'weighing it',
          tools: [
            { name: 'Bash', status: 'error', args: { command: 'git diff', timeout: 30 } },
            { name: 'Read', status: 'done', args: { path: '/tmp/x' } },
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
})
