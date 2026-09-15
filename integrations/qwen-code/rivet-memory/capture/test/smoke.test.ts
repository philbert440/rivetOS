/**
 * Smoke + unit tests for qwen-memory-capture.
 *
 *   1. Pure parser against a scrubbed real transcript fixture.
 *   2. Identity: session_key, event ids, agent/channel.
 *   3. In-memory stub pool — ingest + re-ingest dedup.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseTranscriptText,
  parseTranscriptFile,
  deriveSessionKey,
  eventIdFromLine,
  capForStorage,
  ingestMessages,
  CAPTURE_AGENT,
  CAPTURE_CHANNEL,
  CAPTURE_SOURCE,
  MAX_CONTENT,
  resolveCaptureAgent,
  type Queryable,
} from '../src/qwen-memory-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sample-session',
  '11111111-2222-4333-8444-555555555555.jsonl',
)
const SESSION = '11111111-2222-4333-8444-555555555555'

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

function createStub(): { client: Queryable; convs: Conv[]; msgs: Msg[] } {
  const convs: Conv[] = []
  const msgs: Msg[] = []
  let ids = 0
  let snapshot: { convs: number; msgs: number } | undefined
  const client: Queryable = {
    async query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (
        String(sql).startsWith('SET ') ||
        String(sql).startsWith('RESET lock_timeout') ||
        String(sql).startsWith('SELECT pg_advisory_lock(') ||
        String(sql).startsWith('SELECT pg_advisory_unlock(')
      ) {
        return { rows: [], rowCount: 0 }
      }
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
        if (s.includes('active = false')) {
          const row = convs.find((c) => c.id === params[0])
          if (row) row.active = false
        }
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected sql: ${s}`)
    },
  }
  return { client, convs, msgs }
}

console.log('Running Qwen Code Memory Capture tests...\n')

console.log('— identity constants —')
{
  eq('CAPTURE_AGENT is rivet-qwen', CAPTURE_AGENT, 'rivet-qwen')
  eq('CAPTURE_CHANNEL is qwen-code', CAPTURE_CHANNEL, 'qwen-code')
  eq('CAPTURE_SOURCE is qwen-session', CAPTURE_SOURCE, 'qwen-session')
  eq('resolveCaptureAgent default', resolveCaptureAgent(), 'rivet-qwen')
  eq('deriveSessionKey prefixes qwen-code:', deriveSessionKey(SESSION), `qwen-code:${SESSION}`)
  eq(
    'eventIdFromLine uses line uuid',
    eventIdFromLine(SESSION, '181c8cae-c294-4d77-b993-166db8e5788b', 0),
    `qwen-code:${SESSION}:181c8cae-c294-4d77-b993-166db8e5788b`,
  )
  eq(
    'eventIdFromLine falls back to line index',
    eventIdFromLine(SESSION, null, 7),
    `qwen-code:${SESSION}:line:7`,
  )
  const capped = capForStorage('x'.repeat(MAX_CONTENT + 10), {
    sessionJsonlPath: '/home/example/x.jsonl',
    lineIndex: 0,
  })
  check('capForStorage truncates when a pointer exists', capped.truncated === true)
}

console.log('\n— parseTranscriptText (fixture) —')
{
  const text = readFileSync(FIXTURE, 'utf8')
  const parsed = parseTranscriptText(text, null, FIXTURE)
  eq('session id from records', parsed.sessionId, SESSION)
  eq('cwd scrubbed', parsed.cwd, '/home/example/scratchpad/proj')
  eq('title is first real_user text', parsed.title, 'reply with the single word pong')
  eq('model from assistant lines', parsed.model, 'qwen-27b')
  eq('qwenVersion from version field', parsed.qwenVersion, '0.23.4')
  check('system lines skipped', (parsed.skipped.system ?? 0) >= 2)
  const roles = parsed.messages.map((m) => m.role)
  check('has user rows', roles.includes('user'))
  check('has assistant rows', roles.includes('assistant'))
  check('has tool rows', roles.includes('tool'))
  eq('message count', parsed.messages.length, 6)
  check('user content', parsed.messages[0]?.content === 'reply with the single word pong')
  check(
    'assistant includes pong',
    parsed.messages.some((m) => m.role === 'assistant' && m.content.includes('pong')),
  )
  check(
    'tool call for run_shell_command',
    parsed.messages.some(
      (m) => m.role === 'tool' && m.toolName === 'run_shell_command' && !m.toolResult,
    ),
  )
  check(
    'tool result output',
    parsed.messages.some((m) => m.toolResult === 'tool-sample-ok'),
  )
  check(
    'dedup key uses line uuid',
    parsed.messages[0]?.eventId === `qwen-code:${SESSION}:181c8cae-c294-4d77-b993-166db8e5788b`,
  )
  eq('no private tmp paths', parsed.cwd?.includes('/tmp/claude') ?? true, false)
}

console.log('\n— ingest fixture through fake pg + re-ingest dedup —')
{
  const parsed = parseTranscriptFile(FIXTURE)
  const stub = createStub()
  const first = await ingestMessages(stub.client, parsed.sessionId, parsed.messages, {
    title: parsed.title,
    cwd: parsed.cwd,
    transcriptPath: FIXTURE,
    triggerEvent: 'backfill',
  })
  eq('first ingest inserts every parsed row', first.inserted, parsed.messages.length)
  eq('first ingest skips none', first.skipped, 0)
  eq('session_key', first.sessionKey, `qwen-code:${SESSION}`)
  eq('conversation agent', stub.convs[0]?.agent, 'rivet-qwen')
  eq('conversation channel', stub.convs[0]?.channel, 'qwen-code')
  eq('conversation title', stub.convs[0]?.title, 'reply with the single word pong')
  check(
    'every stored row is agent=rivet-qwen channel=qwen-code',
    stub.msgs.every((m) => m.agent === 'rivet-qwen' && m.channel === 'qwen-code'),
  )
  check(
    'source is qwen-session',
    stub.msgs.every((m) => m.metadata.source === 'qwen-session'),
  )

  const second = await ingestMessages(stub.client, parsed.sessionId, parsed.messages, {
    title: parsed.title,
    cwd: parsed.cwd,
    transcriptPath: FIXTURE,
    triggerEvent: 'backfill',
  })
  eq('re-ingest inserts 0', second.inserted, 0)
  eq('re-ingest skips all', second.skipped, parsed.messages.length)
  eq('message count unchanged', stub.msgs.length, parsed.messages.length)
}

if (failed > 0) {
  console.error(`\n${String(failed)} smoke test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll Qwen Code capture smoke tests passed.')
}
