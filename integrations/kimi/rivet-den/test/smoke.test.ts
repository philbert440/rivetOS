/**
 * Hook-script tests for the Kimi Code CLI rivet-den translator.
 *
 * The shipped artifact is a dependency-free `.mjs` that reads one hook payload
 * on stdin and POSTs den events, so it is tested the way it runs: spawn it,
 * feed it a recorded-shape payload, and assert on what a stand-in den-server
 * receives. A per-scenario temp `HOME` isolates the translator's state dir.
 *
 * Layers:
 *   1. Anti-ghost-room gating — nothing until a human prompt arrives.
 *   2. Prompt extraction, including kimi's real content-part array shape,
 *      and turn-boundary dedup (TurnStarted must not repeat message.user).
 *   3. Tool events: tool.start/tool.end pairing, terminal mirroring,
 *      redaction, and the TodoList → whiteboard path.
 *   4. Turn boundaries: Stop / StopFailure / Interrupt each end a turn once.
 *   5. Session identity: canonical `kimi-code:<native>`, RIVET_DEN_SESSION
 *      passthrough, and the high-entropy fallback.
 *   6. Both payload casings (snake is what kimi 0.34 emits; camel is the
 *      defensive path the accessors keep) and the disable switch.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type DenEvent = Record<string, unknown>

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(__dirname, '..', 'hooks', 'kimi-den-hook.mjs')
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'sample-hooks')
const NATIVE_ID = 'session_2f0f7f2e-1c9a-4b3f-9a51-6d0e1f2a3b4c'
const CANONICAL = `kimi-code:${NATIVE_ID}`

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.error(`✗ ${name}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>
}

// --- stand-in den-server ----------------------------------------------------
// Every event the hook ever posts is also checked against the v1 envelope
// rules den-server's `parseEvent` enforces (packages/den-protocol) — an event
// that would be rejected at ingest is worth failing here, where the reason is
// obvious. Duplicated rather than imported: the hook is dependency-free and
// its tests should not be the thing that drags a build dependency in.
const PROTOCOL_TYPES = new Set([
  'session.start',
  'session.end',
  'turn.end',
  'task.plan',
  'task.check',
  'activity',
  'tool.start',
  'tool.end',
  'thinking.delta',
  'thinking.end',
  'speech.stt',
  'message.user',
  'message.agent',
  'term.line',
])
const ACTIVITIES = new Set([
  'idle',
  'thinking',
  'searching_web',
  'editing_code',
  'running_command',
  'writing_plan',
  'listening',
  'speaking',
  'sleeping',
])
const rejected: string[] = []
function ingestable(e: DenEvent): boolean {
  if (e.v !== 1) return false
  if (typeof e.session !== 'string' || e.session.length === 0) return false
  if (typeof e.type !== 'string' || !PROTOCOL_TYPES.has(e.type)) return false
  if (e.name !== undefined && typeof e.name !== 'string') return false
  if (e.harness !== undefined && typeof e.harness !== 'string') return false
  if (e.ts !== undefined && !Number.isFinite(e.ts)) return false
  if (e.type === 'session.start' && typeof e.title !== 'string') return false
  if (e.type === 'activity' && !ACTIVITIES.has(String(e.activity))) return false
  if (e.type === 'tool.start' && typeof e.tool !== 'string') return false
  if (e.type === 'tool.end' && e.tool !== undefined && typeof e.tool !== 'string') return false
  if (e.type === 'speech.stt' && typeof e.active !== 'boolean') return false
  if (e.type === 'task.plan' && !(Array.isArray(e.tasks) && e.tasks.every((t) => typeof t === 'string')))
    return false
  if (e.type === 'task.check' && !(Number.isInteger(e.index) && Number(e.index) >= 0)) return false
  if (['thinking.delta', 'message.user', 'message.agent', 'term.line'].includes(e.type) && typeof e.text !== 'string')
    return false
  return true
}

let received: DenEvent[] = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    try {
      const parsed: unknown = JSON.parse(body)
      const batch = Array.isArray(parsed) ? (parsed as DenEvent[]) : [parsed as DenEvent]
      for (const ev of batch) {
        if (!ingestable(ev)) rejected.push(JSON.stringify(ev))
      }
      received.push(...batch)
    } catch {
      /* malformed — the assertions will notice the gap */
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

// --- driver -----------------------------------------------------------------
function newHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-den-kimi-'))
}

