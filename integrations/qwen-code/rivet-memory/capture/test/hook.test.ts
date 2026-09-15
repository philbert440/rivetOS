/**
 * Hook-mode tests for qwen-memory-capture.
 *
 *   1. --hook Stop against the fixture transcript inserts rows.
 *   2. Second identical Stop inserts 0 (dedup).
 *   3. SessionEnd closes state.
 *   4. --hook parent hands off (mock spawn): --ingest-file / --delay-ms 400.
 *   5. hooks.json parses with exactly 3 events; commands use <PLUGIN_PATH>.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  handleHookPayload,
  handOffHook,
  parseTranscriptFile,
  loadCaptureState,
  HOOK_HANDOFF_DELAY_MS,
  type Queryable,
  type SpawnOpts,
} from '../src/qwen-memory-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sample-session',
  '11111111-2222-4333-8444-555555555555.jsonl',
)
const HOOKS_JSON = path.join(__dirname, '../../extension/hooks/hooks.json')
const EXT_JSON = path.join(__dirname, '../../extension/qwen-extension.json')
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

console.log('Running Qwen Code Memory Capture hook tests...\n')

const parsedFixture = parseTranscriptFile(FIXTURE)

console.log('— --hook Stop (fixture) —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'qwen-hook-'))
  const stateFile = path.join(dir, 'qwen-code-capture-state.json')
  const transcript = path.join(dir, path.basename(FIXTURE))
  writeFileSync(transcript, readFileSync(FIXTURE))
  const stub = createStub()
  const payload = {
    hook_event_name: 'Stop',
    session_id: SESSION,
    transcript_path: transcript,
    cwd: '/home/example/scratchpad/proj',
  }

  const first = await handleHookPayload(payload, {
    client: stub.client,
    stateFile,
    projectsDir: dir,
  })
  eq('Stop inserts every parsed row', first.inserted, parsedFixture.messages.length)
  eq('Stop skips none on first fire', first.skipped, 0)
  eq('Stop event name', first.event, 'Stop')
  eq('session_key', stub.convs[0]?.session_key, `qwen-code:${SESSION}`)

  const second = await handleHookPayload(payload, {
    client: stub.client,
    stateFile,
    projectsDir: dir,
  })
  eq('second identical Stop inserts 0', second.inserted, 0)
  eq('message count unchanged after dedup', stub.msgs.length, parsedFixture.messages.length)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n— SessionEnd closes the session in state —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'qwen-hook-end-'))
  const stateFile = path.join(dir, 'qwen-code-capture-state.json')
  const transcript = path.join(dir, path.basename(FIXTURE))
  writeFileSync(transcript, readFileSync(FIXTURE))
  const stub = createStub()
  const result = await handleHookPayload(
    {
      hook_event_name: 'SessionEnd',
      session_id: SESSION,
      transcript_path: transcript,
      reason: 'prompt_input_exit',
    },
    { client: stub.client, stateFile, projectsDir: dir },
  )
  check('SessionEnd finalized', result.finalized === true)
  const state = loadCaptureState(stateFile)
  eq(
    'closedSessions records the uuid',
    state.closedSessions?.[SESSION]?.reason,
    'prompt_input_exit',
  )
  eq('conversation marked inactive', stub.convs[0]?.active, false)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n— --hook hand-off (mock spawn) —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'qwen-hook-handoff-'))
  const transcript = path.join(dir, path.basename(FIXTURE))
  writeFileSync(transcript, readFileSync(FIXTURE))
  type SpawnCall = { cmd: string; args: string[]; opts: SpawnOpts; unrefed: boolean }
  const calls: SpawnCall[] = []
  const spawnFn = (cmd: string, args: string[], opts: SpawnOpts) => {
    const call: SpawnCall = { cmd, args, opts, unrefed: false }
    calls.push(call)
    return {
      unref(): void {
        call.unrefed = true
      },
    }
  }
  const result = handOffHook(
    {
      hook_event_name: 'Stop',
      session_id: SESSION,
      transcript_path: transcript,
    },
    {
      spawn: spawnFn,
      projectsDir: dir,
      argv: ['node', '/tmp/qwen-memory-capture.js'],
      execPath: '/usr/bin/node',
    },
  )
  eq('hand-off spawned', result.spawned, true)
  eq('hand-off returns the transcript', result.file, path.resolve(transcript))
  eq('one spawn call', calls.length, 1)
  check('spawn args include --ingest-file', Boolean(calls[0]?.args.includes('--ingest-file')))
  check(
    'spawn args include the transcript path',
    Boolean(calls[0]?.args.includes(path.resolve(transcript))),
  )
  check('spawn args include --delay-ms', Boolean(calls[0]?.args.includes('--delay-ms')))
  check('spawn args include 400', Boolean(calls[0]?.args.includes(String(HOOK_HANDOFF_DELAY_MS))))
  eq('Stop does not pass --close-session', calls[0]?.args.includes('--close-session'), false)
  eq('spawn is detached', calls[0]?.opts.detached, true)
  eq('spawn stdio is ignore', calls[0]?.opts.stdio, 'ignore')
  eq('child is unref()d', calls[0]?.unrefed, true)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n— SessionEnd hand-off passes --close-session —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'qwen-hook-handoff-end-'))
  const transcript = path.join(dir, path.basename(FIXTURE))
  writeFileSync(transcript, readFileSync(FIXTURE))
  const calls: Array<{ args: string[] }> = []
  const result = handOffHook(
    {
      hook_event_name: 'SessionEnd',
      session_id: SESSION,
      transcript_path: transcript,
    },
    {
      spawn: (_cmd, args) => {
        calls.push({ args })
        return { unref(): void {} }
      },
      projectsDir: dir,
      argv: ['node', '/tmp/qwen-memory-capture.js'],
      execPath: '/usr/bin/node',
    },
  )
  eq('SessionEnd closeSession flag', result.closeSession, true)
  check(
    'SessionEnd spawn args include --close-session',
    Boolean(calls[0]?.args.includes('--close-session')),
  )
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n— hooks.json + qwen-extension.json only reference <PLUGIN_PATH> —')
{
  const hooks = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as {
    hooks: Record<
      string,
      Array<{ hooks: Array<{ command: string; timeout: number; name?: string }> }>
    >
  }
  const events = Object.keys(hooks.hooks).sort()
  eq('exactly three hook events', events.join(','), 'SessionEnd,Stop,UserPromptSubmit')
  for (const event of events) {
    const cmd = hooks.hooks[event]?.[0]?.hooks?.[0]?.command ?? ''
    check(`${event} command uses <PLUGIN_PATH>`, cmd.includes('<PLUGIN_PATH>'))
    check(`${event} command does not use an absolute host path`, !cmd.startsWith('/home/'))
    check(`${event} command names qwen-memory-capture.sh`, cmd.includes('qwen-memory-capture.sh'))
    check(`${event} command has --hook`, cmd.includes('--hook'))
    eq(`${event} timeout is 20s`, hooks.hooks[event]?.[0]?.hooks?.[0]?.timeout, 20)
    eq(`${event} name is rivet-memory`, hooks.hooks[event]?.[0]?.hooks?.[0]?.name, 'rivet-memory')
  }
  const ext = JSON.parse(readFileSync(EXT_JSON, 'utf8')) as {
    name: string
    mcpServers: { rivetos: { command: string } }
  }
  eq('extension name', ext.name, 'rivet-memory')
  check(
    'mcp command uses <PLUGIN_PATH>',
    ext.mcpServers.rivetos.command.includes('<PLUGIN_PATH>/bin/rivet-memory-mcp.sh'),
  )
  check(
    'mcp command is not an absolute host path',
    ext.mcpServers.rivetos.command.startsWith('<PLUGIN_PATH>'),
  )
}

if (failed > 0) {
  console.error(`\n${String(failed)} hook test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll Qwen Code capture hook tests passed.')
}
