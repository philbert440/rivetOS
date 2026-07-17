/**
 * Smoke + unit tests for kimi-memory-capture.
 *
 * Layers:
 *   1. Pure parser tests against synthetic hook payload fixtures
 *      (fixtures/sample-hooks/*.json). No DB required.
 *   2. contentHashEventId stability / collision checks.
 *   3. pickString casing (snake_case + camelCase).
 *   4. findSessionDir returns null for unknown ids.
 *   5. End-to-end --hook spool test — runs the script via tsx (or built
 *      dist/), confirms it spools a hook CaptureOp without spawning the
 *      detached worker (KIMI_CAPTURE_NO_WORKER=1).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

import {
  messagesFromHookPayload,
  contentHashEventId,
  pickString,
  findSessionDir,
  deriveSessionKey,
  CAPTURE_AGENT,
  CAPTURE_CHANNEL,
} from '../src/kimi-memory-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', 'src', 'kimi-memory-capture.ts')
const DIST = path.join(__dirname, '..', 'dist', 'kimi-memory-capture.js')
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'sample-hooks')
const SPOOL_DIR = path.join(os.tmpdir(), 'rivetos-kimi-capture')

const childEnv: NodeJS.ProcessEnv = { ...process.env, KIMI_CAPTURE_NO_WORKER: '1' }

function run(args: string[], stdin = ''): SpawnSyncReturns<string> {
  const useBuilt = fs.existsSync(DIST)
  const cmd = useBuilt ? process.execPath : 'npx'
  const argv = useBuilt ? [DIST, ...args] : ['--yes', 'tsx', SRC, ...args]
  return spawnSync(cmd, argv, { input: stdin, encoding: 'utf8', env: childEnv, timeout: 30000 })
}

function listSpool(): string[] {
  try {
    return fs.readdirSync(SPOOL_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
}

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'))
}

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.error(`✗ ${name}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

console.log('Running Kimi Memory Capture tests...\n')

// =============================================================================
// Constants
// =============================================================================
console.log('— identity constants —')
{
  check('CAPTURE_AGENT is rivet-kimi', CAPTURE_AGENT === 'rivet-kimi')
  check('CAPTURE_CHANNEL is kimi-code', CAPTURE_CHANNEL === 'kimi-code')
  check('deriveSessionKey prefixes kimi-code:', deriveSessionKey('abc') === 'kimi-code:abc')
}

// =============================================================================
// Layer 1: messagesFromHookPayload against fixtures
// =============================================================================
console.log('\n— messagesFromHookPayload (snake_case fixtures) —')
{
  const userPayload = loadFixture('user-prompt.json')
  const sessionId = pickString(userPayload, 'session_id', 'sessionId')!
  const userMsgs = messagesFromHookPayload('UserPromptSubmit', sessionId, userPayload)
  check('UserPromptSubmit yields exactly 1 message', userMsgs.length === 1, `got ${userMsgs.length}`)
  check('UserPromptSubmit role=user', userMsgs[0]?.role === 'user')
  check(
    'UserPromptSubmit content is the prompt',
    userMsgs[0]?.content.includes('memory capture'),
    `content=${userMsgs[0]?.content?.slice(0, 60)}`
  )
  check('UserPromptSubmit has eventId', !!userMsgs[0]?.eventId && userMsgs[0].eventId.length === 64)

  const toolPayload = loadFixture('post-tool-use.json')
  const toolMsgs = messagesFromHookPayload('PostToolUse', sessionId, toolPayload)
  check('PostToolUse yields exactly 1 message', toolMsgs.length === 1)
  check('PostToolUse role=tool', toolMsgs[0]?.role === 'tool')
  check('PostToolUse toolName=Bash', toolMsgs[0]?.toolName === 'Bash')
  check(
    'PostToolUse toolResult populated',
    !!toolMsgs[0]?.toolResult && toolMsgs[0].toolResult!.includes('total'),
    `toolResult=${toolMsgs[0]?.toolResult?.slice(0, 40)}`
  )

  const stopPayload = loadFixture('stop.json')
  const stopMsgs = messagesFromHookPayload('Stop', sessionId, stopPayload)
  check(
    'Stop with response yields assistant message',
    stopMsgs.some(m => m.role === 'assistant'),
    `roles=${stopMsgs.map(m => m.role).join(',')}`
  )
  const assistant = stopMsgs.find(m => m.role === 'assistant')
  check(
    'Stop assistant content present',
    !!assistant?.content && assistant.content.includes('kimi rivet-memory'),
    `content=${assistant?.content?.slice(0, 60)}`
  )

  const startPayload = loadFixture('session-start.json')
  const startMsgs = messagesFromHookPayload('SessionStart', sessionId, startPayload)
  check('SessionStart yields system marker', startMsgs.length >= 1 && startMsgs[0].role === 'system')
  check(
    'SessionStart content has kimi. prefix',
    startMsgs[0]?.content.startsWith('[kimi.'),
    `content=${startMsgs[0]?.content}`
  )
}

console.log('\n— messagesFromHookPayload (camelCase fixture) —')
{
  const camel = loadFixture('post-tool-use-camel.json')
  const sessionId = pickString(camel, 'session_id', 'sessionId')!
  const msgs = messagesFromHookPayload('PostToolUse', sessionId, camel)
  check('camelCase PostToolUse yields 1 tool message', msgs.length === 1 && msgs[0].role === 'tool')
  check('camelCase toolName=ReadFile', msgs[0]?.toolName === 'ReadFile')
  check(
    'camelCase toolOutput extracted',
    !!msgs[0]?.toolResult && msgs[0].toolResult!.includes('camelCase'),
    `toolResult=${msgs[0]?.toolResult}`
  )
}

console.log('\n— PostToolUseFailure —')
{
  const payload = {
    session_id: 'fail-sess',
    tool_name: 'Bash',
    tool_input: { command: 'false' },
    tool_output: 'exit 1',
  }
  const msgs = messagesFromHookPayload('PostToolUseFailure', 'fail-sess', payload)
  check('PostToolUseFailure yields tool row', msgs.length === 1 && msgs[0].role === 'tool')
  check(
    'PostToolUseFailure content marks failure',
    !!msgs[0]?.content.includes('tool-failure'),
    `content=${msgs[0]?.content}`
  )
  check('failure flag in extra', msgs[0]?.extra?.failure === true)
}

// =============================================================================
// Layer 2: content-hash event_id
// =============================================================================
console.log('\n— contentHashEventId —')
{
  const a = contentHashEventId({
    sessionId: 's1',
    role: 'user',
    content: 'hello',
    sourceEvent: 'UserPromptSubmit',
  })
  const b = contentHashEventId({
    sessionId: 's1',
    role: 'user',
    content: 'hello',
    sourceEvent: 'UserPromptSubmit',
  })
  const c = contentHashEventId({
    sessionId: 's1',
    role: 'user',
    content: 'hello!',
    sourceEvent: 'UserPromptSubmit',
  })
  check('same inputs → same event_id (idempotency precondition)', a === b)
  check('different content → different event_id', a !== c)
  check('event_id is 64-char hex', /^[0-9a-f]{64}$/.test(a), `got ${a}`)

  // Re-parse same fixture → same event_id
  const userPayload = loadFixture('user-prompt.json')
  const sessionId = pickString(userPayload, 'session_id', 'sessionId')!
  const m1 = messagesFromHookPayload('UserPromptSubmit', sessionId, userPayload)
  const m2 = messagesFromHookPayload('UserPromptSubmit', sessionId, userPayload)
  check(
    're-parsing same payload yields same event_id',
    m1[0]?.eventId === m2[0]?.eventId && !!m1[0]?.eventId
  )
}

// =============================================================================
// Layer 3: pickString casing
// =============================================================================
console.log('\n— pickString casing —')
{
  check(
    'prefers first key present (snake)',
    pickString({ session_id: 'a', sessionId: 'b' }, 'session_id', 'sessionId') === 'a'
  )
  check(
    'falls back to camelCase',
    pickString({ sessionId: 'b' }, 'session_id', 'sessionId') === 'b'
  )
  check('returns undefined when missing', pickString({}, 'session_id', 'sessionId') === undefined)
}

// =============================================================================
// Layer 4: findSessionDir
// =============================================================================
console.log('\n— findSessionDir resolver —')
{
  const phantom = findSessionDir('00000000-0000-0000-0000-000000000000')
  check('returns null for unknown session id', phantom === null)
}

// =============================================================================
// Layer 5: --hook spool path (subprocess, no DB)
// =============================================================================
console.log('\n— --hook spool e2e —')
{
  const r = run(['--hook', 'SessionStart'])
  check(
    '--hook exits 0 on empty input',
    r.status === 0,
    `status=${r.status} stderr=${(r.stderr || '').trim()}`
  )
}
{
  const sessionId = 'smoke-session-' + Date.now()
  const before = new Set(listSpool())
  const payload = JSON.stringify({
    hook_event_name: 'Stop',
    session_id: sessionId,
    reason: 'end_turn',
    response: 'smoke assistant text',
  })
  const r = run(['--hook', 'Stop'], payload)
  check('--hook Stop exits 0', r.status === 0, `status=${r.status}`)
  const newFiles = listSpool().filter(f => !before.has(f))
  check('writes exactly one spool file', newFiles.length === 1, `newFiles=${JSON.stringify(newFiles)}`)
  if (newFiles.length === 1) {
    const spoolPath = path.join(SPOOL_DIR, newFiles[0])
    let parsed: any = null
    try {
      parsed = JSON.parse(fs.readFileSync(spoolPath, 'utf8'))
    } catch {}
    check('spool op.kind === "hook"', parsed?.kind === 'hook')
    check('spool op.sessionId === payload.session_id', parsed?.sessionId === sessionId)
    check('spool op.sourceEvent === "Stop"', parsed?.sourceEvent === 'Stop')
    check('spool op.finalize is falsy for Stop', !parsed?.finalize)
    check(
      'spool payload carries response',
      parsed?.payload?.response === 'smoke assistant text'
    )
    try {
      fs.unlinkSync(spoolPath)
    } catch {}
  }
}
{
  const sessionId = 'smoke-end-' + Date.now()
  const before = new Set(listSpool())
  const payload = JSON.stringify({ hook_event_name: 'session_end', session_id: sessionId })
  const r = run(['--hook', 'SessionEnd'], payload)
  check('--hook SessionEnd exits 0', r.status === 0)
  const newFiles = listSpool().filter(f => !before.has(f))
  if (newFiles.length === 1) {
    const spoolPath = path.join(SPOOL_DIR, newFiles[0])
    let parsed: any = null
    try {
      parsed = JSON.parse(fs.readFileSync(spoolPath, 'utf8'))
    } catch {}
    check('SessionEnd sets finalize=true', parsed?.finalize === true)
    try {
      fs.unlinkSync(spoolPath)
    } catch {}
  } else {
    check('SessionEnd writes a spool file', false, `newFiles=${JSON.stringify(newFiles)}`)
  }
}
{
  // camelCase sessionId in payload
  const sessionId = 'smoke-camel-' + Date.now()
  const before = new Set(listSpool())
  const payload = JSON.stringify({
    hookEventName: 'UserPromptSubmit',
    sessionId,
    prompt: 'hello camel',
  })
  const r = run(['--hook', 'UserPromptSubmit'], payload)
  check('--hook UserPromptSubmit camelCase exits 0', r.status === 0)
  const newFiles = listSpool().filter(f => !before.has(f))
  if (newFiles.length === 1) {
    const spoolPath = path.join(SPOOL_DIR, newFiles[0])
    let parsed: any = null
    try {
      parsed = JSON.parse(fs.readFileSync(spoolPath, 'utf8'))
    } catch {}
    check('camelCase sessionId resolved', parsed?.sessionId === sessionId)
    try {
      fs.unlinkSync(spoolPath)
    } catch {}
  } else {
    check('UserPromptSubmit writes a spool file', false, `newFiles=${JSON.stringify(newFiles)}`)
  }
}
{
  const missing = path.join(os.tmpdir(), `nonexistent-spool-${Date.now()}.json`)
  const r = run(['--worker', missing])
  check('--worker handles missing file', r.status === 0, `status=${r.status}`)
}

// Dedup simulation (in-memory): same messagesFromHookPayload twice → same ids
// (DB skip is SELECT-by-event_id; we assert the precondition here)
console.log('\n— dedup precondition (inserted then skipped) —')
{
  const payload = loadFixture('user-prompt.json')
  const sessionId = pickString(payload, 'session_id', 'sessionId')!
  const first = messagesFromHookPayload('UserPromptSubmit', sessionId, payload)
  const second = messagesFromHookPayload('UserPromptSubmit', sessionId, payload)
  const seen = new Set(first.map(m => m.eventId))
  let wouldInsert = 0
  let wouldSkip = 0
  for (const m of second) {
    if (seen.has(m.eventId)) wouldSkip++
    else wouldInsert++
  }
  check('second fire would insert=0', wouldInsert === 0, `insert=${wouldInsert}`)
  check('second fire would skip=1', wouldSkip === 1, `skip=${wouldSkip}`)
  // first fire would insert all
  check('first fire would insert=1', first.length === 1)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll tests passed.')
