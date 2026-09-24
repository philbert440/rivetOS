/**
 * T3 Code capture tests. No live Postgres — a stub Queryable records inserts.
 * Fixture SQLite uses the projection tables from T3 migration 005.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BUSY_TIMEOUT_MS,
  CAPTURE_CHANNEL,
  DEFAULT_CAPTURE_AGENT,
  MAX_CONTENT,
  canonicalMessageRole,
  capForStorage,
  createWatcherState,
  deriveSessionKey,
  emptyCursor,
  emptyState,
  extractToolFromActivity,
  foldCompletedThread,
  formatStatus,
  ingestMessages,
  insertMessage,
  main,
  isIdleSessionStatus,
  isToolActivity,
  listEligibleThreadIds,
  loadState,
  openT3Db,
  parseBackfill,
  parsePollMs,
  probeSchema,
  saveState,
  scanOnce,
  unknownRoleSkipCount,
  type Queryable,
} from '../src/t3code-memory-capture.ts'

const THREAD = 'thread-aaa-111'
const TURN = 'turn-bbb-222'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.error(`✗ ${name}${detail ? `: ${detail}` : ''}`)
    failed++
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

console.log('Running T3 Code memory capture tests...\n')

eq('agent is rivet-t3', DEFAULT_CAPTURE_AGENT, 'rivet-t3')
eq('channel is t3code', CAPTURE_CHANNEL, 't3code')
eq('session key prefixes t3code:', deriveSessionKey(THREAD), `t3code:${THREAD}`)
eq('busy_timeout matches T3 (5s)', BUSY_TIMEOUT_MS, 5000)
check('idle ready', isIdleSessionStatus('ready'))
check('idle stopped', isIdleSessionStatus('stopped'))
check('running is not idle', !isIdleSessionStatus('running'))
check('tool tone', isToolActivity('tool', 'info'))
check('tool.completed kind', isToolActivity('info', 'tool.completed'))
check('approval is not a tool', !isToolActivity('approval', 'approval.requested'))
eq('parse backfill default', parseBackfill([]), 14)
eq('parse --days 7', parseBackfill(['--backfill', '--days', '7']), 7)
eq('parse poll default', parsePollMs([]), 2500)

{
  const small = capForStorage('hello', { dbPath: '/x.sqlite', rowId: 'm1' })
  eq('short text not truncated', small.truncated, false)
  const big = 'x'.repeat(MAX_CONTENT + 20)
  const capped = capForStorage(big, { dbPath: '/x.sqlite', rowId: 'm1' })
  check(
    'long text with pointer truncated',
    capped.truncated && capped.stored.endsWith('…[truncated]'),
  )
  const uncapped = capForStorage(big, { dbPath: null, rowId: null })
  check(
    'long text without pointer stays full',
    uncapped.uncapped === true && uncapped.stored.length === big.length,
  )
}

{
  const tool = extractToolFromActivity(
    {
      itemType: 'mcp_tool_call',
      title: 'mcp_tool_call',
      data: {
        toolName: 'mcp__rivetos__memory_search',
        input: { query: 'auth' },
        result: { content: 'hit' },
      },
    },
    'tool.completed',
    'Completed mcp_tool_call',
  )
  eq('extracts Claude-shaped MCP tool name', tool.toolName, 'mcp__rivetos__memory_search')
  check('extracts input args', isRecord(tool.toolArgs) && tool.toolArgs.query === 'auth')
}

check('status empty says never', formatStatus(emptyState()).includes('lastIngestAt: never'))

function stubClient(): Queryable & { sql: string[]; eventIds: () => string[] } {
  const sql: string[] = []
  const ids = new Set<string>()
  let conv = 0
  return {
    sql,
    eventIds: () => [...ids],
    async query(q: string, params?: unknown[]) {
      sql.push(q)
      if (/INSERT INTO ros_conversations/.test(q)) {
        conv++
        return { rows: [{ id: `conv-${String(conv)}`, created: true }], rowCount: 1 }
      }
      if (/SELECT metadata->>'event_id'/.test(q)) {
        return { rows: [...ids].map((e) => ({ e })), rowCount: ids.size }
      }
      if (/SELECT 1 FROM ros_messages/.test(q)) {
        const eventId = typeof params?.[1] === 'string' ? params[1] : ''
        const hit = ids.has(eventId)
        return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 }
      }
      if (/INSERT INTO ros_messages/.test(q)) {
        const meta = typeof params?.[8] === 'string' ? JSON.parse(params[8]) : {}
        if (typeof meta.event_id === 'string') ids.add(meta.event_id)
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
}

async function makeFixture(): Promise<{ dir: string; dbFile: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 't3code-cap-'))
  const dbFile = path.join(dir, 'state.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, model TEXT,
      worktree_path TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, role TEXT, text TEXT,
      is_streaming INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, tone TEXT, kind TEXT,
      summary TEXT, payload_json TEXT, created_at TEXT
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY, status TEXT, provider_name TEXT, active_turn_id TEXT, updated_at TEXT
    );
    CREATE TABLE projection_turns (
      thread_id TEXT, turn_id TEXT, state TEXT, requested_at TEXT, completed_at TEXT
    );
  `)
  db.prepare(
    `INSERT INTO projection_projects VALUES ('proj-1','Demo','/tmp/demo','2026-09-22T10:00:00.000Z','2026-09-22T10:00:00.000Z')`,
  ).run()
  db.prepare(`INSERT INTO projection_threads VALUES (?,?,?,?,?,?,?,NULL)`).run(
    THREAD,
    'proj-1',
    'Wire capture',
    'claude',
    '/tmp/demo',
    '2026-09-22T10:00:00.000Z',
    '2026-09-22T10:05:00.000Z',
  )
  db.prepare(`INSERT INTO projection_turns VALUES (?,?,?,?,?)`).run(
    THREAD,
    TURN,
    'completed',
    '2026-09-22T10:01:00.000Z',
    '2026-09-22T10:04:00.000Z',
  )
  db.prepare(`INSERT INTO projection_thread_sessions VALUES (?,?,?,?,?)`).run(
    THREAD,
    'ready',
    'claudeAgent',
    null,
    '2026-09-22T10:04:30.000Z',
  )
  db.prepare(`INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`).run(
    'msg-user',
    THREAD,
    TURN,
    'user',
    'remember the auth rule',
    0,
    '2026-09-22T10:01:01.000Z',
    '2026-09-22T10:01:01.000Z',
  )
  db.prepare(`INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`).run(
    'msg-stream',
    THREAD,
    TURN,
    'assistant',
    'partial',
    1,
    '2026-09-22T10:02:00.000Z',
    '2026-09-22T10:02:00.000Z',
  )
  db.prepare(`INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`).run(
    'msg-asst',
    THREAD,
    TURN,
    'assistant',
    'we keep authorship as rivetphilbot',
    0,
    '2026-09-22T10:03:00.000Z',
    '2026-09-22T10:03:00.000Z',
  )
  db.prepare(`INSERT INTO projection_thread_activities VALUES (?,?,?,?,?,?,?,?)`).run(
    'act-tool',
    THREAD,
    TURN,
    'tool',
    'tool.completed',
    'Completed bash',
    JSON.stringify({
      itemType: 'command_execution',
      data: { item: { command: ['git', 'status'], result: 'clean' } },
    }),
    '2026-09-22T10:02:30.000Z',
  )
  db.close()
  return { dir, dbFile }
}

{
  const { dir, dbFile } = await makeFixture()
  try {
    const db = openT3Db(dbFile)
    check('opens fixture read-only', Boolean(db))
    if (!db) throw new Error('no db')
    const schema = probeSchema(db)
    check('required tables present', schema.ok)
    check(
      'messages table has is_streaming',
      schema.columns.projection_thread_messages.includes('is_streaming'),
    )
    const ids = listEligibleThreadIds(db, schema, emptyState(), { ignoreCursor: true })
    check('completed idle thread is eligible', ids.includes(THREAD))
    const folded = foldCompletedThread(db, schema, THREAD, emptyCursor(), dbFile, {
      ignoreCursor: true,
    })
    const roles = folded.messages.map((m) => m.role).sort()
    check('folds user+assistant+tool', roles.join(',') === 'assistant,tool,user')
    check('skips streaming assistant', !folded.messages.some((m) => m.eventId === 'msg-stream'))
    check(
      'user event id is message_id',
      folded.messages.some((m) => m.eventId === 'msg-user'),
    )
    const tool = folded.messages.find((m) => m.role === 'tool')
    eq('tool name from activity payload', tool?.toolName, 'command_execution')
    check('tool result from activity', String(tool?.toolResult).includes('clean'))
    eq('provider from session', folded.provider, 'claudeAgent')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { dir, dbFile } = await makeFixture()
  const stateFile = path.join(dir, 't3code-capture-state.json')
  try {
    const client = stubClient()
    const state = createWatcherState(emptyState())
    const first = await scanOnce(dbFile, client, state, {
      stateFile,
      source: 'test',
      ignoreCursor: true,
    })
    check('first scan inserts 3 rows', first.inserted === 3, `inserted=${String(first.inserted)}`)
    const ids = client.eventIds().sort()
    check('stored user+asst+tool ids', ids.join(',') === 'act-tool,msg-asst,msg-user')
    const persisted = loadState(stateFile)
    check('state has thread cursor', Boolean(persisted.threads[THREAD]?.lastMessageId))
    eq('state last message id', persisted.threads[THREAD]?.lastMessageId, 'msg-asst')

    const second = await scanOnce(dbFile, client, createWatcherState(loadState(stateFile)), {
      stateFile,
      source: 'test',
    })
    eq('second scan inserts nothing', second.inserted, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const client = stubClient()
  const msg = {
    role: 'user',
    content: 'hi',
    eventId: 'msg-dup',
    extra: { session_sqlite_path: '/tmp/x.sqlite', session_sqlite_message_id: 'msg-dup' },
  }
  eq('first insert', await insertMessage(client, 'c1', msg, '/tmp/x.sqlite'), 'inserted')
  eq('dedup by event_id', await insertMessage(client, 'c1', msg, '/tmp/x.sqlite'), 'skipped')
}

{
  const dir = mkdtempSync(path.join(tmpdir(), 't3code-churn-'))
  const dbFile = path.join(dir, 'state.sqlite')
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbFile)
    db.exec(`CREATE TABLE unrelated (id TEXT)`)
    db.close()
    const opened = openT3Db(dbFile)
    check('opens unknown schema', Boolean(opened))
    if (opened) {
      const probe = probeSchema(opened)
      check(
        'schema-churn reports missing required tables',
        !probe.ok && probe.missing.includes('projection_turns'),
      )
      opened.close()
    }
    const client = stubClient()
    const result = await scanOnce(dbFile, client, createWatcherState(), { ignoreCursor: true })
    check(
      'churn skip does not insert',
      result.inserted === 0 && (result.schemaChurn?.length ?? 0) > 0,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { dir, dbFile } = await makeFixture()
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbFile)
    db.prepare(`UPDATE projection_turns SET completed_at = NULL WHERE turn_id = ?`).run(TURN)
    db.prepare(`UPDATE projection_thread_sessions SET status = 'running' WHERE thread_id = ?`).run(
      THREAD,
    )
    db.close()
    const opened = openT3Db(dbFile)!
    const ids = listEligibleThreadIds(opened, probeSchema(opened), emptyState(), {
      ignoreCursor: true,
    })
    check('running incomplete turn is not eligible', !ids.includes(THREAD))
    opened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const file = path.join(mkdtempSync(path.join(tmpdir(), 't3code-st-')), 'state.json')
  const state = emptyState()
  state.threads[THREAD] = {
    ...emptyCursor(),
    lastMessageId: 'msg-user',
    lastMessageUpdatedAt: '2026-09-22T10:01:01.000Z',
  }
  saveState(state, file)
  const loaded = loadState(file)
  eq('persisted cursor message id', loaded.threads[THREAD]?.lastMessageId, 'msg-user')
  rmSync(path.dirname(file), { recursive: true, force: true })
}

{
  const client = stubClient()
  const result = await ingestMessages(
    client,
    THREAD,
    [{ role: 'user', content: 'x', eventId: 'm1', extra: { session_sqlite_message_id: 'm1' } }],
    { title: 't', dbPath: '/tmp/state.sqlite', lock: false },
  )
  eq('ingest session key', result.sessionKey, `t3code:${THREAD}`)
  eq('ingest inserted 1', result.inserted, 1)
}

{
  const dir = mkdtempSync(path.join(tmpdir(), 't3code-cli-'))
  const prevState = process.env.RIVETOS_T3CODE_STATE
  process.env.RIVETOS_T3CODE_STATE = path.join(dir, 't3code-capture-state.json')
  const orig = console.log
  const capture = (): string[] => {
    const logs: string[] = []
    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ''))
    }
    return logs
  }
  try {
    const helpLogs = capture()
    await main(['--help'])
    console.log = orig
    check(
      'cli --help prints usage',
      helpLogs.some((l) => l.includes('--watch')),
    )
    const statusLogs = capture()
    await main(['--status'])
    console.log = orig
    check(
      'cli --status does not need PG',
      statusLogs.some((l) => l.includes('lastIngestAt: never')),
    )
  } finally {
    console.log = orig
    if (prevState === undefined) delete process.env.RIVETOS_T3CODE_STATE
    else process.env.RIVETOS_T3CODE_STATE = prevState
    rmSync(dir, { recursive: true, force: true })
  }
}

function missClient(): Queryable & { inserts: string[] } {
  const inserts: string[] = []
  let conv = 0
  return {
    inserts,
    async query(q: string, params?: unknown[]) {
      if (/INSERT INTO ros_conversations/.test(q)) {
        conv++
        return { rows: [{ id: `miss-conv-${String(conv)}`, created: true }], rowCount: 1 }
      }
      if (/SELECT metadata->>'event_id'/.test(q) || /SELECT 1 FROM ros_messages/.test(q)) {
        return { rows: [], rowCount: 0 }
      }
      if (/INSERT INTO ros_messages/.test(q)) {
        const meta =
          typeof params?.[8] === 'string' ? (JSON.parse(params[8]) as Record<string, unknown>) : {}
        if (typeof meta.event_id === 'string') inserts.push(meta.event_id)
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
}

function captureClient(): Queryable & {
  rows: Array<{
    role: unknown
    content: unknown
    toolArgs: unknown
    toolResult: unknown
    metadata: Record<string, unknown>
  }>
} {
  const rows: Array<{
    role: unknown
    content: unknown
    toolArgs: unknown
    toolResult: unknown
    metadata: Record<string, unknown>
  }> = []
  return {
    rows,
    async query(q: string, params?: unknown[]) {
      if (/SELECT metadata->>'event_id'/.test(q) || /SELECT 1 FROM ros_messages/.test(q)) {
        return { rows: [], rowCount: 0 }
      }
      if (/INSERT INTO ros_messages/.test(q)) {
        const meta =
          typeof params?.[8] === 'string' ? (JSON.parse(params[8]) as Record<string, unknown>) : {}
        rows.push({
          role: params?.[3],
          content: params?.[4],
          toolArgs: params?.[6],
          toolResult: params?.[7],
          metadata: meta,
        })
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
}

{
  const { dir, dbFile } = await makeFixture()
  const stateFile = path.join(dir, 't3code-capture-state.json')
  try {
    const firstClient = missClient()
    const first = await scanOnce(dbFile, firstClient, createWatcherState(emptyState()), {
      stateFile,
      source: 'test',
      ignoreCursor: true,
    })
    eq('fresh-client setup inserted', first.inserted, 3)
    const secondClient = missClient()
    const second = await scanOnce(dbFile, secondClient, createWatcherState(loadState(stateFile)), {
      stateFile,
      source: 'test',
    })
    eq('second scan with a fresh client inserts nothing', second.inserted, 0)
    eq('fresh client event lookup never hits', secondClient.inserts.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const client = captureClient()
  const content = `c${'x'.repeat(MAX_CONTENT + 40)}`
  const bigStr = `s${'y'.repeat(MAX_CONTENT + 80)}`
  const bigResult = `r${'q'.repeat(MAX_CONTENT + 10)}`
  const bigObj = { blob: `o${'z'.repeat(MAX_CONTENT + 80)}` }
  eq(
    'long string tool args inserted',
    await insertMessage(
      client,
      'c-args',
      {
        role: 'tool',
        content,
        toolName: 'bash',
        toolArgs: bigStr,
        toolResult: bigResult,
        eventId: 'args-string',
        extra: {
          session_sqlite_message_id: 'args-string',
          session_sqlite_path: '/tmp/state.sqlite',
        },
      },
      '/tmp/state.sqlite',
    ),
    'inserted',
  )
  eq(
    'long object tool args inserted',
    await insertMessage(
      client,
      'c-args',
      {
        role: 'tool',
        content,
        toolName: 'bash',
        toolArgs: bigObj,
        eventId: 'args-object',
        extra: { session_sqlite_activity_id: 'args-object' },
      },
      '/tmp/state.sqlite',
    ),
    'inserted',
  )
  const stringRow = client.rows[0]
  const objectRow = client.rows[1]
  const parsedStr = JSON.parse(String(stringRow?.toolArgs)) as unknown
  const parsedObj = JSON.parse(String(objectRow?.toolArgs)) as { blob?: string }
  eq('string tool_args parses back to the full string', parsedStr, bigStr)
  eq('object tool_args keeps the full blob', parsedObj.blob, bigObj.blob)
  eq('string-args content stored full', stringRow?.content, content)
  eq('object-args content stored full', objectRow?.content, content)
  eq('over-cap content marked uncapped', stringRow?.metadata.uncapped, true)
  eq('provenance message id kept', stringRow?.metadata.session_sqlite_message_id, 'args-string')
  eq('provenance activity id kept', objectRow?.metadata.session_sqlite_activity_id, 'args-object')
  eq('tool result stored full', stringRow?.toolResult, bigResult)
}

{
  const { dir, dbFile } = await makeFixture()
  const stateFile = path.join(dir, 't3code-capture-state.json')
  const BAD = 'thread-bad'
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbFile)
    db.prepare(`INSERT INTO projection_threads VALUES (?,?,?,?,?,?,?,NULL)`).run(
      BAD,
      'proj-1',
      'Bad thread',
      'claude',
      '/tmp/demo',
      '2026-09-22T08:00:00.000Z',
      '2026-09-22T09:00:00.000Z',
    )
    db.prepare(`INSERT INTO projection_turns VALUES (?,?,?,?,?)`).run(
      BAD,
      'turn-bad',
      'completed',
      '2026-09-22T08:00:00.000Z',
      '2026-09-22T09:00:00.000Z',
    )
    db.prepare(`INSERT INTO projection_thread_sessions VALUES (?,?,?,?,?)`).run(
      BAD,
      'ready',
      'claudeAgent',
      null,
      '2026-09-22T09:00:00.000Z',
    )
    db.prepare(`INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`).run(
      'bad-msg',
      BAD,
      'turn-bad',
      'user',
      'this insert throws',
      0,
      '2026-09-22T08:30:00.000Z',
      '2026-09-22T08:30:00.000Z',
    )
    db.close()
    const client = stubClient()
    const orig = client.query.bind(client)
    client.query = async (q: string, params?: unknown[]) => {
      if (/INSERT INTO ros_messages/.test(q)) {
        const meta =
          typeof params?.[8] === 'string' ? (JSON.parse(params[8]) as Record<string, unknown>) : {}
        if (meta.event_id === 'bad-msg') throw new Error('insert boom')
      }
      return orig(q, params)
    }
    const result = await scanOnce(dbFile, client, createWatcherState(emptyState()), {
      stateFile,
      source: 'test',
      ignoreCursor: true,
    })
    eq('failing thread does not stop the next', result.inserted, 3)
    const persisted = loadState(stateFile)
    eq('good thread cursor persisted', persisted.threads[THREAD]?.lastMessageId, 'msg-asst')
    check('failed thread cursor was not saved', persisted.threads[BAD] === undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

async function emptyProjection(): Promise<{ dir: string; dbFile: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 't3code-win-'))
  const dbFile = path.join(dir, 'state.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile)
  db.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, model TEXT,
      worktree_path TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, role TEXT, text TEXT,
      is_streaming INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, tone TEXT, kind TEXT,
      summary TEXT, payload_json TEXT, created_at TEXT
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY, status TEXT, provider_name TEXT, active_turn_id TEXT, updated_at TEXT
    );
    CREATE TABLE projection_turns (
      thread_id TEXT, turn_id TEXT, state TEXT, requested_at TEXT, completed_at TEXT
    );
  `)
  const now = daysAgo(0)
  db.prepare(`INSERT INTO projection_projects VALUES ('proj-1','Demo','/tmp/demo',?,?)`).run(
    now,
    now,
  )
  db.close()
  return { dir, dbFile }
}

{
  const { dir, dbFile } = await emptyProjection()
  const stateFile = path.join(dir, 'state.json')
  const old = daysAgo(40)
  const recent = daysAgo(0)
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbFile)
    db.prepare(`INSERT INTO projection_threads VALUES (?,?,?,?,?,?,?,NULL)`).run(
      'thread-win',
      'proj-1',
      'Window',
      'claude',
      '/tmp/demo',
      old,
      recent,
    )
    db.prepare(`INSERT INTO projection_turns VALUES (?,?,?,?,?)`).run(
      'thread-win',
      'turn-win',
      'completed',
      recent,
      recent,
    )
    db.prepare(`INSERT INTO projection_thread_sessions VALUES (?,?,?,?,?)`).run(
      'thread-win',
      'ready',
      'claudeAgent',
      null,
      recent,
    )
    db.prepare(`INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`).run(
      'msg-old',
      'thread-win',
      'turn-win',
      'user',
      'ancient',
      0,
      old,
      old,
    )
    db.prepare(`INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`).run(
      'msg-new',
      'thread-win',
      'turn-win',
      'assistant',
      'fresh',
      0,
      recent,
      recent,
    )
    db.prepare(`INSERT INTO projection_thread_activities VALUES (?,?,?,?,?,?,?,?)`).run(
      'act-old',
      'thread-win',
      'turn-win',
      'tool',
      'tool.completed',
      'old tool',
      JSON.stringify({ data: { command: 'old' } }),
      old,
    )
    db.prepare(`INSERT INTO projection_thread_activities VALUES (?,?,?,?,?,?,?,?)`).run(
      'act-new',
      'thread-win',
      'turn-win',
      'tool',
      'tool.completed',
      'new tool',
      JSON.stringify({ data: { command: 'new' } }),
      recent,
    )
    db.close()
    const client = missClient()
    const result = await scanOnce(dbFile, client, createWatcherState(emptyState()), {
      stateFile,
      source: 'backfill',
      backfillDays: 14,
    })
    check(
      '--days excludes old messages inside an eligible thread',
      client.inserts.includes('msg-new') &&
        client.inserts.includes('act-new') &&
        !client.inserts.includes('msg-old') &&
        !client.inserts.includes('act-old'),
      `inserted=${client.inserts.join(',')} count=${String(result.inserted)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const { dir, dbFile } = await emptyProjection()
  const stateFile = path.join(dir, 'state.json')
  const old = daysAgo(40)
  const recent = daysAgo(1)
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbFile)
    db.prepare(`INSERT INTO projection_threads VALUES (?,?,?,?,?,?,?,NULL)`).run(
      'thread-recent',
      'proj-1',
      'Recent',
      'claude',
      '/tmp/demo',
      recent,
      recent,
    )
    db.prepare(`INSERT INTO projection_turns VALUES (?,?,?,?,?)`).run(
      'thread-recent',
      'turn-recent',
      'completed',
      recent,
      recent,
    )
    db.prepare(`INSERT INTO projection_thread_sessions VALUES (?,?,?,?,?)`).run(
      'thread-recent',
      'ready',
      'claudeAgent',
      null,
      recent,
    )
    db.prepare(`INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`).run(
      'recent-old-msg',
      'thread-recent',
      'turn-recent',
      'user',
      'too old',
      0,
      old,
      old,
    )
    db.prepare(`INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`).run(
      'recent-new-msg',
      'thread-recent',
      'turn-recent',
      'assistant',
      'in window',
      0,
      recent,
      recent,
    )
    db.prepare(`INSERT INTO projection_threads VALUES (?,?,?,?,?,?,?,NULL)`).run(
      'thread-stale',
      'proj-1',
      'Stale',
      'claude',
      '/tmp/demo',
      old,
      old,
    )
    db.prepare(`INSERT INTO projection_turns VALUES (?,?,?,?,?)`).run(
      'thread-stale',
      'turn-stale',
      'completed',
      old,
      old,
    )
    db.prepare(`INSERT INTO projection_thread_sessions VALUES (?,?,?,?,?)`).run(
      'thread-stale',
      'ready',
      'claudeAgent',
      null,
      old,
    )
    db.prepare(`INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`).run(
      'stale-but-recent-text',
      'thread-stale',
      'turn-stale',
      'user',
      'session is old',
      0,
      recent,
      recent,
    )
    db.close()
    const firstClient = missClient()
    const first = await scanOnce(dbFile, firstClient, createWatcherState(emptyState()), {
      stateFile,
      source: 'watch',
    })
    check(
      'first watch pass keeps the window',
      firstClient.inserts.includes('recent-new-msg') &&
        !firstClient.inserts.includes('recent-old-msg') &&
        !firstClient.inserts.includes('stale-but-recent-text'),
      `inserted=${firstClient.inserts.join(',')} count=${String(first.inserted)}`,
    )
    const seeded = loadState(stateFile)
    check('first watch pass seeds the cursor floor', Boolean(seeded.historyNotBefore))
    const secondClient = missClient()
    const second = await scanOnce(dbFile, secondClient, createWatcherState(loadState(stateFile)), {
      stateFile,
      source: 'watch',
    })
    eq('seeded watch does not dump pre-start history', second.inserted, 0)
    eq('fresh client saw no second-pass inserts', secondClient.inserts.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  eq('canonical user', canonicalMessageRole('User'), 'user')
  eq('canonical tool', canonicalMessageRole('tool'), 'tool')
  eq('unknown role is null', canonicalMessageRole('narrator'), null)
  const before = unknownRoleSkipCount()
  const client = captureClient()
  eq(
    'unknown role skipped',
    await insertMessage(
      client,
      'c-role',
      { role: 'narrator', content: 'nope', eventId: 'role-bad' },
      null,
    ),
    'skipped',
  )
  eq('unknown role counted', unknownRoleSkipCount(), before + 1)
  eq('unknown role wrote no row', client.rows.length, 0)
  eq(
    'mapped role inserted',
    await insertMessage(
      client,
      'c-role',
      { role: 'Assistant', content: 'yes', eventId: 'role-ok' },
      null,
    ),
    'inserted',
  )
  eq('stored role is assistant', client.rows[0]?.role, 'assistant')
}

if (failed > 0) {
  console.error(`\n${String(failed)} failed`)
  process.exit(1)
}
console.log('\nok')