async function fire(
  event: string,
  payload: unknown,
  opts: { home: string; env?: Record<string, string> } = { home: newHome() },
): Promise<DenEvent[]> {
  received = []
  const child = spawn(process.execPath, [HOOK, event], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: opts.home,
      RIVET_DEN_URL: BASE,
      RIVET_DEN_NAME: 'test-node',
      RIVET_DEN_SESSION: '',
      ...opts.env,
    },
  })
  child.stdin.end(payload === undefined ? '' : JSON.stringify(payload))
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)))
  if (code !== 0) check(`hook exits 0 (${event})`, false, `exit=${code}`)
  return received
}

const types = (evs: DenEvent[]): string[] => evs.map((e) => String(e.type))
const first = (evs: DenEvent[], type: string): DenEvent | undefined => evs.find((e) => e.type === type)

console.log('Running Kimi rivet-den hook tests...\n')

// =============================================================================
// 1. Anti-ghost-room gating
// =============================================================================
console.log('— anti-ghost-room gating —')
{
  const home = newHome()
  check('SessionStart alone emits nothing', (await fire('SessionStart', fixture('session-start.json'), { home })).length === 0)
  check('PreToolUse before any prompt emits nothing', (await fire('PreToolUse', fixture('pre-tool-use-bash.json'), { home })).length === 0)
  check('Stop before any prompt emits nothing', (await fire('Stop', fixture('stop.json'), { home })).length === 0)
  check('TurnStarted before any prompt emits nothing', (await fire('TurnStarted', fixture('turn-started.json'), { home })).length === 0)
  check('SubagentStart before any prompt emits nothing', (await fire('SubagentStart', fixture('subagent-start.json'), { home })).length === 0)

  const opened = await fire('UserPromptSubmit', fixture('user-prompt-parts.json'), { home })
  check('first UserPromptSubmit opens the room', types(opened)[0] === 'session.start', types(opened).join(','))
  check(
    'session.start title comes from session_title',
    first(opened, 'session.start')?.title === 'kimi den wiring',
    String(first(opened, 'session.start')?.title),
  )
  const second = await fire('UserPromptSubmit', fixture('user-prompt-string.json'), { home })
  check('a started room does not re-emit session.start', !types(second).includes('session.start'), types(second).join(','))
}

// =============================================================================
// 2. Prompt extraction + turn-boundary dedup
// =============================================================================
console.log('\n— prompt extraction + turn dedup —')
{
  const home = newHome()
  const parts = await fire('UserPromptSubmit', fixture('user-prompt-parts.json'), { home })
  check(
    'content-part array prompt lands as message.user',
    first(parts, 'message.user')?.text === 'wire the den hooks for kimi',
    JSON.stringify(first(parts, 'message.user')),
  )
  check('UserPromptSubmit emits the speech.stt pair', types(parts).filter((t) => t === 'speech.stt').length === 2)

  const turn = await fire('TurnStarted', fixture('turn-started.json'), { home })
  check('TurnStarted does NOT repeat message.user', !types(turn).includes('message.user'), types(turn).join(','))
  check('TurnStarted poses thinking', first(turn, 'activity')?.activity === 'thinking')

  const dup = await fire('UserPromptSubmit', fixture('user-prompt-parts.json'), { home })
  check('same-turn duplicate prompt is content-hash deduped', !types(dup).includes('message.user'), types(dup).join(','))
  await fire('Stop', fixture('stop.json'), { home })
  const afterTurn = await fire('UserPromptSubmit', fixture('user-prompt-parts.json'), { home })
  check('the same text in a NEW turn is not deduped away', types(afterTurn).includes('message.user'))

  const homeStr = newHome()
  const plain = await fire('UserPromptSubmit', fixture('user-prompt-string.json'), { home: homeStr })
  check('plain-string prompt still works', first(plain, 'message.user')?.text === 'wire the den hooks for kimi')

  const homeWrap = newHome()
  const wrapped = await fire(
    'UserPromptSubmit',
    { ...fixture('user-prompt-string.json'), prompt: '<system-reminder>be good</system-reminder>' },
    { home: homeWrap },
  )
  check('harness-injected wrappers never become a user bubble', !types(wrapped).includes('message.user'), types(wrapped).join(','))
  check('a wrapper-only prompt still opens the room', types(wrapped).includes('session.start'))
}

