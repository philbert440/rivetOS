/**
 * Smoke + unit tests for pi-memory-capture.
 *
 * Layers:
 *   1. Pure parser against a synthetic v3 session fixture (den-adapter shape).
 *      No DB required — user + assistant + tool, runtime events skipped.
 *   2. Identity: session_key, event ids (pi:<uuid>:<lineId> vs line fallback).
 *   3. In-memory stub pool — a session lands as user+assistant+tool
 *      with truncation pointers. Stands in for sqlite/pg-lite; this package
 *      does not add deps beyond kimi's (pg).
 *   4. File-cursor tailing (incomplete last line stays pending).
 *   5. Backfill scan over a temp cwd-bucket tree + a flat --session-dir.
 *   6. Fold-parity against den-server `piTurnsFromLines`. Import failure
 *      (missing @rivetos/types or the den adapter) is a test failure.
 *   7. --ingest-file tails the persisted per-file cursor (fixture → rows;
 *      again → 0 new; append → only new rows).
 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseSessionText,
  parseSessionFile,
  uuidFromSessionName,
  isNativeSessionId,
  deriveSessionKey,
  eventIdFromLine,
  capForStorage,
  consumeNewLines,
  ingestMessages,
  createWatcherState,
  scanOnce,
  ingestFileFromCursor,
  loadCaptureState,
  parseCli,
  formatStatus,
  encodePiCwd,
  captureAgent,
  CAPTURE_AGENT,
  CAPTURE_CHANNEL,
  MAX_CONTENT,
  type FileCursor,
  type Queryable,
  type PendingMessage,
} from '../src/pi-memory-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sample-session',
  '2026-09-11T14-25-16-803Z_01a091f5-6deb-723d-8737-eb83070c9154.jsonl',
)

const SESSION = '01a091f5-6deb-723d-8737-eb83070c9154'

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

console.log('Running Pi Memory Capture tests...\n')

// =============================================================================
// Identity constants
// =============================================================================
console.log('— identity constants —')
{
  eq('CAPTURE_AGENT is rivet-deepseek', CAPTURE_AGENT, 'rivet-deepseek')
  eq('CAPTURE_CHANNEL is pi', CAPTURE_CHANNEL, 'pi')
  eq('captureAgent default', captureAgent(), 'rivet-deepseek')
  const prev = process.env.RIVETOS_CAPTURE_AGENT
  process.env.RIVETOS_CAPTURE_AGENT = 'rivet-test'
  eq('captureAgent honours RIVETOS_CAPTURE_AGENT', captureAgent(), 'rivet-test')
  if (prev === undefined) delete process.env.RIVETOS_CAPTURE_AGENT
  else process.env.RIVETOS_CAPTURE_AGENT = prev
  eq('deriveSessionKey prefixes pi:', deriveSessionKey(SESSION), `pi:${SESSION}`)
  eq(
    'uuidFromSessionName reads the trailing uuid',
    uuidFromSessionName(path.basename(FIXTURE)),
    SESSION,
  )
  eq(
    'uuidFromSessionName accepts non-uuid --session-id',
    uuidFromSessionName('2026-09-11T14-25-16-803Z_custom-id.jsonl'),
    'custom-id',
  )
  eq('isNativeSessionId accepts a custom --session-id', isNativeSessionId('custom-id'), true)
  eq('isNativeSessionId rejects path tokens', isNativeSessionId('../evil'), false)
  eq(
    'eventIdFromLine prefers line id',
    eventIdFromLine(SESSION, 'aa11bb22', 4),
    `pi:${SESSION}:aa11bb22`,
  )
  eq(
    'eventIdFromLine falls back to line index',
    eventIdFromLine(SESSION, null, 7),
    `pi:${SESSION}:line:7`,
  )
  eq('encodePiCwd /home/rivet', encodePiCwd('/home/rivet'), '--home-rivet--')
  eq('encodePiCwd /tmp/demo', encodePiCwd('/tmp/demo'), '--tmp-demo--')
}

// =============================================================================
// Parser
// =============================================================================
console.log('\n— parseSessionText (fixture) —')
{
  const text = readFileSync(FIXTURE, 'utf8')
  const parsed = parseSessionText(text, null, FIXTURE)

  eq('session id from session line', parsed.sessionId, SESSION)
  eq('cwd from session line', parsed.cwd, '/tmp/demo')
  eq('title is session_info.name (-n)', parsed.title, 'demo session')
  eq('name field captured from session_info', parsed.name, 'demo session')
  eq('model from model_change', parsed.model, 'deepseek-v4-flash')
  eq('provider from model_change', parsed.provider, 'deepseek')
  eq('thinkingLevel from thinking_level_change', parsed.thinkingLevel, 'high')
  eq('malformed non-json line counted', parsed.malformed, 1)

  const byRole: Record<string, number> = {}
  for (const m of parsed.messages) byRole[m.role] = (byRole[m.role] ?? 0) + 1
  eq('one user row', byRole.user, 1)
  eq('one assistant row', byRole.assistant, 1)
  eq('tool rows include call + result', byRole.tool, 2)

  const user = parsed.messages.find((m) => m.role === 'user')
  eq('user content', user?.content, 'list the files')
  eq('user event id is scoped line id', user?.eventId, `pi:${SESSION}:aa11bb22`)
  check(
    'user row points at the session file',
    user?.extra?.session_jsonl_path === FIXTURE,
    `path=${String(user?.extra?.session_jsonl_path)}`,
  )
  check('user row has a line index', typeof user?.lineIndex === 'number')

  const asst = parsed.messages.find((m) => m.role === 'assistant')
  eq('assistant content is text only', asst?.content, 'here they are')
  eq('thinking lives in reasoning field', asst?.reasoning, 'I should list')
  eq('assistant event id', asst?.eventId, `pi:${SESSION}:cc33dd44`)
  check(
    'assistant usage from message.usage',
    isRecord(asst?.extra?.usage) && (asst?.extra?.usage as { input?: number }).input === 100,
    `usage=${JSON.stringify(asst?.extra?.usage)}`,
  )
  eq('assistant model from model_change', asst?.extra?.model, 'deepseek-v4-flash')

  const call = parsed.messages.find((m) => m.eventId === `pi:${SESSION}:cc33dd44:tool:t1`)
  eq('tool call content', call?.content, '[tool] bash')
  eq('tool call name', call?.toolName, 'bash')
  check(
    'tool args parsed from object',
    isRecord(call?.toolArgs) && (call?.toolArgs as { command?: string }).command === 'ls',
    `args=${JSON.stringify(call?.toolArgs)}`,
  )

  const result = parsed.messages.find((m) => m.eventId === `pi:${SESSION}:ee55ff66`)
  eq('tool result content', result?.content, '[tool-result] bash')
  eq('tool result body', result?.toolResult, 'a.txt')
  eq('tool result name paired via toolCallId', result?.toolName, 'bash')

  check(
    'runtime agent_start skipped',
    (parsed.skipped['type:agent_start'] ?? 0) >= 1,
    `skipped=${JSON.stringify(parsed.skipped)}`,
  )

  const untitled = parseSessionText(
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: SESSION,
        cwd: '/tmp/demo',
      }),
      JSON.stringify({
        type: 'message',
        id: 'aabbccdd',
        message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
      }),
    ].join('\n'),
    null,
    null,
  )
  eq('title falls back to first user text', untitled.title, 'hello world')

  const inventedName = parseSessionText(
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: SESSION,
        cwd: '/tmp/demo',
        name: 'invented session.name',
      }),
      JSON.stringify({
        type: 'name_change',
        name: 'invented name_change',
      }),
      JSON.stringify({
        type: 'session_name',
        name: 'invented session_name',
      }),
      JSON.stringify({
        type: 'message',
        id: 'aabbccdd',
        message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
      }),
    ].join('\n'),
    null,
    null,
  )
  eq(
    'session.name / name_change / session_name are not title sources',
    inventedName.title,
    'hello world',
  )

  const renamed = parseSessionText(
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: SESSION,
        cwd: '/tmp/demo',
      }),
      JSON.stringify({
        type: 'session_info',
        id: SESSION,
        parentId: null,
        timestamp: '2026-09-11T14:25:16.803Z',
        name: 'first name',
      }),
      JSON.stringify({
        type: 'session_info',
        id: SESSION,
        parentId: null,
        timestamp: '2026-09-11T14:25:17.000Z',
        name: 'latest name',
      }),
      JSON.stringify({
        type: 'message',
        id: 'aabbccdd',
        message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
      }),
    ].join('\n'),
    null,
    null,
  )
  eq('latest session_info.name wins', renamed.title, 'latest name')
  eq('latest session_info fills name field', renamed.name, 'latest name')

  const toolOnly = parseSessionText(
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: SESSION,
        cwd: '/tmp/demo',
      }),
      JSON.stringify({
        type: 'message',
        id: 'deadbeef',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'pwd' } },
          ],
          usage: { input: 42, output: 7, totalTokens: 49 },
          stopReason: 'toolUse',
        },
      }),
    ].join('\n'),
    SESSION,
    null,
  )
  eq(
    'tool-only assistant has no text row',
    toolOnly.messages.filter((m) => m.role === 'assistant').length,
    0,
  )
  eq(
    'tool-only emits a tool-call row',
    toolOnly.messages.filter((m) => m.role === 'tool').length,
    1,
  )
  const toolOnlyCall = toolOnly.messages.find((m) => m.role === 'tool')
  check(
    'tool-only usage attaches to the tool-call row',
    isRecord(toolOnlyCall?.extra?.usage) &&
      (toolOnlyCall?.extra?.usage as { input?: number }).input === 42,
    `usage=${JSON.stringify(toolOnlyCall?.extra?.usage)}`,
  )
  eq(
    'tool-only stopReason attaches to the tool-call row',
    toolOnlyCall?.extra?.stopReason,
    'toolUse',
  )

  const reparsed = parseSessionFile(FIXTURE)
  check(
    'parser is deterministic',
    JSON.stringify(reparsed.messages.map((m) => m.eventId)) ===
      JSON.stringify(parsed.messages.map((m) => m.eventId)),
  )
}

console.log('\n— capForStorage —')
{
  const small = capForStorage('hello', { sessionJsonlPath: '/x.jsonl', lineIndex: 0 })
  eq('short text is not truncated', small.truncated, false)
  const big = 'x'.repeat(MAX_CONTENT + 50)
  const capped = capForStorage(big, { sessionJsonlPath: '/x.jsonl', lineIndex: 3 })
  check(
    'long text with pointer is truncated',
    capped.truncated && capped.stored.endsWith('…[truncated]'),
  )
  const uncapped = capForStorage(big, { sessionJsonlPath: null, lineIndex: null })
  check(
    'long text without pointer is left full (deepseek lesson)',
    uncapped.uncapped === true && uncapped.stored.length === big.length,
  )
}

function parseSettings(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string') return {}
  try {
    const parsed = JSON.parse(v) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stubClient(): {
  client: Queryable
  convs: Array<{
    id: string
    session_key: string
    agent: string
    channel: string
    title: string
    active: boolean
    settings: Record<string, unknown>
  }>
  msgs: Array<{
    id: string
    conversation_id: string
    agent: string
    channel: string
    role: string
    content: string
    tool_name: string | null
    tool_result: string | null
    metadata: Record<string, unknown>
  }>
  storedArgs: Map<string, unknown>
  setFailEvent: (id: string | undefined) => void
  setFailLock: (fail: boolean) => void
} {
  type Conv = {
    id: string
    session_key: string
    agent: string
    channel: string
    title: string
    active: boolean
    settings: Record<string, unknown>
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
  let snapshot: { convs: Conv[]; msgs: Msg[] } | undefined
  let failEvent: string | undefined
  let failLock = false
  let txState: 'idle' | 'open' | 'aborted' = 'idle'
  const storedArgs = new Map<string, unknown>()

  const client: Queryable = {
    async query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (s === 'ROLLBACK') {
        if (snapshot) {
          convs.length = 0
          convs.push(...snapshot.convs)
          msgs.length = 0
          msgs.push(...snapshot.msgs)
          snapshot = undefined
        }
        txState = 'idle'
        return { rows: [], rowCount: 0 }
      }
      if (txState === 'aborted') {
        throw new Error(
          'current transaction is aborted, commands ignored until end of transaction block',
        )
      }
      if (s === 'BEGIN') {
        snapshot = {
          convs: convs.map((c) => ({ ...c, settings: { ...c.settings } })),
          msgs: msgs.map((m) => ({ ...m, metadata: { ...m.metadata } })),
        }
        txState = 'open'
        return { rows: [], rowCount: 0 }
      }
      if (s === 'COMMIT') {
        snapshot = undefined
        txState = 'idle'
        return { rows: [], rowCount: 0 }
      }
      try {
        if (s.startsWith('SET LOCAL')) {
          return { rows: [], rowCount: 0 }
        }
        if (
          s.startsWith('SELECT pg_try_advisory_xact_lock') ||
          s.startsWith('SELECT pg_advisory_xact_lock')
        ) {
          if (failLock) throw new Error('injected lock timeout')
          return { rows: [{ locked: true }], rowCount: 1 }
        }
        if (s.startsWith('SELECT id FROM ros_conversations')) {
          const row = convs.find((c) => c.session_key === params[0] && c.agent === params[1])
          return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 }
        }
        if (s.startsWith('INSERT INTO ros_conversations')) {
          const found = convs.find(
            (c) => c.session_key === String(params[0]) && c.agent === String(params[1]),
          )
          if (found) {
            found.title = String(params[3])
            found.settings = parseSettings(params[4])
            return { rows: [{ id: found.id, created: false }], rowCount: 1 }
          }
          const row: Conv = {
            id: `conv-${String(++ids)}`,
            session_key: String(params[0]),
            agent: String(params[1]),
            channel: String(params[2]),
            title: String(params[3]),
            active: Boolean(params[5]),
            settings: parseSettings(params[4]),
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
          if (meta.event_id === failEvent) throw new Error('injected transient database failure')
          if (params[6] !== null) storedArgs.set(String(meta.event_id), JSON.parse(String(params[6])))
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
      } catch (err) {
        if (txState === 'open') txState = 'aborted'
        throw err
      }
    },
  }

  return {
    client,
    convs,
    msgs,
    storedArgs,
    setFailEvent: (id) => {
      failEvent = id
    },
    setFailLock: (fail) => {
      failLock = fail
    },
  }
}

// =============================================================================
// In-memory stub ingest (stands in for sqlite / pg-lite)
// =============================================================================
console.log('\n— stub pool ingest —')
{
  const stub = stubClient()
  const { client, convs, msgs, storedArgs, setFailEvent } = stub

  const parsed = parseSessionFile(FIXTURE)
  const first = await ingestMessages(client, parsed.sessionId, parsed.messages, {
    title: parsed.title,
    cwd: parsed.cwd,
    transcriptPath: FIXTURE,
    triggerEvent: 'smoke',
  })
  eq('first ingest inserts every parsed row', first.inserted, parsed.messages.length)
  eq('first ingest skips none', first.skipped, 0)
  eq('conversation session_key', convs[0]?.session_key, `pi:${SESSION}`)
  eq('conversation agent', convs[0]?.agent, 'rivet-deepseek')
  eq('conversation channel', convs[0]?.channel, 'pi')
  eq('conversation title is -n name', convs[0]?.title, 'demo session')

  const roles = new Set(msgs.map((m) => m.role))
  check('stored roles include user', roles.has('user'))
  check('stored roles include assistant', roles.has('assistant'))
  check('stored roles include tool', roles.has('tool'))
  check(
    'every stored row is agent=rivet-deepseek channel=pi',
    msgs.every((m) => m.agent === 'rivet-deepseek' && m.channel === 'pi'),
  )
  check(
    'every stored row carries event_id + jsonl pointer',
    msgs.every(
      (m) =>
        typeof m.metadata.event_id === 'string' &&
        m.metadata.session_jsonl_path === FIXTURE &&
        typeof m.metadata.session_jsonl_line === 'number',
    ),
  )
  const asst = msgs.find((m) => m.role === 'assistant')
  eq('stored reasoning field', asst?.metadata.reasoning, 'I should list')

  const second = await ingestMessages(client, parsed.sessionId, parsed.messages, {
    title: parsed.title,
    transcriptPath: FIXTURE,
  })
  eq('re-ingest is idempotent (all skipped)', second.skipped, parsed.messages.length)
  eq('re-ingest inserts nothing', second.inserted, 0)
  eq('still one conversation', convs.length, 1)
  eq('message count unchanged', msgs.length, parsed.messages.length)

  const argsRows: PendingMessage[] = [
    {
      role: 'tool',
      content: '[tool] exec',
      eventId: 'freeform',
      toolArgs: 'text("hello")',
      lineIndex: 0,
    },
    {
      role: 'tool',
      content: '[tool] shell',
      eventId: 'array',
      toolArgs: ['one', 'two'],
      lineIndex: 0,
    },
    {
      role: 'tool',
      content: '[tool] shell',
      eventId: 'long-object',
      toolArgs: { value: 'x'.repeat(MAX_CONTENT * 2) },
      lineIndex: 0,
    },
  ]
  await ingestMessages(client, SESSION, argsRows, { transcriptPath: FIXTURE })
  eq('free-form input survives jsonb encoding', storedArgs.get('freeform'), 'text("hello")')
  check('array arguments remain JSON arrays', Array.isArray(storedArgs.get('array')))
  check(
    'truncated object is a valid JSON string preview',
    String(storedArgs.get('long-object')).endsWith('…[truncated]'),
  )

  const retryRows: PendingMessage[] = [
    { role: 'user', content: 'first row', eventId: 'retry-first' },
    { role: 'assistant', content: 'second row', eventId: 'retry-second' },
  ]
  const seen = new Set(['already-committed'])
  const before = msgs.length
  setFailEvent('retry-second')
  let rejected = false
  try {
    await ingestMessages(client, SESSION, retryRows, { seen })
  } catch {
    rejected = true
  }
  check('batch reports the database failure', rejected)
  eq('rollback removes the first insert', msgs.length, before)
  eq('failed batch does not publish dedup progress', seen.size, 1)
  setFailEvent(undefined)
  const replay = await ingestMessages(client, SESSION, retryRows, { seen })
  eq('retry recovers both rolled-back rows', replay.inserted, 2)
  eq('committed batch publishes dedup progress', seen.size, 3)

  const toolOnlyStored = parseSessionText(
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: SESSION,
        cwd: '/tmp/demo',
      }),
      JSON.stringify({
        type: 'message',
        id: 'feedface',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'pwd' } },
          ],
          usage: { input: 42, output: 7, totalTokens: 49 },
          stopReason: 'toolUse',
        },
      }),
    ].join('\n'),
    SESSION,
    FIXTURE,
  )
  const toolOnlyIngest = await ingestMessages(client, SESSION, toolOnlyStored.messages, {
    title: 'tool-only',
    transcriptPath: FIXTURE,
  })
  eq('tool-only ingest inserts the tool-call row', toolOnlyIngest.inserted, 1)
  const storedToolOnly = msgs.find((m) => m.metadata.event_id === `pi:${SESSION}:feedface:tool:c2`)
  check(
    'stored tool-only usage survives ingest',
    isRecord(storedToolOnly?.metadata.usage) &&
      (storedToolOnly?.metadata.usage as { input?: number }).input === 42,
    `usage=${JSON.stringify(storedToolOnly?.metadata.usage)}`,
  )
  eq(
    'stored tool-only stopReason survives ingest',
    storedToolOnly?.metadata.stopReason,
    'toolUse',
  )
}

console.log('\n— lock error recovers the pooled client —')
{
  const stub = stubClient()
  stub.setFailLock(true)
  let lockRejected = false
  try {
    await ingestMessages(stub.client, SESSION, [
      { role: 'user', content: 'lock-fail', eventId: 'lock-fail-user' },
    ])
  } catch {
    lockRejected = true
  }
  check('lock acquisition error is reported', lockRejected)
  eq('lock failure inserts nothing', stub.msgs.length, 0)
  stub.setFailLock(false)
  const recovered = await ingestMessages(stub.client, SESSION, [
    { role: 'user', content: 'after-lock', eventId: 'after-lock-user' },
  ])
  eq('next ingest on the same client succeeds after lock error', recovered.inserted, 1)
  eq('recovered ingest stored the user row', stub.msgs.length, 1)
}

// =============================================================================
// File cursor
// =============================================================================
console.log('\n— consumeNewLines cursor —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-cap-'))
  const file = path.join(dir, `2026-09-11T14-25-16-803Z_${SESSION}.jsonl`)
  writeFileSync(
    file,
    '{"type":"session","version":3,"id":"' + SESSION + '","cwd":"/tmp/demo"}\n',
    'utf8',
  )
  const cursor: FileCursor = { offset: 0, pending: '' }
  const first = consumeNewLines(file, cursor)
  eq('first read yields the complete line', first.length, 1)
  check('offset advanced past the newline', cursor.offset > 0)
  eq('no pending remainder', cursor.pending, '')

  appendFileSync(file, '{"type":"message","id":"aabbcc00","message":{"role":"user"', 'utf8')
  const mid = consumeNewLines(file, cursor)
  eq('incomplete line yields nothing yet', mid.length, 0)
  check('pending holds the partial line', cursor.pending.startsWith('{"type":"message"'))

  appendFileSync(
    file,
    ',"content":[{"type":"text","text":"hi"}]}}\n',
    'utf8',
  )
  const rest = consumeNewLines(file, cursor)
  eq('newline completes the pending line', rest.length, 1)
  check('completed line parses as json', rest[0]!.includes('aabbcc00'))
  rmSync(dir, { recursive: true, force: true })
}

// =============================================================================
// Watch tick over cwd-bucket tree + appended line + second-tick dedup
// =============================================================================
console.log('\n— scanOnce cwd-bucket + append + dedup —')
{
  const stub = stubClient()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-watch-'))
  try {
    const bucket = path.join(dir, encodePiCwd('/tmp/demo'))
    mkdirSync(bucket, { recursive: true })
    const file = path.join(bucket, path.basename(FIXTURE))
    writeFileSync(file, readFileSync(FIXTURE, 'utf8'))
    const state = createWatcherState()
    const first = await scanOnce(dir, stub.client, state, true)
    eq('first tick inserts parsed rows', first.inserted, 4)
    eq('first tick skips none', first.skipped, 0)
    eq('discovered the cwd-bucket file', first.files, 1)

    const second = await scanOnce(dir, stub.client, state, false)
    eq('second tick with no append inserts nothing', second.inserted, 0)

    appendFileSync(
      file,
      JSON.stringify({
        type: 'message',
        id: 'ff00aa11',
        message: { role: 'user', content: [{ type: 'text', text: 'and again' }] },
      }) + '\n',
      'utf8',
    )
    const tailed = await scanOnce(dir, stub.client, state, false)
    eq('appended line inserts one new user row', tailed.inserted, 1)
    const users = stub.msgs.filter((m) => m.role === 'user')
    check(
      'tailed user content present',
      users.some((m) => m.content === 'and again'),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n— scanOnce flat --session-dir —')
{
  const stub = stubClient()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flat-'))
  try {
    const file = path.join(dir, path.basename(FIXTURE))
    writeFileSync(file, readFileSync(FIXTURE, 'utf8'))
    const state = createWatcherState()
    const first = await scanOnce(dir, stub.client, state, true)
    eq('flat session-dir discovers the jsonl', first.files, 1)
    eq('flat session-dir inserts parsed rows', first.inserted, 4)
    eq('flat session_key still pi:<uuid>', stub.convs[0]?.session_key, `pi:${SESSION}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n— scanOnce retries a failed file without another append —')
{
  const stub = stubClient()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-retry-'))
  try {
    const bucket = path.join(dir, encodePiCwd('/tmp/demo'))
    mkdirSync(bucket, { recursive: true })
    const file = path.join(bucket, path.basename(FIXTURE))
    const rewritten = readFileSync(FIXTURE, 'utf8')
      .replaceAll('aa11bb22', 'watch-retry-user')
      .replaceAll('cc33dd44', 'watch-retry-assistant')
    writeFileSync(file, rewritten)
    const state = createWatcherState()
    stub.setFailEvent(`pi:${SESSION}:watch-retry-assistant`)
    await scanOnce(dir, stub.client, state, true)
    eq('failed watch preserves its file offset for retry', state.cursors.get(file)?.offset, 0)
    stub.setFailEvent(undefined)
    const retried = await scanOnce(dir, stub.client, state, false)
    check('watch retries without requiring another file append', retried.inserted >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n— second scan updates title and model settings —')
{
  const stub = stubClient()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-rename-'))
  try {
    const file = path.join(dir, `2026-09-11T14-25-16-803Z_${SESSION}.jsonl`)
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: SESSION, cwd: '/tmp/demo' }),
        JSON.stringify({ type: 'session_info', id: SESSION, name: 'first title' }),
        JSON.stringify({ type: 'model_change', provider: 'deepseek', modelId: 'old-model' }),
        JSON.stringify({
          type: 'message',
          id: 'aabbcc01',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        }),
      ].join('\n') + '\n',
    )
    const state = createWatcherState()
    await scanOnce(dir, stub.client, state, true)
    eq('first scan title from session_info', stub.convs[0]?.title, 'first title')
    eq('first scan model in settings', stub.convs[0]?.settings.model, 'old-model')
    eq('first scan provider in settings', stub.convs[0]?.settings.provider, 'deepseek')

    appendFileSync(
      file,
      JSON.stringify({ type: 'session_info', id: SESSION, name: 'renamed title' }) +
        '\n' +
        JSON.stringify({ type: 'model_change', provider: 'openai', modelId: 'new-model' }) +
        '\n',
    )
    await scanOnce(dir, stub.client, state, false)
    eq('second scan updates title', stub.convs[0]?.title, 'renamed title')
    eq('second scan updates model', stub.convs[0]?.settings.model, 'new-model')
    eq('second scan updates provider', stub.convs[0]?.settings.provider, 'openai')
    eq('still one conversation after rename', stub.convs.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// =============================================================================
// Fold-parity with den-server parser (fails if the adapter cannot be imported)
// =============================================================================
console.log('\n— fold-parity with piTurnsFromLines —')
{
  const denPath = path.resolve(
    __dirname,
    '../../../../../services/den-server/src/harness/adapters/pi.ts',
  )
  let loaded: {
    piTurnsFromLines?: (
      lines: Record<string, unknown>[],
    ) => Array<{ role: string; text?: string; thinking?: string }>
  } | null = null
  try {
    loaded = (await import(denPath)) as typeof loaded
  } catch (err) {
    check(
      'fold-parity imports den-server pi adapter (@rivetos/types resolvable)',
      false,
      err instanceof Error ? err.message : String(err),
    )
  }
  if (!loaded?.piTurnsFromLines) {
    if (loaded) check('fold-parity: piTurnsFromLines exported', false)
  } else {
    const text = readFileSync(FIXTURE, 'utf8')
    const objects: Record<string, unknown>[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        objects.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // ignore
      }
    }
    const turns = loaded.piTurnsFromLines(objects)
    const parsed = parseSessionText(text, SESSION, FIXTURE)
    const foldedUser = turns.filter((t) => t.role === 'user')
    const ingestUser = parsed.messages.filter((m: PendingMessage) => m.role === 'user')
    eq('fold and ingest agree on one human user turn', foldedUser.length, 1)
    eq('ingest user text matches folded user text', ingestUser[0]?.content, foldedUser[0]?.text)
    const foldedAsst = turns.find((t) => t.role === 'assistant')
    eq('folded assistant text', foldedAsst?.text, 'here they are')
    eq(
      'ingest reasoning matches folded thinking',
      parsed.messages.find((m) => m.role === 'assistant')?.reasoning,
      foldedAsst?.thinking,
    )
  }
}

// =============================================================================
// --ingest-file tails the persisted per-file cursor
// =============================================================================
console.log('\n— ingest-file cursor (fixture → rows; again → 0; append → new) —')
{
  const prevState = process.env.RIVETOS_PI_CAPTURE_STATE
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-ingest-file-'))
  const stateFile = path.join(dir, 'pi-capture-state.json')
  process.env.RIVETOS_PI_CAPTURE_STATE = stateFile
  try {
    const stub = stubClient()
    const file = path.join(dir, path.basename(FIXTURE))
    writeFileSync(file, readFileSync(FIXTURE, 'utf8'))

    const first = await ingestFileFromCursor(file, stub.client)
    eq('ingest-file first pass inserts parsed rows', first.inserted, 4)
    eq('ingest-file first pass skips none', first.skipped, 0)
    eq('ingest-file stored session_key', stub.convs[0]?.session_key, `pi:${SESSION}`)
    eq('ingest-file stored agent', stub.convs[0]?.agent, 'rivet-deepseek')
    eq('ingest-file stored channel', stub.convs[0]?.channel, 'pi')

    const persisted = loadCaptureState()
    eq('ingest-file lastIngestSource is extension', persisted.lastIngestSource, 'extension')
    check('ingest-file lastIngestAt is set', typeof persisted.lastIngestAt === 'string' && persisted.lastIngestAt.length > 0)
    check('ingest-file persisted a cursor offset', (persisted.cursors[path.resolve(file)]?.offset ?? 0) > 0)

    const second = await ingestFileFromCursor(file, stub.client)
    eq('ingest-file second pass inserts nothing', second.inserted, 0)
    eq(
      'ingest-file second pass skips none (cursor at EOF, no full re-ingest)',
      second.skipped,
      0,
    )
    eq('message count unchanged on re-ingest', stub.msgs.length, 4)

    appendFileSync(
      file,
      JSON.stringify({
        type: 'message',
        id: 'ff00aa11',
        message: { role: 'user', content: [{ type: 'text', text: 'and again' }] },
      }) + '\n',
      'utf8',
    )
    const tailed = await ingestFileFromCursor(file, stub.client)
    eq('ingest-file append inserts one new user row', tailed.inserted, 1)
    const users = stub.msgs.filter((m) => m.role === 'user')
    check(
      'ingest-file tailed user content present',
      users.some((m) => m.content === 'and again'),
    )
    eq('ingest-file after append has five rows', stub.msgs.length, 5)

    const status = formatStatus()
    check('status mentions lastIngestSource', status.includes('lastIngestSource: extension'))
    check('status mentions lastIngestAt', status.includes('lastIngestAt:'))
  } finally {
    if (prevState === undefined) delete process.env.RIVETOS_PI_CAPTURE_STATE
    else process.env.RIVETOS_PI_CAPTURE_STATE = prevState
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n— parseCli —')
{
  const ingest = parseCli(['--ingest-file', '/tmp/demo.jsonl'])
  eq('parseCli ingest-file mode', ingest.mode, 'ingest-file')
  eq('parseCli ingest-file path', ingest.file, '/tmp/demo.jsonl')
  const backfill = parseCli(['--backfill', '--days', '7', '--sessions-dir', '/tmp/sessions'])
  eq('parseCli backfill mode', backfill.mode, 'backfill')
  eq('parseCli backfill days', backfill.days, 7)
  eq('parseCli sessions-dir', backfill.sessionsDir, '/tmp/sessions')
  eq('parseCli status mode', parseCli(['--status']).mode, 'status')
  eq('parseCli rejects --watch as unknown', parseCli(['--watch']).mode, 'unknown')
}

if (failed > 0) {
  console.error(`\n${String(failed)} test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll Pi Memory Capture tests passed.')
}
