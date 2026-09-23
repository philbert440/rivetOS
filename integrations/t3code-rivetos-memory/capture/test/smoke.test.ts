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
  check('long text with pointer truncated', capped.truncated && capped.stored.endsWith('…[truncated]'))
  const uncapped = capForStorage(big, { dbPath: null, rowId: null })
  check('long text without pointer stays full', uncapped.uncapped === true && uncapped.stored.length === big.length)
}

{
  const tool = extractToolFromActivity(
    {
      itemType: 'mcp_tool_call',
      title: 'mcp_tool_call',
      data: { toolName: 'mcp__rivetos__memory_search', input: { query: 'auth' }, result: { content: 'hit' } },
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
  db.prepare(
    `INSERT INTO projection_threads VALUES (?,?,?,?,?,?,?,NULL)`,
  ).run(THREAD, 'proj-1', 'Wire capture', 'claude', '/tmp/demo', '2026-09-22T10:00:00.000Z', '2026-09-22T10:05:00.000Z')
  db.prepare(
    `INSERT INTO projection_turns VALUES (?,?,?,?,?)`,
  ).run(THREAD, TURN, 'completed', '2026-09-22T10:01:00.000Z', '2026-09-22T10:04:00.000Z')
  db.prepare(
    `INSERT INTO projection_thread_sessions VALUES (?,?,?,?,?)`,
  ).run(THREAD, 'ready', 'claudeAgent', null, '2026-09-22T10:04:30.000Z')
  db.prepare(
    `INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`,
  ).run('msg-user', THREAD, TURN, 'user', 'remember the auth rule', 0, '2026-09-22T10:01:01.000Z', '2026-09-22T10:01:01.000Z')
  db.prepare(
    `INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`,
  ).run('msg-stream', THREAD, TURN, 'assistant', 'partial', 1, '2026-09-22T10:02:00.000Z', '2026-09-22T10:02:00.000Z')
  db.prepare(
    `INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    'msg-asst',
    THREAD,
    TURN,
    'assistant',
    'we keep authorship as rivetphilbot',
    0,
    '2026-09-22T10:03:00.000Z',
    '2026-09-22T10:03:00.000Z',
  )
  db.prepare(
    `INSERT INTO projection_thread_activities VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
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
    check('messages table has is_streaming', schema.columns.projection_thread_messages.includes('is_streaming'))
    const ids = listEligibleThreadIds(db, schema, emptyState(), { ignoreCursor: true })
    check('completed idle thread is eligible', ids.includes(THREAD))
    const folded = foldCompletedThread(db, schema, THREAD, emptyCursor(), dbFile, { ignoreCursor: true })
    const roles = folded.messages.map((m) => m.role).sort()
    check('folds user+assistant+tool', roles.join(',') === 'assistant,tool,user')
    check('skips streaming assistant', !folded.messages.some((m) => m.eventId === 'msg-stream'))
    check('user event id is message_id', folded.messages.some((m) => m.eventId === 'msg-user'))
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
      check('schema-churn reports missing required tables', !probe.ok && probe.missing.includes('projection_turns'))
      opened.close()
    }
    const client = stubClient()
    const result = await scanOnce(dbFile, client, createWatcherState(), { ignoreCursor: true })
    check('churn skip does not insert', result.inserted === 0 && (result.schemaChurn?.length ?? 0) > 0)
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
    db.prepare(`UPDATE projection_thread_sessions SET status = 'running' WHERE thread_id = ?`).run(THREAD)
    db.close()
    const opened = openT3Db(dbFile)!
    const ids = listEligibleThreadIds(opened, probeSchema(opened), emptyState(), { ignoreCursor: true })
    check('running incomplete turn is not eligible', !ids.includes(THREAD))
    opened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const file = path.join(mkdtempSync(path.join(tmpdir(), 't3code-st-')), 'state.json')
  const state = emptyState()
  state.threads[THREAD] = { ...emptyCursor(), lastMessageId: 'msg-user', lastMessageUpdatedAt: '2026-09-22T10:01:01.000Z' }
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
    check('cli --help prints usage', helpLogs.some((l) => l.includes('--watch')))
    const statusLogs = capture()
    await main(['--status'])
    console.log = orig
    check('cli --status does not need PG', statusLogs.some((l) => l.includes('lastIngestAt: never')))
  } finally {
    console.log = orig
    if (prevState === undefined) delete process.env.RIVETOS_T3CODE_STATE
    else process.env.RIVETOS_T3CODE_STATE = prevState
    rmSync(dir, { recursive: true, force: true })
  }
}

if (failed > 0) {
  console.error(`\n${String(failed)} failed`)
  process.exit(1)
}
console.log('\nok')