// =============================================================================
// 3. Tool events
// =============================================================================
console.log('\n— tool events —')
{
  const home = newHome()
  await fire('UserPromptSubmit', fixture('user-prompt-parts.json'), { home })

  const pre = await fire('PreToolUse', fixture('pre-tool-use-bash.json'), { home })
  const start = first(pre, 'tool.start')
  check('PreToolUse emits tool.start with the verbatim tool name', start?.tool === 'Bash')
  check(
    'tool.start args are summarized and secrets redacted',
    (start?.args as Record<string, unknown> | undefined)?.token === '[redacted]',
    JSON.stringify(start?.args),
  )
  check(
    'Bash command mirrors onto the desk terminal',
    String(first(pre, 'term.line')?.text ?? '').startsWith('$ ls -la /tmp'),
    String(first(pre, 'term.line')?.text),
  )

  const post = await fire('PostToolUse', fixture('post-tool-use-bash.json'), { home })
  check('PostToolUse emits tool.end for the same tool', first(post, 'tool.end')?.tool === 'Bash')
  check('shell output tail mirrors onto the terminal', types(post).filter((t) => t === 'term.line').length > 0)

  const fail = await fire('PostToolUseFailure', fixture('post-tool-use-failure.json'), { home })
  check('PostToolUseFailure still closes the tool', first(fail, 'tool.end')?.tool === 'Edit')
  check(
    'the failure message reaches the terminal',
    fail.some((e) => e.type === 'term.line' && String(e.text).includes('✗ Edit: old_string not found')),
    JSON.stringify(fail.filter((e) => e.type === 'term.line')),
  )
  // a non-Error throw takes kimi's fallback branch, which emits no `name`
  const failNoName = await fire('PostToolUseFailure', fixture('post-tool-use-failure-noname.json'), { home })
  check(
    'a name-less error payload still reports its message',
    failNoName.some((e) => e.type === 'term.line' && String(e.text).includes('✗ Bash: command exited 1')),
    JSON.stringify(failNoName.filter((e) => e.type === 'term.line')),
  )

  // defensive alias, pinned so it cannot rot: `Shell` ({cmd}) is not in kimi
  // 0.34's tool set, but one such call exists in captured history
  const alias = await fire('PreToolUse', fixture('pre-tool-use-shell-alias.json'), { home })
  check('the Shell/{cmd} alias still mirrors its command', String(first(alias, 'term.line')?.text ?? '') === '$ echo aliased', String(first(alias, 'term.line')?.text))
  check('the Shell alias reports its tool name verbatim', first(alias, 'tool.start')?.tool === 'Shell')

  const termOff = await fire('PreToolUse', fixture('pre-tool-use-bash.json'), { home, env: { RIVET_DEN_TERM: 'off' } })
  check('RIVET_DEN_TERM=off suppresses terminal lines', !types(termOff).includes('term.line'), types(termOff).join(','))

  const planPre = await fire('PreToolUse', fixture('pre-tool-use-todolist.json'), { home })
  check('TodoList poses writing_plan instead of tool.start', !types(planPre).includes('tool.start') && first(planPre, 'activity')?.activity === 'writing_plan', types(planPre).join(','))

  const planPost = await fire('PostToolUse', fixture('post-tool-use-todolist.json'), { home })
  check('TodoList never emits an unpaired tool.end', !types(planPost).includes('tool.end'), types(planPost).join(','))
  check(
    'todo titles become the whiteboard plan',
    JSON.stringify(first(planPost, 'task.plan')?.tasks) ===
      JSON.stringify(['read the design', 'write the translator', 'land the tests']),
    JSON.stringify(first(planPost, 'task.plan')?.tasks),
  )
  check(
    'status=done checks the row (kimi spells it "done", not "completed")',
    JSON.stringify(planPost.filter((e) => e.type === 'task.check').map((e) => e.index)) === '[0]',
    JSON.stringify(planPost.filter((e) => e.type === 'task.check')),
  )

  const planAgain = await fire(
    'PostToolUse',
    (() => {
      const f = fixture('post-tool-use-todolist.json')
      const input = f.tool_input as { todos: { title: string; status: string }[] }
      input.todos[1].status = 'done'
      return f
    })(),
    { home },
  )
  check(
    'an unchanged list only checks the newly-done row',
    !types(planAgain).includes('task.plan') && JSON.stringify(planAgain.filter((e) => e.type === 'task.check').map((e) => e.index)) === '[1]',
    types(planAgain).join(','),
  )
}

