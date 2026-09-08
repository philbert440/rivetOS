/**
 * Smoke + unit tests for codex-memory-capture.
 *
 * Layers:
 *   1. Pure parser against a synthetic rollout fixture (den-adapter shape).
 *      No DB required — user + assistant + tool, wrappers dropped.
 *   2. Identity: session_key, event ids (rs_/ctc_/ctco_ vs line fallback).
 *   3. In-memory stub pool — a rollout session lands as user+assistant+tool
 *      with truncation pointers. Stands in for sqlite/pg-lite; this package
 *      does not add deps beyond kimi's (pg).
 *   4. File-cursor tailing (incomplete last line stays pending).
 *   5. Fold-parity against den-server `codexTurnsFromLines` when that module
 *      is importable from this worktree.
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
  parseRolloutText,
  parseRolloutFile,
  uuidFromRolloutName,
  deriveSessionKey,
  eventIdFromItem,
  capForStorage,
  consumeNewLines,
  ingestMessages,
  createWatcherState,
  scanOnce,
  CAPTURE_AGENT,
  CAPTURE_CHANNEL,
  MAX_CONTENT,
  type FileCursor,
  type Queryable,
  type PendingMessage,
} from '../src/codex-memory-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sample-rollout',
  'rollout-2026-09-07T12-00-00-89965427-b96f-4d5e-8ad5-c3dd138e33dc.jsonl',
)

const SESSION = '89965427-b96f-4d5e-8ad5-c3dd138e33dc'

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

console.log('Running Codex Memory Capture tests...\n')

// =============================================================================
// Identity constants
// =============================================================================
console.log('— identity constants —')
{
  eq('CAPTURE_AGENT is rivet-gpt', CAPTURE_AGENT, 'rivet-gpt')
  eq('CAPTURE_CHANNEL is codex', CAPTURE_CHANNEL, 'codex')
  eq('deriveSessionKey prefixes codex:', deriveSessionKey(SESSION), `codex:${SESSION}`)
  eq(
    'uuidFromRolloutName reads the trailing uuid',
    uuidFromRolloutName(path.basename(FIXTURE)),
    SESSION,
  )
  eq(
    'eventIdFromItem prefers payload.id',
    eventIdFromItem(SESSION, { id: 'rs_user1' }, 4),
    'rs_user1',
  )
  eq(
    'eventIdFromItem falls back to line index',
    eventIdFromItem(SESSION, {}, 7),
    `codex:${SESSION}:line:7`,
  )
}

// =============================================================================
// Parser
// =============================================================================
console.log('\n— parseRolloutText (fixture) —')
{
  const text = readFileSync(FIXTURE, 'utf8')
  const parsed = parseRolloutText(text, null, FIXTURE)

  eq('session id from session_meta', parsed.sessionId, SESSION)
  eq('cwd from session_meta', parsed.cwd, '/tmp/demo')
  eq('title is the first real user turn', parsed.title, 'list the files')
  eq('no malformed lines', parsed.malformed, 0)

  const byRole: Record<string, number> = {}
  for (const m of parsed.messages) byRole[m.role] = (byRole[m.role] ?? 0) + 1
  eq('one user row', byRole.user, 1)
  check(
    'assistant rows include thinking + final text',
    (byRole.assistant ?? 0) >= 2,
    `got ${byRole.assistant}`,
  )
  check('tool rows include call + result', (byRole.tool ?? 0) >= 2, `got ${byRole.tool}`)
  check(
    'rollout lands as user+assistant+tool',
    (byRole.user ?? 0) >= 1 && (byRole.assistant ?? 0) >= 1 && (byRole.tool ?? 0) >= 1,
    `roles=${JSON.stringify(byRole)}`,
  )

  const user = parsed.messages.find((m) => m.role === 'user')
  eq('user content', user?.content, 'list the files')
  eq('user event id is rs_user1', user?.eventId, 'rs_user1')
  check(
    'user row points at the rollout file',
    user?.extra?.session_jsonl_path === FIXTURE,
    `path=${String(user?.extra?.session_jsonl_path)}`,
  )
  check('user row has a line index', typeof user?.lineIndex === 'number')

  const think = parsed.messages.find((m) => m.content.startsWith('[thinking] '))
  check('reasoning captured as [thinking] prefix', think?.content === '[thinking] I should list')
  eq('thinking event id', think?.eventId, 'rs_think1')

  const call = parsed.messages.find((m) => m.eventId === 'ctc_1')
  eq('tool call content', call?.content, '[tool] shell')
  eq('tool call name', call?.toolName, 'shell')
  check(
    'tool args parsed from JSON string',
    isRecord(call?.toolArgs) && (call?.toolArgs as { command?: string }).command === 'ls',
    `args=${JSON.stringify(call?.toolArgs)}`,
  )

  const result = parsed.messages.find((m) => m.eventId === 'ctco_1')
  eq('tool result content', result?.content, '[tool-result] shell')
  eq('tool result body', result?.toolResult, 'a.txt')
  eq('tool result name paired via call_id', result?.toolName, 'shell')

  const asst = parsed.messages.find((m) => m.eventId === 'rs_asst1')
  eq('assistant content', asst?.content, 'here they are')

  check(
    'developer + wrapper user turns dropped',
    parsed.skipped['developer'] === 1 && (parsed.skipped['user:wrapper-or-empty'] ?? 0) >= 2,
    `skipped=${JSON.stringify(parsed.skipped)}`,
  )

  const reparsed = parseRolloutFile(FIXTURE)
  check(
    'parser is deterministic',
    JSON.stringify(reparsed.messages.map((m) => m.eventId)) ===
      JSON.stringify(parsed.messages.map((m) => m.eventId)),
  )
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// =============================================================================
// Truncation
// =============================================================================
console.log('\n— modern tool call identity —')
{
  for (const kind of ['custom_tool_call', 'function_call']) {
    const text = [
      { type: 'session_meta', payload: { id: SESSION } },
      {
        type: 'response_item',
        payload: { type: kind, id: 'item-id', call_id: 'call-id', name: 'exec', input: 'text(1)' },
      },
      {
        type: 'response_item',
        payload: { type: `${kind}_output`, id: 'output-id', call_id: 'call-id', output: '1' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')
    const messages = parseRolloutText(text).messages
    eq(`${kind} preserves free-form input`, messages[0]?.toolArgs, 'text(1)')
    eq(`${kind} pairs output by call_id`, messages[1]?.toolName, 'exec')
    eq(`${kind} retains item id for dedup`, messages[0]?.eventId, 'item-id')
  }
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

// =============================================================================
// In-memory stub ingest (stands in for sqlite / pg-lite)
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
  let failEvent: string | undefined
  const storedArgs = new Map<string, unknown>()

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
        // Emulate the (session_key, agent) unique index + ON CONFLICT DO UPDATE:
        // an existing row is returned (created=false); otherwise a new one (created=true).
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
        if (meta.event_id === failEvent) throw new Error('injected transient database failure')
        // Emulate jsonb input validation, which the original stub omitted.
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
    },
  }

  const parsed = parseRolloutFile(FIXTURE)
  const first = await ingestMessages(client, parsed.sessionId, parsed.messages, {
    title: parsed.title,
    cwd: parsed.cwd,
    transcriptPath: FIXTURE,
    triggerEvent: 'smoke',
  })
  eq('first ingest inserts every parsed row', first.inserted, parsed.messages.length)
  eq('first ingest skips none', first.skipped, 0)
  eq('conversation session_key', convs[0]?.session_key, `codex:${SESSION}`)
  eq('conversation agent', convs[0]?.agent, 'rivet-gpt')
  eq('conversation channel', convs[0]?.channel, 'codex')

  const roles = new Set(msgs.map((m) => m.role))
  check('stored roles include user', roles.has('user'))
  check('stored roles include assistant', roles.has('assistant'))
  check('stored roles include tool', roles.has('tool'))
  check(
    'every stored row is agent=rivet-gpt channel=codex',
    msgs.every((m) => m.agent === 'rivet-gpt' && m.channel === 'codex'),
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
  failEvent = 'retry-second'
  let rejected = false
  try {
    await ingestMessages(client, SESSION, retryRows, { seen })
  } catch {
    rejected = true
  }
  check('batch reports the database failure', rejected)
  eq('rollback removes the first insert', msgs.length, before)
  eq('failed batch does not publish dedup progress', seen.size, 1)
  failEvent = undefined
  const replay = await ingestMessages(client, SESSION, retryRows, { seen })
  eq('retry recovers both rolled-back rows', replay.inserted, 2)
  eq('committed batch publishes dedup progress', seen.size, 3)

  const dir = mkdtempSync(path.join(tmpdir(), 'codex-retry-'))
  try {
    const day = path.join(dir, '2026', '09', '07')
    mkdirSync(day, { recursive: true })
    const file = path.join(day, path.basename(FIXTURE))
    writeFileSync(
      file,
      readFileSync(FIXTURE, 'utf8')
        .replaceAll('rs_user1', 'watch-retry-user')
        .replaceAll('rs_asst1', 'watch-retry-assistant'),
    )
    const state = createWatcherState()
    failEvent = 'watch-retry-assistant'
    await scanOnce(dir, client, state, true)
    eq('failed watch preserves its file offset for retry', state.cursors.get(file)?.offset, 0)
    failEvent = undefined
    const retried = await scanOnce(dir, client, state, false)
    eq('watch retries without requiring another file append', retried.inserted, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// =============================================================================
// File cursor
// =============================================================================
console.log('\n— consumeNewLines cursor —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-cap-'))
  const file = path.join(dir, `rollout-2026-09-07T12-00-00-${SESSION}.jsonl`)
  writeFileSync(file, '{"type":"session_meta","payload":{"id":"' + SESSION + '"}}\n', 'utf8')
  const cursor: FileCursor = { offset: 0, pending: '' }
  const first = consumeNewLines(file, cursor)
  eq('first read yields the complete line', first.length, 1)
  check('offset advanced past the newline', cursor.offset > 0)
  eq('no pending remainder', cursor.pending, '')

  appendFileSync(file, '{"type":"response_item","payload":{"type":"message"', 'utf8')
  const mid = consumeNewLines(file, cursor)
  eq('incomplete line yields nothing yet', mid.length, 0)
  check('pending holds the partial line', cursor.pending.startsWith('{"type":"response_item"'))

  appendFileSync(
    file,
    ',"role":"user","id":"rs_tail","content":[{"type":"input_text","text":"hi"}]}}\n',
    'utf8',
  )
  const rest = consumeNewLines(file, cursor)
  eq('newline completes the pending line', rest.length, 1)
  check('completed line parses as json', rest[0]!.includes('rs_tail'))
}

// =============================================================================
// Fold-parity with den-server parser (optional; worktree only)
// =============================================================================
console.log('\n— fold-parity with codexTurnsFromLines —')
{
  const denPath = path.resolve(
    __dirname,
    '../../../../../services/den-server/src/harness/adapters/codex.ts',
  )
  let loaded: {
    codexTurnsFromLines?: (
      lines: Record<string, unknown>[],
    ) => Array<{ role: string; text?: string }>
  } | null = null
  try {
    loaded = (await import(denPath)) as typeof loaded
  } catch (err) {
    console.log(
      `↷ skip fold-parity (den-server parser not importable: ${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (loaded?.codexTurnsFromLines) {
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
    const turns = loaded.codexTurnsFromLines(objects)
    const parsed = parseRolloutText(text, SESSION, FIXTURE)
    const foldedUser = turns.filter((t) => t.role === 'user')
    const ingestUser = parsed.messages.filter((m: PendingMessage) => m.role === 'user')
    eq('fold and ingest agree on one human user turn', foldedUser.length, 1)
    eq('ingest user text matches folded user text', ingestUser[0]?.content, foldedUser[0]?.text)
    check(
      'folded assistant exists (reasoning+tools+text coalesced)',
      turns.some((t) => t.role === 'assistant' && t.text === 'here they are'),
    )
  }
}

if (failed > 0) {
  console.error(`\n${String(failed)} test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll Codex Memory Capture tests passed.')
}
