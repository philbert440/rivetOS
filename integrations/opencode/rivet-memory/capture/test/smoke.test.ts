/**
 * Smoke + unit tests for opencode-memory-capture.
 *
 * Layers:
 *   1. Identity constants.
 *   2. Fold against a temp SQLite db with the real OpenCode schema.
 *   3. In-memory stub pool — a session lands as user+assistant+tool with
 *      sqlite pointers. Dedup on a second tick.
 *   4. WAL wake-up path (fs.watch targets + injected watcher).
 *   5. watchTick boot race against PGlite must not kill the watcher.
 *   6. Streaming text/reasoning wait for time.end; errored tools keep
 *      error text; part.time_updated overlap; --backfill 0; coalesced ticks.
 *   7. Truncated tool args keep sqlite pointers; widening --backfill
 *      catches history already behind the saved cursor.
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  deriveSessionKey,
  capForStorage,
  foldParts,
  foldPart,
  createWatcherState,
  scanOnce,
  watchTick,
  attachDbWatchers,
  dbWatchPaths,
  loadState,
  saveState,
  emptyState,
  advanceState,
  backfillCutoffMs,
  parseBackfill,
  createCoalescedRunner,
  insertMessage,
  CURSOR_OVERLAP_MS,
  CAPTURE_AGENT,
  CAPTURE_CHANNEL,
  DEFAULT_CAPTURE_AGENT,
  MAX_CONTENT,
  DEFAULT_BACKFILL_DAYS,
  type Queryable,
  type PartRow,
  type WatchFn,
} from '../src/opencode-memory-capture.ts'

const SESSION = 'ses_abcdefghijklmnopqrstuvwxyz'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.error(`✗ ${name}${detail ? ': ' + detail : ''}`)
    failed++
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

console.log('Running OpenCode Memory Capture tests...\n')

// =============================================================================
// Identity constants
// =============================================================================
console.log('— identity constants —')
{
  eq('CAPTURE_AGENT is rivet-glm', CAPTURE_AGENT, 'rivet-glm')
  eq('DEFAULT_CAPTURE_AGENT is rivet-glm', DEFAULT_CAPTURE_AGENT, 'rivet-glm')
  eq('CAPTURE_CHANNEL is opencode', CAPTURE_CHANNEL, 'opencode')
  eq('deriveSessionKey prefixes opencode:', deriveSessionKey(SESSION), `opencode:${SESSION}`)
  eq('default backfill is 14 days', DEFAULT_BACKFILL_DAYS, 14)
  check('backfill cutoff is in the past', backfillCutoffMs(14) < Date.now())
  eq('backfill 0 cutoff is now (no backfill)', backfillCutoffMs(0, 1_700_000_000_000), 1_700_000_000_000)
  eq('parse --backfill 0 stays 0', parseBackfill(['--backfill', '0']), 0)
  eq('parse missing --backfill is default', parseBackfill([]), DEFAULT_BACKFILL_DAYS)
  eq('cursor overlap is 30s', CURSOR_OVERLAP_MS, 30_000)
}

// =============================================================================
// capForStorage
// =============================================================================
console.log('\n— capForStorage —')
{
  const small = capForStorage('hello', { dbPath: '/x.db', partId: 'prt_1' })
  eq('short text is not truncated', small.truncated, false)
  const big = 'x'.repeat(MAX_CONTENT + 50)
  const capped = capForStorage(big, { dbPath: '/x.db', partId: 'prt_1' })
  check(
    'long text with pointer is truncated',
    capped.truncated && capped.stored.endsWith('…[truncated]'),
  )
  const uncapped = capForStorage(big, { dbPath: null, partId: null })
  check(
    'long text without pointer is left full (deepseek lesson)',
    uncapped.uncapped === true && uncapped.stored.length === big.length,
  )
}

// =============================================================================
// Fold
// =============================================================================
console.log('\n— foldPart —')
{
  const skipped: Record<string, number> = {}
  const base = (over: Partial<PartRow>): PartRow => ({
    id: 'prt_x',
    message_id: 'msg_x',
    session_id: SESSION,
    time_created: 1_700_000_000_000,
    time_updated: 1_700_000_000_000,
    data: {},
    message_data: { role: 'user' },
    message_time_updated: 1_700_000_000_000,
    session_title: 'demo',
    session_directory: '/tmp/demo',
    ...over,
  })

  const user = foldPart(
    base({
      id: 'prt_user1',
      data: { type: 'text', text: 'list the files' },
      message_data: { role: 'user' },
    }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('user text', user?.content, 'list the files')
  eq('user role', user?.role, 'user')
  eq('user event id is part.id', user?.eventId, 'prt_user1')
  eq('user sessionId', user?.sessionId, SESSION)
  check(
    'user row points at the sqlite db',
    user?.extra?.session_sqlite_path === '/tmp/opencode.db',
    `path=${String(user?.extra?.session_sqlite_path)}`,
  )
  check(
    'user row carries part id',
    user?.extra?.session_sqlite_part_id === 'prt_user1',
  )

  const think = foldPart(
    base({
      id: 'prt_think1',
      data: { type: 'reasoning', text: 'I should list', time: { start: 1, end: 2 } },
      message_data: { role: 'assistant', modelID: 'glm-5.3-flash', providerID: 'zai' },
    }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('reasoning captured as [thinking] prefix', think?.content, '[thinking] I should list')
  eq('thinking event id', think?.eventId, 'prt_think1')
  eq('thinking partType', think?.extra?.partType, 'think')
  eq('modelID copied from envelope', think?.extra?.modelID, 'glm-5.3-flash')

  const tool = foldPart(
    base({
      id: 'prt_tool1',
      data: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt' },
      },
      message_data: {
        role: 'assistant',
        tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 0, write: 0 } },
      },
    }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('tool content', tool?.content, '[tool-result] bash')
  eq('tool name', tool?.toolName, 'bash')
  eq('tool result', tool?.toolResult, 'a.txt')
  check(
    'tool args from state.input',
    isRecord(tool?.toolArgs) && (tool?.toolArgs as { command?: string }).command === 'ls',
    `args=${JSON.stringify(tool?.toolArgs)}`,
  )
  check(
    'tool row points at sqlite db + part id',
    tool?.extra?.session_sqlite_path === '/tmp/opencode.db' &&
      tool?.extra?.session_sqlite_part_id === 'prt_tool1',
    `path=${String(tool?.extra?.session_sqlite_path)} part=${String(tool?.extra?.session_sqlite_part_id)}`,
  )

  const running = foldPart(
    base({
      id: 'prt_run',
      data: { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } },
      message_data: { role: 'assistant' },
    }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('running tool skipped', running, null)
  eq('running skip reason counted', skipped['tool:running'], 1)

  const step = foldPart(
    base({ id: 'prt_step', data: { type: 'step-start' }, message_data: { role: 'assistant' } }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('step-start skipped', step, null)

  const sys = foldPart(
    base({ data: { type: 'text', text: 'sys' }, message_data: { role: 'system' } }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('system skipped', sys, null)

  const streamingText = foldPart(
    base({
      id: 'prt_stream',
      data: { type: 'text', text: 'hel' },
      message_data: { role: 'assistant' },
    }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('assistant text without time.end is not inserted', streamingText, null)
  eq('streaming text skip counted', skipped['text:streaming'], 1)

  const finishedText = foldPart(
    base({
      id: 'prt_stream',
      data: { type: 'text', text: 'hello world', time: { start: 1, end: 24 } },
      message_data: { role: 'assistant' },
    }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('assistant text with time.end is inserted', finishedText?.content, 'hello world')

  const streamingThink = foldPart(
    base({
      id: 'prt_think_s',
      data: { type: 'reasoning', text: 'hmm' },
      message_data: { role: 'assistant' },
    }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('reasoning without time.end is not inserted', streamingThink, null)

  const finishedThink = foldPart(
    base({
      id: 'prt_think_s',
      data: { type: 'reasoning', text: 'hmm done', time: { end: 9 } },
      message_data: { role: 'assistant' },
    }),
    '/tmp/opencode.db',
    skipped,
  )
  eq(
    'reasoning with time.end is inserted',
    finishedThink?.content,
    '[thinking] hmm done',
  )

  const errored = foldPart(
    base({
      id: 'prt_err',
      data: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'error', error: 'exit 1', title: 'bash', input: { command: 'false' } },
      },
      message_data: { role: 'assistant' },
    }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('errored tool keeps error text', errored?.toolResult, 'exit 1')
  eq('errored tool content', errored?.content, '[tool-failure] bash')

  const erroredFallback = foldPart(
    base({
      id: 'prt_err2',
      data: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'error', title: 'command failed' },
      },
      message_data: { role: 'assistant' },
    }),
    '/tmp/opencode.db',
    skipped,
  )
  eq('errored tool falls back to title', erroredFallback?.toolResult, 'command failed')
}

// =============================================================================
// Truncated tool args keep sqlite pointer for memory_get_full
// =============================================================================
console.log('\n— truncated tool args keep sqlite pointer —')
{
  const msgs: Array<{ tool_args: string | null; metadata: Record<string, unknown> }> = []
  const client: Queryable = {
    async query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (s.startsWith('SELECT 1 FROM ros_messages')) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith('INSERT INTO ros_messages')) {
        const meta =
          typeof params[8] === 'string' ? (JSON.parse(params[8]) as Record<string, unknown>) : {}
        msgs.push({
          tool_args: typeof params[6] === 'string' ? params[6] : null,
          metadata: meta,
        })
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected sql: ${s}`)
    },
  }
  const big = { patch: 'x'.repeat(MAX_CONTENT + 80) }
  await insertMessage(
    client,
    'conv-1',
    {
      role: 'tool',
      content: '[tool-result] edit',
      toolName: 'edit',
      toolArgs: big,
      toolResult: 'ok',
      eventId: 'prt_bigargs',
      extra: {
        session_sqlite_path: '/tmp/opencode.db',
        session_sqlite_part_id: 'prt_bigargs',
      },
    },
    '/tmp/opencode.db',
  )
  const row = msgs[0]
  check('truncated tool-args row inserted', Boolean(row))
  check(
    'truncated tool-args row keeps sqlite path + part id',
    row?.metadata.session_sqlite_path === '/tmp/opencode.db' &&
      row?.metadata.session_sqlite_part_id === 'prt_bigargs',
  )
  eq('truncated flag set for tool args', row?.metadata.truncated, true)
  eq(
    'full_tool_args_length recorded',
    row?.metadata.full_tool_args_length,
    JSON.stringify(big).length,
  )
  check(
    'stored tool_args were capped',
    typeof row?.tool_args === 'string' && row.tool_args.includes('…[truncated]'),
  )
}

// =============================================================================
// Temp SQLite fixture (real schema from § Hard facts)
// =============================================================================
console.log('\n— sqlite fixture fold —')

async function withFixture<T>(fn: (dbFile: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'opencode-cap-'))
  const dbFile = path.join(dir, 'opencode.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        slug TEXT,
        title TEXT,
        directory TEXT,
        model TEXT,
        agent TEXT,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER,
        cost REAL,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `)
    const now = Date.now()
    db.prepare(
      `INSERT INTO session (id, slug, title, directory, model, agent,
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
         cost, time_created, time_updated, time_archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SESSION,
      'demo',
      'list the files',
      '/tmp/demo',
      JSON.stringify({ id: 'glm-5.3-flash', providerID: 'zai', variant: 'high' }),
      'build',
      100,
      20,
      5,
      10,
      0,
      0.01,
      now - 1000,
      now,
      null,
    )
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'msg_user1',
      SESSION,
      now - 900,
      now - 900,
      JSON.stringify({ role: 'user', time: { created: now - 900 } }),
    )
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'msg_asst1',
      SESSION,
      now - 800,
      now,
      JSON.stringify({
        role: 'assistant',
        parentID: 'msg_user1',
        agent: 'build',
        modelID: 'glm-5.3-flash',
        providerID: 'zai',
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
        cost: 0.01,
        time: { created: now - 800, completed: now },
      }),
    )
    const insertPart = db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    insertPart.run(
      'prt_user1',
      'msg_user1',
      SESSION,
      now - 900,
      now - 900,
      JSON.stringify({ type: 'text', text: 'list the files' }),
    )
    insertPart.run(
      'prt_think1',
      'msg_asst1',
      SESSION,
      now - 850,
      now - 840,
      JSON.stringify({
        type: 'reasoning',
        text: 'I should list',
        time: { start: now - 850, end: now - 840 },
      }),
    )
    insertPart.run(
      'prt_step1',
      'msg_asst1',
      SESSION,
      now - 840,
      now - 840,
      JSON.stringify({ type: 'step-start' }),
    )
    insertPart.run(
      'prt_tool1',
      'msg_asst1',
      SESSION,
      now - 820,
      now - 810,
      JSON.stringify({
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt', title: 'ls' },
      }),
    )
    insertPart.run(
      'prt_text1',
      'msg_asst1',
      SESSION,
      now - 800,
      now - 790,
      JSON.stringify({
        type: 'text',
        text: 'here they are',
        time: { start: now - 800, end: now - 790 },
      }),
    )
    insertPart.run(
      'prt_step2',
      'msg_asst1',
      SESSION,
      now - 790,
      now - 790,
      JSON.stringify({ type: 'step-finish' }),
    )
  } finally {
    db.close()
  }
  try {
    return await fn(dbFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

await withFixture(async (dbFile) => {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.message_id AS message_id, p.session_id AS session_id,
              p.time_created AS time_created, p.time_updated AS time_updated,
              p.data AS data,
              m.data AS message_data, m.time_updated AS message_time_updated,
              s.title AS session_title, s.directory AS session_directory
         FROM part p
         JOIN message m ON m.id = p.message_id
         JOIN session s ON s.id = p.session_id
        ORDER BY p.time_created ASC`,
    )
    .all()
  db.close()
  const parts: PartRow[] = rows.map((r) => ({
    id: String(r.id),
    message_id: String(r.message_id),
    session_id: String(r.session_id),
    time_created: Number(r.time_created),
    time_updated: Number(r.time_updated),
    data: JSON.parse(String(r.data)) as Record<string, unknown>,
    message_data: JSON.parse(String(r.message_data)) as Record<string, unknown>,
    message_time_updated: Number(r.message_time_updated),
    session_title: String(r.session_title),
    session_directory: String(r.session_directory),
  }))
  const parsed = foldParts(parts, dbFile)
  eq('session id', [...parsed.sessions.keys()][0], SESSION)
  eq(
    'cwd from session.directory',
    [...parsed.sessions.values()][0]?.directory,
    '/tmp/demo',
  )
  eq(
    'title from session.title',
    [...parsed.sessions.values()][0]?.title,
    'list the files',
  )

  const byRole: Record<string, number> = {}
  for (const m of parsed.messages) byRole[m.role] = (byRole[m.role] ?? 0) + 1
  eq('one user row', byRole.user, 1)
  check(
    'assistant rows include thinking + final text',
    (byRole.assistant ?? 0) >= 2,
    `got ${byRole.assistant}`,
  )
  check('tool rows include call/result', (byRole.tool ?? 0) >= 1, `got ${byRole.tool}`)
  eq('step markers skipped', parsed.skipped['step-marker'], 2)
  eq(
    'user content',
    parsed.messages.find((m) => m.role === 'user')?.content,
    'list the files',
  )
  eq(
    'assistant text',
    parsed.messages.find((m) => m.eventId === 'prt_text1')?.content,
    'here they are',
  )
  eq(
    'dedup key is part.id',
    parsed.messages.every((m) => m.eventId.startsWith('prt_')),
    true,
  )
})

// =============================================================================
// In-memory stub ingest
// =============================================================================
console.log('\n— stub pool ingest —')
{
  type Conv = {
    id: string
    session_key: string
    agent: string
    channel: string
    title: string
    active: boolean
  }
  type Msg = {
    id: string
    conversation_id: string
    agent: string
    channel: string
    role: string
    content: string
    tool_name: string | null
    tool_result: string | null
    metadata: Record<string, unknown>
  }

  const convs: Conv[] = []
  const msgs: Msg[] = []
  let ids = 0
  let snapshot: { convs: number; msgs: number } | undefined

  const client: Queryable = {
    async query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (s === 'BEGIN') {
        snapshot = { convs: convs.length, msgs: msgs.length }
        return { rows: [], rowCount: 0 }
      }
      if (s === 'ROLLBACK' && snapshot) {
        convs.length = snapshot.convs
        msgs.length = snapshot.msgs
        snapshot = undefined
        return { rows: [], rowCount: 0 }
      }
      if (s === 'COMMIT') {
        snapshot = undefined
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith('SELECT pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith('SELECT id FROM ros_conversations')) {
        const row = convs.find((c) => c.session_key === params[0] && c.agent === params[1])
        return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
      }
      if (s.startsWith('INSERT INTO ros_conversations')) {
        const found = convs.find(
          (c) => c.session_key === String(params[0]) && c.agent === String(params[1]),
        )
        if (found) return { rows: [{ id: found.id, created: false }], rowCount: 1 }
        const row: Conv = {
          id: `conv-${String(++ids)}`,
          session_key: String(params[0]),
          agent: String(params[1]),
          channel: String(params[2]),
          title: String(params[3]),
          active: Boolean(params[5]),
        }
        convs.push(row)
        return { rows: [{ id: row.id, created: true }], rowCount: 1 }
      }
      if (s.startsWith("SELECT metadata->>'event_id'")) {
        const rows = msgs
          .filter((m) => m.conversation_id === params[0] && m.metadata.event_id)
          .map((m) => ({ e: String(m.metadata.event_id) }))
        return { rows, rowCount: rows.length }
      }
      if (s.startsWith('SELECT 1 FROM ros_messages')) {
        const hit = msgs.some(
          (m) => m.conversation_id === params[0] && m.metadata.event_id === params[1],
        )
        return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 }
      }
      if (s.startsWith('INSERT INTO ros_messages')) {
        const meta =
          typeof params[8] === 'string' ? (JSON.parse(params[8]) as Record<string, unknown>) : {}
        msgs.push({
          id: `msg-${String(++ids)}`,
          conversation_id: String(params[0]),
          agent: String(params[1]),
          channel: String(params[2]),
          role: String(params[3]),
          content: String(params[4]),
          tool_name: (params[5] as string | null) ?? null,
          tool_result: (params[7] as string | null) ?? null,
          metadata: meta,
        })
        return { rows: [], rowCount: 1 }
      }
      if (s.startsWith('UPDATE ros_conversations')) {
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected sql: ${s}`)
    },
  }

  await withFixture(async (dbFile) => {
    const stateFile = path.join(path.dirname(dbFile), 'opencode-capture-state.json')
    const state = createWatcherState(emptyState())
    const first = await scanOnce(dbFile, client, state, { backfillDays: 14, stateFile })
    check('first tick inserts rows', first.inserted >= 4, `inserted=${String(first.inserted)}`)
    eq('conversation session_key', convs[0]?.session_key, `opencode:${SESSION}`)
    eq('conversation agent', convs[0]?.agent, 'rivet-glm')
    eq('conversation channel', convs[0]?.channel, 'opencode')
    eq('conversation title', convs[0]?.title, 'list the files')

    const roles = new Set(msgs.map((m) => m.role))
    check('stored roles include user', roles.has('user'))
    check('stored roles include assistant', roles.has('assistant'))
    check('stored roles include tool', roles.has('tool'))
    check(
      'every stored row is agent=rivet-glm channel=opencode',
      msgs.every((m) => m.agent === 'rivet-glm' && m.channel === 'opencode'),
    )
    check(
      'every stored row carries event_id + sqlite pointer',
      msgs.every(
        (m) =>
          typeof m.metadata.event_id === 'string' &&
          String(m.metadata.event_id).startsWith('prt_') &&
          m.metadata.session_sqlite_path === dbFile &&
          typeof m.metadata.session_sqlite_part_id === 'string',
      ),
    )
    check('state file written', existsSync(stateFile))
    const persisted = loadState(stateFile)
    check('state high-water advanced', persisted.partTimeUpdated > 0)

    const before = msgs.length
    const second = await scanOnce(dbFile, client, state, { backfillDays: 14, stateFile })
    eq('second tick inserts nothing (dedup)', second.inserted, 0)
    eq('message count unchanged', msgs.length, before)
  })
}

// =============================================================================
// State cursor
// =============================================================================
console.log('\n— capture state —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-state-'))
  const file = path.join(dir, 'opencode-capture-state.json')
  try {
    const empty = loadState(file)
    eq('missing state is zeros', empty.partTimeUpdated, 0)
    saveState({ version: 1, partTimeUpdated: 42, messageTimeUpdated: 99 }, file)
    const loaded = loadState(file)
    eq('round-trip partTimeUpdated', loaded.partTimeUpdated, 42)
    eq('round-trip messageTimeUpdated', loaded.messageTimeUpdated, 99)
    writeFileSync(
      file,
      `${JSON.stringify({ version: 1, partTimeCreated: 7, messageTimeUpdated: 8 })}\n`,
    )
    eq('legacy partTimeCreated loads as partTimeUpdated', loadState(file).partTimeUpdated, 7)
    const next = advanceState(loaded, [
      {
        id: 'prt_z',
        message_id: 'msg_z',
        session_id: SESSION,
        time_created: 50,
        time_updated: 100,
        data: {},
        message_data: {},
        message_time_updated: 200,
        session_title: 't',
        session_directory: null,
      },
    ])
    eq('advance part high-water from time_updated', next.partTimeUpdated, 100)
    eq('advance message high-water', next.messageTimeUpdated, 200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// =============================================================================
// WAL wake-up path
// =============================================================================
console.log('\n— WAL wake-up path —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-wal-'))
  const dbFile = path.join(dir, 'opencode.db')
  const walFile = `${dbFile}-wal`
  writeFileSync(dbFile, '')
  writeFileSync(walFile, '')
  try {
    const paths = dbWatchPaths(dbFile)
    check('watch paths include the db', paths.includes(dbFile))
    check('watch paths include the wal', paths.includes(walFile))

    let wakes = 0
    const listeners: Array<() => void> = []
    const watched: string[] = []
    const fakeWatch: WatchFn = (filename, _opts, listener) => {
      watched.push(String(filename))
      listeners.push(() => listener('change', path.basename(String(filename))))
      return {
        close: () => undefined,
        on: () => undefined,
      } as unknown as ReturnType<WatchFn>
    }
    const handle = attachDbWatchers(
      dbFile,
      () => {
        wakes++
      },
      fakeWatch,
    )
    check(
      'wal path is watched',
      handle.watching.includes(walFile) || watched.includes(walFile),
    )
    check('db path is watched', handle.watching.includes(dbFile) || watched.includes(dbFile))
    for (const fire of listeners) fire()
    check('wal/db change wakes the watcher', wakes >= 1, `wakes=${String(wakes)}`)
    handle.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// =============================================================================
// watchTick boot race
// =============================================================================
console.log('\n— watchTick boot race —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-watch-'))
  const dbFile = path.join(dir, 'opencode.db')
  const state = createWatcherState()
  let released = 0
  const refused = Object.assign(new Error('connect ECONNREFUSED 192.0.2.1:5433'), {
    code: 'ECONNREFUSED',
  })

  await watchTick(
    {
      connect: async () => {
        throw refused
      },
    },
    dbFile,
    state,
  )
  eq('ECONNREFUSED first tick does not throw', released, 0)

  let connects = 0
  const recovering = {
    connect: async () => {
      connects++
      if (connects === 1) throw refused
      return {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {
          released++
        },
      }
    },
  }
  await watchTick(recovering, dbFile, state)
  eq('first recovering tick still refuses without release', released, 0)
  await watchTick(recovering, dbFile, state)
  eq('second tick acquires a client', connects, 2)
  eq('release runs only after successful connect', released, 1)

  rmSync(dir, { recursive: true, force: true })
}

function makeStub(): { client: Queryable; eventIds: () => string[] } {
  const convs: Array<{ id: string; session_key: string; agent: string }> = []
  const msgs: Array<{ conversation_id: string; metadata: Record<string, unknown> }> = []
  let ids = 0
  const client: Queryable = {
    async query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (
        s === 'BEGIN' ||
        s === 'COMMIT' ||
        s === 'ROLLBACK' ||
        s.startsWith('SELECT pg_advisory_xact_lock') ||
        s.startsWith('UPDATE ros_conversations')
      ) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith('INSERT INTO ros_conversations')) {
        const found = convs.find(
          (c) => c.session_key === String(params[0]) && c.agent === String(params[1]),
        )
        if (found) return { rows: [{ id: found.id, created: false }], rowCount: 1 }
        const row = {
          id: `conv-${String(++ids)}`,
          session_key: String(params[0]),
          agent: String(params[1]),
        }
        convs.push(row)
        return { rows: [{ id: row.id, created: true }], rowCount: 1 }
      }
      if (s.startsWith("SELECT metadata->>'event_id'")) {
        const rows = msgs
          .filter((m) => m.conversation_id === params[0] && m.metadata.event_id)
          .map((m) => ({ e: String(m.metadata.event_id) }))
        return { rows, rowCount: rows.length }
      }
      if (s.startsWith('SELECT 1 FROM ros_messages')) {
        const hit = msgs.some(
          (m) => m.conversation_id === params[0] && m.metadata.event_id === params[1],
        )
        return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 }
      }
      if (s.startsWith('INSERT INTO ros_messages')) {
        const meta =
          typeof params[8] === 'string' ? (JSON.parse(params[8]) as Record<string, unknown>) : {}
        msgs.push({ conversation_id: String(params[0]), metadata: meta })
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected sql: ${s}`)
    },
  }
  return {
    client,
    eventIds: () =>
      msgs.map((m) => String(m.metadata.event_id ?? '')).filter((id) => id.length > 0),
  }
}

async function withBlankDb(fn: (dbFile: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'opencode-cap-blank-'))
  const dbFile = path.join(dir, 'opencode.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, slug TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `)
  db.close()
  try {
    await fn(dbFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// =============================================================================
// Streaming text: skip until time.end, then capture
// =============================================================================
console.log('\n— streaming text waits for time.end —')
await withBlankDb(async (dbFile) => {
  const { DatabaseSync } = await import('node:sqlite')
  const now = Date.now()
  const db = new DatabaseSync(dbFile)
  db.prepare(
    `INSERT INTO session (id, title, directory, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(SESSION, 'stream', '/tmp', now, now)
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'msg_a',
    SESSION,
    now,
    now,
    JSON.stringify({ role: 'assistant', time: { created: now } }),
  )
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'prt_stream',
    'msg_a',
    SESSION,
    now,
    now,
    JSON.stringify({ type: 'text', text: 'hel' }),
  )
  db.close()

  const stub = makeStub()
  const stateFile = path.join(path.dirname(dbFile), 'state.json')
  const state = createWatcherState(emptyState())
  const first = await scanOnce(dbFile, stub.client, state, { backfillDays: 14, stateFile })
  eq('streaming part is not inserted', first.inserted, 0)
  check('streaming part id is not stored', !stub.eventIds().includes('prt_stream'))

  const db2 = new DatabaseSync(dbFile)
  db2.prepare(`UPDATE part SET data = ?, time_updated = ? WHERE id = ?`).run(
    JSON.stringify({ type: 'text', text: 'hello world', time: { start: now, end: now + 1 } }),
    now + 1,
    'prt_stream',
  )
  db2.prepare(`UPDATE message SET time_updated = ? WHERE id = ?`).run(now + 1, 'msg_a')
  db2.prepare(`UPDATE session SET time_updated = ? WHERE id = ?`).run(now + 1, SESSION)
  db2.close()

  const second = await scanOnce(dbFile, stub.client, state, { backfillDays: 14, stateFile })
  eq('finished part is inserted', second.inserted, 1)
  check('finished part id stored', stub.eventIds().includes('prt_stream'))
})

// =============================================================================
// Out-of-order part.time_updated within overlap
// =============================================================================
console.log('\n— out-of-order cursor overlap —')
await withBlankDb(async (dbFile) => {
  const { DatabaseSync } = await import('node:sqlite')
  const t = 1_800_000_000_000
  const db = new DatabaseSync(dbFile)
  db.prepare(
    `INSERT INTO session (id, title, directory, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(SESSION, 'ooo', '/tmp', t, t)
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  ).run('msg_u', SESSION, t, t, JSON.stringify({ role: 'user' }))
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'prt_first',
    'msg_u',
    SESSION,
    t,
    t,
    JSON.stringify({ type: 'text', text: 'first' }),
  )
  db.close()

  const stub = makeStub()
  const stateFile = path.join(path.dirname(dbFile), 'state.json')
  const state = createWatcherState(emptyState())
  const first = await scanOnce(dbFile, stub.client, state, { backfillDays: 14, stateFile })
  eq('first out-of-order tick inserts', first.inserted, 1)
  eq('cursor at first part time_updated', state.capture.partTimeUpdated, t)

  const lateStamp = t - 10_000
  const db2 = new DatabaseSync(dbFile)
  db2
    .prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'prt_late',
      'msg_u',
      SESSION,
      lateStamp,
      lateStamp,
      JSON.stringify({ type: 'text', text: 'late but in overlap' }),
    )
  db2.close()
  const second = await scanOnce(dbFile, stub.client, state, { backfillDays: 14, stateFile })
  eq('overlap window captures late row', second.inserted, 1)
  check('late part stored', stub.eventIds().includes('prt_late'))

  const tooOld = t - CURSOR_OVERLAP_MS - 5_000
  const db3 = new DatabaseSync(dbFile)
  db3
    .prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'prt_too_old',
      'msg_u',
      SESSION,
      tooOld,
      tooOld,
      JSON.stringify({ type: 'text', text: 'outside overlap' }),
    )
  db3.close()
  const third = await scanOnce(dbFile, stub.client, state, { backfillDays: 14, stateFile })
  eq('row older than overlap is skipped', third.inserted, 0)
  check('too-old part not stored', !stub.eventIds().includes('prt_too_old'))
})

// =============================================================================
// --backfill 0 = no history
// =============================================================================
console.log('\n— backfill 0 skips history —')
await withBlankDb(async (dbFile) => {
  const { DatabaseSync } = await import('node:sqlite')
  const now = Date.now()
  const old = now - 86_400_000
  const db = new DatabaseSync(dbFile)
  db.prepare(
    `INSERT INTO session (id, title, directory, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(SESSION, 'old', '/tmp', old, old)
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  ).run('msg_old', SESSION, old, old, JSON.stringify({ role: 'user' }))
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'prt_old',
    'msg_old',
    SESSION,
    old,
    old,
    JSON.stringify({ type: 'text', text: 'yesterday' }),
  )
  db.close()

  const stub = makeStub()
  const stateFile = path.join(path.dirname(dbFile), 'state.json')
  const state = createWatcherState(emptyState())
  const first = await scanOnce(dbFile, stub.client, state, { backfillDays: 0, stateFile })
  eq('backfill 0 first pass inserts nothing', first.inserted, 0)
  check('backfill 0 first pass seeds cursor', state.capture.partTimeUpdated >= now - 1000)
  eq('cutoff applied only once', state.initialPassDone, true)

  const second = await scanOnce(dbFile, stub.client, state, { backfillDays: 0, stateFile })
  eq('second pass does not dump pre-start history', second.inserted, 0)
  check('old part stays uncaptured', !stub.eventIds().includes('prt_old'))
})

// =============================================================================
// Widening --backfill catches history already behind the saved cursor
// =============================================================================
console.log('\n— widening --backfill catches history behind the cursor —')
await withBlankDb(async (dbFile) => {
  const { DatabaseSync } = await import('node:sqlite')
  const now = Date.now()
  const old = now - 30 * 24 * 60 * 60 * 1000
  const db = new DatabaseSync(dbFile)
  db.prepare(
    `INSERT INTO session (id, title, directory, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(SESSION, 'old-session', '/tmp', old, old)
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  ).run('msg_old30', SESSION, old, old, JSON.stringify({ role: 'user' }))
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'prt_old30',
    'msg_old30',
    SESSION,
    old,
    old,
    JSON.stringify({ type: 'text', text: 'thirty days ago' }),
  )
  db.close()

  const stub = makeStub()
  const stateFile = path.join(path.dirname(dbFile), 'state.json')
  const firstState = createWatcherState(emptyState())
  const first = await scanOnce(dbFile, stub.client, firstState, { backfillDays: 14, stateFile })
  eq('14-day window misses 30-day-old session', first.inserted, 0)
  check('14-day window does not store old part', !stub.eventIds().includes('prt_old30'))

  const secondState = createWatcherState(loadState(stateFile))
  const second = await scanOnce(dbFile, stub.client, secondState, { backfillDays: 90, stateFile })
  eq('90-day backfill catches the 30-day-old part', second.inserted, 1)
  check('old part stored after wider backfill', stub.eventIds().includes('prt_old30'))

  const third = await scanOnce(dbFile, stub.client, secondState, { backfillDays: 90, stateFile })
  eq('after catch-up, incremental tick inserts nothing', third.inserted, 0)
})

// =============================================================================
// Coalesced ticks
// =============================================================================
console.log('\n— coalesced ticks —')
{
  const releases: Array<() => void> = []
  let runs = 0
  const kick = createCoalescedRunner(
    () =>
      new Promise<void>((resolve) => {
        runs++
        releases.push(resolve)
      }),
  )
  kick()
  kick()
  kick()
  eq('burst starts one in-flight run', runs, 1)
  releases[0]?.()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  eq('dirty bit queues exactly one rescan', runs, 2)
  releases[1]?.()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  eq('drain does not start a third run', runs, 2)
}

if (failed > 0) {
  console.error(`\n${String(failed)} test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll OpenCode Memory Capture tests passed.')
}