// =============================================================================
// 4. Turn boundaries
// =============================================================================
console.log('\n— turn boundaries —')
{
  const home = newHome()
  await fire('UserPromptSubmit', fixture('user-prompt-parts.json'), { home })
  const stop = await fire('Stop', fixture('stop.json'), { home })
  check('Stop ends the turn', types(stop).join(',') === 'thinking.end,turn.end', types(stop).join(','))
  check('Stop emits no message.agent — the payload carries no reply', !types(stop).includes('message.agent'))
  const stopAgain = await fire('Stop', fixture('stop.json'), { home })
  check('a second Stop with no open turn does not re-end it', !types(stopAgain).includes('turn.end'), types(stopAgain).join(','))

  await fire('UserPromptSubmit', fixture('user-prompt-string.json'), { home })
  const interrupted = await fire('Interrupt', fixture('interrupt.json'), { home })
  check('Interrupt is the turn boundary on cancel', types(interrupted).join(',') === 'thinking.end,turn.end', types(interrupted).join(','))

  await fire('UserPromptSubmit', fixture('user-prompt-string.json'), { home })
  const failedTurn = await fire('StopFailure', fixture('stop-failure.json'), { home })
  check('StopFailure releases the turn too', types(failedTurn).includes('turn.end'), types(failedTurn).join(','))
  check(
    'StopFailure reports the error on the terminal',
    String(first(failedTurn, 'term.line')?.text ?? '').includes('upstream 503'),
    String(first(failedTurn, 'term.line')?.text),
  )

  const nap = await fire('PreCompact', fixture('pre-compact.json'), { home })
  check('PreCompact naps', types(nap).join(',') === 'thinking.end,activity' && first(nap, 'activity')?.activity === 'sleeping', types(nap).join(','))
  const wake = await fire('PostCompact', fixture('post-compact.json'), { home })
  check('PostCompact wakes back up', first(wake, 'activity')?.activity === 'thinking')

  const heartbeat = await fire('SessionHeartbeat', fixture('session-heartbeat.json'), { home })
  check('unmapped events stay silent', heartbeat.length === 0, types(heartbeat).join(','))

  const end = await fire('SessionEnd', fixture('session-end.json'), { home })
  check('SessionEnd closes the room', types(end).join(',') === 'session.end')
  const stateFiles = fs.readdirSync(path.join(home, '.cache', 'rivet-den')).filter((f) => f.endsWith('.json'))
  check('SessionEnd deletes the translator state', stateFiles.length === 0, stateFiles.join(','))
  const afterEnd = await fire('PreToolUse', fixture('pre-tool-use-bash.json'), { home })
  check('a post-SessionEnd stray event does not resurrect the room', afterEnd.length === 0, types(afterEnd).join(','))
}

// =============================================================================
// 5. Session identity
// =============================================================================
console.log('\n— session identity —')
{
  const home = newHome()
  const evs = await fire('UserPromptSubmit', fixture('user-prompt-parts.json'), { home })
  check('events key on the canonical kimi-code:<native> id', evs.every((e) => e.session === CANONICAL), String(evs[0]?.session))
  check('the envelope declares harness kimi-code', evs.every((e) => e.harness === 'kimi-code'))
  check('the envelope carries the display name', evs.every((e) => e.name === 'test-node'))
  check('event timestamps tick so the batch keeps its order', evs.every((e, i) => i === 0 || Number(e.ts) > Number(evs[i - 1].ts)))

  const pinnedHome = newHome()
  const pinned = await fire('UserPromptSubmit', fixture('user-prompt-parts.json'), {
    home: pinnedHome,
    env: { RIVET_DEN_SESSION: 'kimi-code:pre-created-room' },
  })
  check('RIVET_DEN_SESSION is used verbatim, never re-prefixed', pinned.every((e) => e.session === 'kimi-code:pre-created-room'), String(pinned[0]?.session))
  // The room and kimi's own session id are different strings here — which is
  // the whole point of the second field. The `kimi-code` HarnessDriver keys on
  // `harnessSession`, so a den-spawned kimi that dropped it would be a room the
  // control plane can see but cannot name a session for.
  check(
    'a pinned room still reports kimi’s own id in harnessSession',
    pinned.every((e) => e.harnessSession === NATIVE_ID),
    String(pinned[0]?.harnessSession),
  )
  check(
    'harnessSession travels on an unpinned room too',
    evs.every((e) => e.harnessSession === NATIVE_ID),
    String(evs[0]?.harnessSession),
  )

  // Cold start on purpose: `newHome()` has no ~/.cache/rivet-den yet, which is
  // exactly the state a first hook fire meets. The id cache has to create the
  // directory itself — if it doesn't, the write fails silently and every later
  // fire mints a fresh id, scattering one session across a room per event.
  const idlessHome = newHome()
  const idlessPayload = { hook_event_name: 'UserPromptSubmit', cwd: '/home/rivet/project', prompt: 'no id here' }
  const idless = await fire('UserPromptSubmit', idlessPayload, { home: idlessHome })
  const fallbackId = String(idless[0]?.session ?? '')
  check('an id-less payload still gets a namespaced id', fallbackId.startsWith('kimi-code:unknown-'), fallbackId)
  check('the fallback id carries real entropy', /^kimi-code:unknown-[0-9a-f]{16}$/.test(fallbackId), fallbackId)
  // A payload with no session_id has no harness id to report — the room key is
  // a translator invention, and echoing it as a store id would send the driver
  // looking for a session kimi never created.
  check(
    'an id-less payload reports no harnessSession',
    idless.every((e) => e.harnessSession === undefined),
    String(idless[0]?.harnessSession),
  )
  const idFiles = fs.readdirSync(path.join(idlessHome, '.cache', 'rivet-den')).filter((f) => f.endsWith('.id'))
  check('the id cache is written on a cold start (no pre-created state dir)', idFiles.length === 1, idFiles.join(','))

  // Each fire below is its own node process with its own ppid — the same
  // situation kimi's `shell: true, detached: true` spawn produces — so this
  // pins that the cache key does not depend on pid.
  const idless2 = await fire('Stop', { hook_event_name: 'Stop', cwd: '/home/rivet/project' }, { home: idlessHome })
  check('a fallback session keeps its id across fires', idless2.length > 0 && idless2.every((e) => e.session === fallbackId), `${idless2.length} events, ${String(idless2[0]?.session)}`)
  const otherCwd = await fire(
    'UserPromptSubmit',
    { ...idlessPayload, cwd: '/home/rivet/other' },
    { home: idlessHome },
  )
  check('a different cwd gets its own fallback id', String(otherCwd[0]?.session) !== fallbackId, String(otherCwd[0]?.session))
  await fire('SessionEnd', { hook_event_name: 'SessionEnd', cwd: '/home/rivet/project' }, { home: idlessHome })
  const idFilesAfter = fs.readdirSync(path.join(idlessHome, '.cache', 'rivet-den')).filter((f) => f.endsWith('.id'))
  check('SessionEnd reaps the id cache it created', idFilesAfter.length === 1, idFilesAfter.join(','))
}

