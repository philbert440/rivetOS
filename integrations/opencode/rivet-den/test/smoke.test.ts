/**
 * Plugin tests for the OpenCode rivet-den translator.
 *
 * The shipped artifact is a dependency-free plugin that OpenCode loads in
 * process, so it is tested the way it runs: instantiate it, feed it
 * recorded-shape OpenCode bus events, and assert on what a stand-in den-server
 * receives.
 *
 * Layers:
 *   1. Anti-ghost-room gating — nothing until a human prompt arrives.
 *   2. A full turn: prompt, reasoning, streamed text, a tool, step tokens, and
 *      the idle boundary carrying turn stats.
 *   3. Identity: RIVET_DEN_SESSION as the room, `harnessSession` = `ses_…` on
 *      every event, the canonical fallback room, and a rotation.
 *   4. Ordering edges: parts before their message's role, sub-agent sessions,
 *      harness-injected wrappers, the disable switch.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

type DenEvent = Record<string, unknown>
type Plugin = { event: (input: { event: unknown }) => Promise<void> }

const NATIVE = 'ses_01K8ABCDEFGHIJKLMNOPQRSTUV'
const NATIVE2 = 'ses_01K8QRSTUVWXYZABCDEFGHIJKL'
const CHILD = 'ses_01K8CHILDCHILDCHILDCHILDCH'
const ROOM = '058bbdc6-a484-4eac-b7ec-73c84cbc9b7b'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.error(`✗ ${name}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

// --- stand-in den-server ----------------------------------------------------
// Every posted event is checked against the v1 envelope rules den-server's
// `parseEvent` enforces (packages/den-protocol). Duplicated rather than
// imported, as in the kimi hook tests: the plugin is dependency-free.
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
const nonNeg = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0
function ingestable(e: DenEvent): boolean {
  if (e.v !== 1) return false
  if (typeof e.session !== 'string' || e.session.length === 0) return false
  if (typeof e.type !== 'string' || !PROTOCOL_TYPES.has(e.type)) return false
  if (e.harnessSession !== undefined && typeof e.harnessSession !== 'string') return false
  if (e.type === 'session.start' && typeof e.title !== 'string') return false
  if (e.type === 'tool.start' && typeof e.tool !== 'string') return false
  if (['thinking.delta', 'message.user', 'message.agent'].includes(e.type) && typeof e.text !== 'string')
    return false
  if (e.type === 'message.agent' && e.usage !== undefined) {
    const u = e.usage as Record<string, unknown>
    if (!nonNeg(u.promptTokens) || !nonNeg(u.completionTokens) || !nonNeg(u.cachedTokens)) return false
  }
  return true
}

let received: DenEvent[] = []
const rejected: string[] = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    try {
      const parsed: unknown = JSON.parse(body)
      const batch = Array.isArray(parsed) ? (parsed as DenEvent[]) : [parsed as DenEvent]
      for (const ev of batch) if (!ingestable(ev)) rejected.push(JSON.stringify(ev))
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
const { RivetDen } = (await import('../plugin/rivet-den.ts')) as { RivetDen: () => Promise<Plugin> }

async function plugin(env: Record<string, string | undefined> = { RIVET_DEN_SESSION: ROOM }): Promise<Plugin> {
  process.env.RIVET_DEN_URL = BASE
  process.env.RIVET_DEN_NAME = 'arctic:opencode'
  for (const key of ['RIVET_DEN_SESSION', 'RIVETOS_DEN_HOOK_DISABLED']) delete process.env[key]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v
  received = []
  return RivetDen()
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250))

async function feed(p: Plugin, events: unknown[]): Promise<DenEvent[]> {
  received = []
  for (const event of events) await p.event({ event })
  await settle()
  return received
}

const userMsg = (id: string, sessionID = NATIVE) => ({
  type: 'message.updated',
  properties: { info: { id, sessionID, role: 'user', time: { created: 1 } } },
})
const assistantMsg = (id: string, sessionID = NATIVE) => ({
  type: 'message.updated',
  properties: {
    info: {
      id,
      sessionID,
      role: 'assistant',
      modelID: 'nemotron-3.5-lightning-free',
      providerID: 'opencode',
      time: { created: 2 },
    },
  },
})
const part = (p: Record<string, unknown>, sessionID = NATIVE) => ({
  type: 'message.part.updated',
  properties: { part: { sessionID, ...p } },
})
const idle = (sessionID = NATIVE) => ({ type: 'session.idle', properties: { sessionID } })
const types = (evs: DenEvent[]): string[] => evs.map((e) => String(e.type))

// 1. Anti-ghost-room gating ----------------------------------------------------
{
  const p = await plugin()
  const got = await feed(p, [
    { type: 'session.created', properties: { info: { id: NATIVE, directory: '/x' } } },
    userMsg('msg_u0'),
    idle(),
  ])
  check('no prompt yet → nothing posted', got.length === 0, JSON.stringify(got))
}

// 2. A full turn -------------------------------------------------------------------
{
  const p = await plugin()
  const got = await feed(p, [
    userMsg('msg_u1'),
    part({ id: 'prt_u1', messageID: 'msg_u1', type: 'text', text: 'test' }),
    assistantMsg('msg_a1'),
    part({ id: 'prt_s1', messageID: 'msg_a1', type: 'step-start' }),
    part({ id: 'prt_r1', messageID: 'msg_a1', type: 'reasoning', text: 'The user', time: { start: 1 } }),
    part({ id: 'prt_r1', messageID: 'msg_a1', type: 'reasoning', text: 'The user said test.', time: { start: 1 } }),
    part({
      id: 'prt_t1',
      messageID: 'msg_a1',
      type: 'tool',
      tool: 'bash',
      callID: 'c1',
      state: { status: 'running', input: {}, time: { start: 1 } },
    }),
    part({
      id: 'prt_t1',
      messageID: 'msg_a1',
      type: 'tool',
      tool: 'bash',
      callID: 'c1',
      state: { status: 'completed', input: {}, output: 'ok', title: 'ls', metadata: {}, time: { start: 1, end: 2 } },
    }),
    part({ id: 'prt_x1', messageID: 'msg_a1', type: 'text', text: 'Test ' }),
    part({ id: 'prt_x1', messageID: 'msg_a1', type: 'text', text: 'Test received.' }),
    part({
      id: 'prt_f1',
      messageID: 'msg_a1',
      type: 'step-finish',
      reason: 'stop',
      cost: 0,
      tokens: { input: 100, output: 3, reasoning: 37, cache: { read: 20, write: 0 } },
    }),
    idle(),
  ])
  const t = types(got)
  check(
    'turn: event order',
    JSON.stringify(t) ===
      JSON.stringify([
        'session.start',
        'message.user',
        'activity',
        'thinking.delta',
        'thinking.end',
        'tool.start',
        'tool.end',
        'message.agent',
        'message.agent',
        'turn.end',
      ]),
    JSON.stringify(t),
  )
  check('turn: prompt is the user bubble', got.find((e) => e.type === 'message.user')?.text === 'test')
  check(
    'turn: reasoning deltas, no repeats',
    got.filter((e) => e.type === 'thinking.delta').map((e) => e.text).join('') === 'The user said test.',
  )
  const agent = got.filter((e) => e.type === 'message.agent')
  check('turn: streamed text coalesced into one chunk', agent[0]?.text === 'Test received.', JSON.stringify(agent))
  check(
    'turn: the boundary chunk carries stats and no text',
    agent[1]?.text === '' &&
      JSON.stringify(agent[1]?.usage) === JSON.stringify({ promptTokens: 120, completionTokens: 40, cachedTokens: 20 }) &&
      agent[1]?.model === 'opencode/nemotron-3.5-lightning-free' &&
      typeof agent[1]?.durationMs === 'number',
    JSON.stringify(agent[1]),
  )
  check('turn: tool named', got.find((e) => e.type === 'tool.start')?.tool === 'bash')

  // 3. Identity on every event
  check('identity: room is RIVET_DEN_SESSION', got.every((e) => e.session === ROOM))
  check('identity: harnessSession is the ses_ id', got.every((e) => e.harnessSession === NATIVE))
  check('identity: harness is opencode', got.every((e) => e.harness === 'opencode'))

  // A second prompt in the same session: no second session.start, a new turn.
  const next = await feed(p, [
    userMsg('msg_u2'),
    part({ id: 'prt_u2', messageID: 'msg_u2', type: 'text', text: 'again' }),
    assistantMsg('msg_a2'),
    part({ id: 'prt_x2', messageID: 'msg_a2', type: 'text', text: 'Again.' }),
    idle(),
  ])
  check('second turn: no repeated session.start', !types(next).includes('session.start'), JSON.stringify(types(next)))
  check('second turn: ends', types(next).at(-1) === 'turn.end')

  // A repeated part update must not re-send the prompt or the text.
  const dup = await feed(p, [
    part({ id: 'prt_u2', messageID: 'msg_u2', type: 'text', text: 'again' }),
    part({ id: 'prt_x2', messageID: 'msg_a2', type: 'text', text: 'Again.' }),
    idle(),
  ])
  check('replayed updates post nothing', dup.length === 0, JSON.stringify(dup))

  // Rotation: the same pane moves to a new OpenCode session (/new).
  const rotated = await feed(p, [
    userMsg('msg_u3', NATIVE2),
    part({ id: 'prt_u3', messageID: 'msg_u3', type: 'text', text: 'fresh' }, NATIVE2),
  ])
  check(
    'rotation: same room, new harnessSession',
    rotated.length > 0 && rotated.every((e) => e.session === ROOM && e.harnessSession === NATIVE2),
    JSON.stringify(rotated),
  )
}

// Canonical fallback room ------------------------------------------------------
{
  const p = await plugin({})
  const got = await feed(p, [
    userMsg('msg_u1'),
    part({ id: 'prt_u1', messageID: 'msg_u1', type: 'text', text: 'outside den' }),
  ])
  check(
    'no RIVET_DEN_SESSION → canonical opencode:<ses_> room',
    got.length > 0 && got.every((e) => e.session === `opencode:${NATIVE}`),
    JSON.stringify(got.map((e) => e.session)),
  )
}

// 4. Ordering edges ---------------------------------------------------------------
{
  const p = await plugin()
  const got = await feed(p, [
    part({ id: 'prt_u1', messageID: 'msg_u1', type: 'text', text: 'early part' }),
    userMsg('msg_u1'),
  ])
  check('a part before its role is replayed', got.find((e) => e.type === 'message.user')?.text === 'early part')
}
{
  const p = await plugin()
  const got = await feed(p, [
    { type: 'session.created', properties: { info: { id: CHILD, parentID: NATIVE } } },
    userMsg('msg_c1', CHILD),
    part({ id: 'prt_c1', messageID: 'msg_c1', type: 'text', text: 'subtask prompt' }, CHILD),
    idle(CHILD),
  ])
  check('sub-agent sessions are skipped', got.length === 0, JSON.stringify(got))
}
{
  const p = await plugin()
  const got = await feed(p, [
    userMsg('msg_u1'),
    part({ id: 'prt_u1', messageID: 'msg_u1', type: 'text', text: '<system-reminder>x</system-reminder>' }),
    part({ id: 'prt_u2', messageID: 'msg_u1', type: 'text', text: 'injected', synthetic: true }),
  ])
  check('wrappers and synthetic parts are not user speech', got.length === 0, JSON.stringify(got))
}
{
  const p = await plugin({ RIVET_DEN_SESSION: ROOM, RIVETOS_DEN_HOOK_DISABLED: '1' })
  const got = await feed(p, [userMsg('msg_u1'), part({ id: 'prt_u1', messageID: 'msg_u1', type: 'text', text: 'hi' })])
  check('RIVETOS_DEN_HOOK_DISABLED=1 posts nothing', got.length === 0)
}

check('every posted event is ingestable by den', rejected.length === 0, rejected.join('\n'))

server.close()
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
