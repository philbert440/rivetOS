/**
 * Hook-mode tests for codex-memory-capture.
 *
 *   1. --hook Stop against the fixture rollout inserts rows.
 *   2. Second identical Stop inserts 0 (dedup / cursor).
 *   3. UserPromptSubmit then Stop on a growing file: user first, assistant after.
 *   4. hooks/hooks.json parses with exactly 3 events, each `--hook` timeout 20.
 *
 * Setup's JSON/TOML merge lives in bash (python3/node). A fixture-driven test
 * of that snippet is skipped — see cap-codex-notes.md.
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
  handleHookPayload,
  parseRolloutFile,
  loadCaptureState,
  type Queryable,
} from '../src/codex-memory-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sample-rollout',
  'rollout-2026-09-07T12-00-00-89965427-b96f-4d5e-8ad5-c3dd138e33dc.jsonl',
)
const HOOKS_JSON = path.join(__dirname, '../../hooks/hooks.json')
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

console.log('Running Codex Memory Capture hook tests...\n')

const parsedFixture = parseRolloutFile(FIXTURE)

// =============================================================================
// Stop payload → rows; second identical hook → 0
// =============================================================================
console.log('— --hook Stop (fixture) —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-hook-'))
  const stateFile = path.join(dir, 'codex-capture-state.json')
  const rollout = path.join(dir, path.basename(FIXTURE))
  writeFileSync(rollout, readFileSync(FIXTURE))
  const stub = createStub()
  const payload = {
    hook_event_name: 'Stop',
    session_id: SESSION,
    transcript_path: rollout,
    cwd: '/tmp/demo',
    turn_id: 'turn-1',
    stop_hook_active: false,
    last_assistant_message: 'here they are',
  }

  const first = await handleHookPayload(payload, {
    client: stub.client,
    stateFile,
    sessionsDir: dir,
  })
  eq('Stop inserts every parsed row', first.inserted, parsedFixture.messages.length)
  eq('Stop skips none on first fire', first.skipped, 0)
  eq('Stop event name', first.event, 'Stop')
  check(
    'stored a user row',
    stub.msgs.some((m) => m.role === 'user'),
  )
  check(
    'stored an assistant row',
    stub.msgs.some((m) => m.role === 'assistant'),
  )
  check(
    'stored a tool row',
    stub.msgs.some((m) => m.role === 'tool'),
  )
  eq('one conversation', stub.convs.length, 1)
  eq('session_key', stub.convs[0]?.session_key, `codex:${SESSION}`)

  const stateAfter = loadCaptureState(stateFile)
  eq('lastIngestSource is hook:Stop', stateAfter.lastIngestSource, 'hook:Stop')
  check('lastIngestAt is set', typeof stateAfter.lastIngestAt === 'string')
  check('cursor persisted for the rollout', Object.keys(stateAfter.cursors).length >= 1)

  const second = await handleHookPayload(payload, {
    client: stub.client,
    stateFile,
    sessionsDir: dir,
  })
  eq('second identical Stop inserts 0', second.inserted, 0)
  eq('message count unchanged after dedup', stub.msgs.length, parsedFixture.messages.length)

  rmSync(dir, { recursive: true, force: true })
}

// =============================================================================
// UserPromptSubmit then Stop on a growing file
// =============================================================================
console.log('\n— UserPromptSubmit then Stop (growing file) —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-hook-grow-'))
  const stateFile = path.join(dir, 'codex-capture-state.json')
  const rollout = path.join(dir, path.basename(FIXTURE))
  const lines = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
  // session_meta + 3 wrappers + user
  writeFileSync(rollout, `${lines.slice(0, 5).join('\n')}\n`)
  const stub = createStub()

  const prompt = await handleHookPayload(
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION,
      transcript_path: rollout,
      cwd: '/tmp/demo',
      turn_id: 'turn-1',
      prompt: 'list the files',
    },
    { client: stub.client, stateFile, sessionsDir: dir },
  )
  eq('UserPromptSubmit inserts the user row', prompt.inserted, 1)
  eq('only user rows so far', stub.msgs.length, 1)
  eq('first row is user', stub.msgs[0]?.role, 'user')
  eq('user content', stub.msgs[0]?.content, 'list the files')
  eq(
    'lastIngestSource is hook:UserPromptSubmit',
    loadCaptureState(stateFile).lastIngestSource,
    'hook:UserPromptSubmit',
  )

  appendFileSync(rollout, `${lines.slice(5).join('\n')}\n`)
  const stop = await handleHookPayload(
    {
      hook_event_name: 'Stop',
      session_id: SESSION,
      transcript_path: rollout,
      cwd: '/tmp/demo',
      turn_id: 'turn-1',
    },
    { client: stub.client, stateFile, sessionsDir: dir },
  )
  eq('Stop inserts the remaining rows', stop.inserted, parsedFixture.messages.length - 1)
  eq('still one user row', stub.msgs.filter((m) => m.role === 'user').length, 1)
  check(
    'assistant arrived after the prompt',
    stub.msgs.some((m) => m.role === 'assistant' && m.content === 'here they are'),
  )
  check(
    'tool rows arrived after the prompt',
    stub.msgs.some((m) => m.role === 'tool'),
  )
  eq('total rows match full parse', stub.msgs.length, parsedFixture.messages.length)
  eq('lastIngestSource is hook:Stop', loadCaptureState(stateFile).lastIngestSource, 'hook:Stop')

  rmSync(dir, { recursive: true, force: true })
}

// =============================================================================
// SessionEnd marks the session closed in the state file
// =============================================================================
console.log('\n— SessionEnd closes the session in state —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-hook-end-'))
  const stateFile = path.join(dir, 'codex-capture-state.json')
  const rollout = path.join(dir, path.basename(FIXTURE))
  writeFileSync(rollout, readFileSync(FIXTURE))
  const stub = createStub()
  const result = await handleHookPayload(
    {
      hook_event_name: 'SessionEnd',
      session_id: SESSION,
      transcript_path: rollout,
      cwd: '/tmp/demo',
      reason: 'quit',
    },
    { client: stub.client, stateFile, sessionsDir: dir },
  )
  check('SessionEnd finalized', result.finalized === true)
  const state = loadCaptureState(stateFile)
  eq('closedSessions records the uuid', state.closedSessions?.[SESSION]?.reason, 'quit')
  eq('conversation marked inactive', stub.convs[0]?.active, false)
  rmSync(dir, { recursive: true, force: true })
}

// =============================================================================
// transcript_path missing → newest rollout for session_id
// =============================================================================
console.log('\n— transcript_path fallback via discoverRolloutFiles —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-hook-fb-'))
  const stateFile = path.join(dir, 'codex-capture-state.json')
  const day = path.join(dir, '2026', '09', '07')
  mkdirSync(day, { recursive: true })
  const rollout = path.join(day, path.basename(FIXTURE))
  writeFileSync(rollout, readFileSync(FIXTURE))
  const stub = createStub()
  const result = await handleHookPayload(
    {
      hook_event_name: 'Stop',
      session_id: SESSION,
      transcript_path: null,
      cwd: '/tmp/demo',
    },
    { client: stub.client, stateFile, sessionsDir: dir },
  )
  eq('fallback Stop inserts parsed rows', result.inserted, parsedFixture.messages.length)
  check(
    'resolved a file',
    typeof result.file === 'string' && result.file.endsWith(path.basename(FIXTURE)),
  )
  rmSync(dir, { recursive: true, force: true })
}

// =============================================================================
// hooks/hooks.json shape
// =============================================================================
console.log('\n— hooks/hooks.json —')
{
  const raw = readFileSync(HOOKS_JSON, 'utf8')
  const doc = JSON.parse(raw) as {
    hooks?: Record<
      string,
      Array<{
        matcher?: unknown
        hooks?: Array<{ type?: string; command?: string; timeout?: number }>
      }>
    >
  }
  const hooks = doc.hooks ?? {}
  const events = Object.keys(hooks)
  eq('exactly 3 events', events.length, 3)
  check('has UserPromptSubmit', events.includes('UserPromptSubmit'))
  check('has Stop', events.includes('Stop'))
  check('has SessionEnd', events.includes('SessionEnd'))
  for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd']) {
    const groups = hooks[event] ?? []
    eq(`${event} has one group`, groups.length, 1)
    check(`${event} has no matcher`, groups[0]?.matcher === undefined)
    const cmd = groups[0]?.hooks?.[0]
    eq(`${event} type is command`, cmd?.type, 'command')
    check(
      `${event} command ends with --hook`,
      typeof cmd?.command === 'string' && cmd.command.includes('codex-memory-capture.sh --hook'),
    )
    eq(`${event} timeout is 20`, cmd?.timeout, 20)
  }
}

if (failed > 0) {
  console.error(`\n${String(failed)} hook test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll Codex Memory Capture hook tests passed.')
}