// =============================================================================
// 6. Casing + kill switch
// =============================================================================
console.log('\n— payload casing + kill switch —')
{
  const home = newHome()
  const camelPrompt = await fire('UserPromptSubmit', fixture('user-prompt-camel.json'), { home })
  check('camelCase payload opens the room on the same canonical id', camelPrompt.every((e) => e.session === CANONICAL), String(camelPrompt[0]?.session))
  check('camelCase prompt still lands as message.user', first(camelPrompt, 'message.user')?.text === 'wire the den hooks for kimi')

  const camelPre = await fire('PreToolUse', fixture('pre-tool-use-camel.json'), { home })
  check('camelCase toolName/toolInput drive tool.start', first(camelPre, 'tool.start')?.tool === 'Bash')
  check('camelCase command mirrors onto the terminal', String(first(camelPre, 'term.line')?.text ?? '').startsWith('$ echo camel'))

  const camelPost = await fire('PostToolUse', fixture('post-tool-use-camel.json'), { home })
  check('camelCase toolOutput mirrors onto the terminal', camelPost.some((e) => e.type === 'term.line' && String(e.text).includes('camel')))
  check('camelCase PostToolUse closes the tool', first(camelPost, 'tool.end')?.tool === 'Bash')

  const argvOnly = await fire('Stop', { session_id: NATIVE_ID }, { home })
  check('the argv event name works when the payload omits it', types(argvOnly).includes('turn.end'), types(argvOnly).join(','))

  const disabledHome = newHome()
  const disabled = await fire('UserPromptSubmit', fixture('user-prompt-parts.json'), {
    home: disabledHome,
    env: { RIVETOS_DEN_HOOK_DISABLED: '1' },
  })
  check('RIVETOS_DEN_HOOK_DISABLED=1 emits nothing at all', disabled.length === 0, types(disabled).join(','))
  check('...and writes no state either', !fs.existsSync(path.join(disabledHome, '.cache', 'rivet-den')))

  const garbageHome = newHome()
  const garbage = await fire('UserPromptSubmit', undefined, { home: garbageHome })
  check('an empty stdin never crashes the hook', Array.isArray(garbage))
}

// =============================================================================
// 7. Protocol conformance across everything emitted above
// =============================================================================
console.log('\n— protocol conformance —')
check('every event emitted in this run would survive den-server ingest', rejected.length === 0, rejected.join(' | '))

server.close()
console.log(failed === 0 ? '\nAll kimi rivet-den hook tests passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
