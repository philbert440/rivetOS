/**
 * Tests for the kimi transcript backfill.
 *
 * Layers:
 *   1. parseWire against sanitized wire.jsonl fixtures — protocol 1.4 and 1.5,
 *      role mapping, injection filtering, tool pairing, timestamp handling.
 *   2. Per-line error isolation — a truncated line does not cost the file.
 *   3. Identity parity with the capture worker: the hash function is the same
 *      function, and a backfilled user row lands on the same event_id a live
 *      `UserPromptSubmit` hook would have produced.
 *   4. Dedup semantics against a stubbed pg client — the same rows twice yield
 *      inserted-then-skipped.
 *   5. Dry-run issues no write of any kind, in-process and end-to-end.
 *
 * No database and no kimi install required. The fixtures are synthetic: real
 * shapes, invented content.
 *
 * Importing the capture worker for the parity check runs its module body, which
 * prints its own usage line to stdout. That line is expected noise.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

import {
  parseWire,
  planSessions,
  discoverTranscripts,
  countRoles,
  contentHashEventId,
  contentText,
  deriveSessionKey,
  parseArgs,
  runSession,
  splitByEventId,
  truncate,
  MAX_CONTENT,
  CAPTURE_AGENT,
  CAPTURE_CHANNEL,
  type BackfillRow,
  type SessionPlan,
} from '../src/kimi-transcript-backfill.ts'

import {
  contentHashEventId as captureHash,
  messagesFromHookPayload,
  CAPTURE_AGENT as CAPTURE_AGENT_UPSTREAM,
  CAPTURE_CHANNEL as CAPTURE_CHANNEL_UPSTREAM,
} from '../../capture/src/kimi-memory-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', 'src', 'kimi-transcript-backfill.ts')
const DIST = path.join(__dirname, '..', 'dist', 'kimi-transcript-backfill.js')
const WIRE = path.join(__dirname, 'fixtures', 'wire')

const SESSION = 'session_00000000-0000-4000-8000-000000000000'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    failed++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
}
function fixture(name: string): string {
  return fs.readFileSync(path.join(WIRE, name), 'utf8')
}

// ---------------------------------------------------------------------------
// 1. parseWire — protocol 1.4
// ---------------------------------------------------------------------------
{
  const r = parseWire(fixture('pv14-main.jsonl'), { sessionId: SESSION })
  const c = countRoles(r.rows)

  eq('pv1.4 protocol version read', r.protocolVersion, '1.4')
  eq('pv1.4 cwd read from config.update', r.cwd, '/work/demo')
  eq('pv1.4 one real user turn', c.user, 1)
  eq('pv1.4 one assistant text row', c.assistant, 1)
  eq('pv1.4 one thinking row', c.thinking, 1)
  eq('pv1.4 tool rows off by default', c.tool, 0)
  eq('pv1.4 no malformed lines', r.malformed, 0)
  eq('pv1.4 title source is the first user turn', r.firstUserText, 'Add a widget to the demo page.')

  const user = r.rows.find(x => x.role === 'user')
  eq('user content is the prompt text', user?.content, 'Add a widget to the demo page.')
  eq('user row carries the hook sourceEvent', user?.extra.sourceEvent, 'UserPromptSubmit')

  const think = r.rows.find(x => x.extra.partType === 'think')
  check('thinking row uses the [thinking] prefix', think?.content.startsWith('[thinking] ') === true)
  eq('thinking row is role assistant', think?.role, 'assistant')

  eq(
    'permission-mode injection dropped',
    r.skipped['origin:injection'],
    1,
  )
  eq('background-task notification dropped', r.skipped['origin:background_task'], 1)

  // Timestamps: the transcript's own clock, and strictly increasing.
  eq('created_at comes from the wire clock', r.rows[0].createdAt, new Date(1780000000011).toISOString())
  const think30 = r.rows.find(x => x.extra.uuid === '22222222-2222-4222-8222-222222222222')
  const text30 = r.rows.find(x => x.extra.uuid === '33333333-3333-4333-8333-333333333333')
  eq('tied wire clock preserved in event_ts', think30?.eventTs, text30?.eventTs)
  check(
    'tied rows nudged apart so read order is stable',
    !!think30 && !!text30 && think30.createdAt < text30.createdAt,
    `${think30?.createdAt} vs ${text30?.createdAt}`,
  )
  let monotonic = true
  for (let i = 1; i < r.rows.length; i++) {
    if (!(r.rows[i - 1].createdAt < r.rows[i].createdAt)) monotonic = false
  }
  check('created_at strictly increases across the file', monotonic)
}

// ---------------------------------------------------------------------------
// 1b. Tool rows, when asked for
// ---------------------------------------------------------------------------
{
  const r = parseWire(fixture('pv14-main.jsonl'), { sessionId: SESSION, includeTools: true })
  const tools = r.rows.filter(x => x.role === 'tool')
  eq('--include-tools emits every call', tools.length, 3)

  const ok = tools.find(t => t.extra.toolCallId === 'Bash_0')
  eq('successful tool content matches capture wording', ok?.content, '[tool] Bash')
  eq('tool result carried through', ok?.toolResult, 'index.html\nwidget.js\n')
  eq('tool args carried through', (ok?.toolArgs as { command: string }).command, 'ls /work/demo')

  const bad = tools.find(t => t.extra.toolCallId === 'Bash_1')
  eq('failing tool content matches capture wording', bad?.content, '[tool-failure] Bash')
  eq('kimi-side truncation flagged', bad?.extra.toolResultTruncatedByKimi, true)

  const dangling = tools.find(t => t.extra.toolCallId === 'Read_2')
  check('a call with no result is still recorded', dangling !== undefined)
  eq('dangling call has a null result', dangling?.toolResult, null)
}

// ---------------------------------------------------------------------------
// 1c. --no-thinking
// ---------------------------------------------------------------------------
{
  const r = parseWire(fixture('pv14-main.jsonl'), { sessionId: SESSION, thinking: false })
  eq('--no-thinking drops think parts', countRoles(r.rows).thinking, 0)
  eq('--no-thinking keeps assistant text', countRoles(r.rows).assistant, 1)
  eq('dropped think parts are counted', r.skipped['part:thinking-disabled'], 1)
}

// ---------------------------------------------------------------------------
// 2. parseWire — protocol 1.5 drift
// ---------------------------------------------------------------------------
{
  const r = parseWire(fixture('pv15-main.jsonl'), { sessionId: SESSION })
  eq('pv1.5 protocol version read', r.protocolVersion, '1.5')
  const c = countRoles(r.rows)
  eq('pv1.5 user turn parsed despite message.id', c.user, 1)
  eq('pv1.5 assistant text parsed', c.assistant, 1)
  eq('pv1.5 thinking parsed', c.thinking, 1)
  eq('pv1.5 no malformed lines', r.malformed, 0)
  eq(
    'multi-part prompt joins on a single space',
    r.rows.find(x => x.role === 'user')?.content,
    'Check the release notes, then tag the build.',
  )
}

// ---------------------------------------------------------------------------
// 2b. Origin filtering across a subagent file
// ---------------------------------------------------------------------------
{
  const r = parseWire(fixture('pv14-agent-0.jsonl'), { sessionId: SESSION, agentSlot: 'agent-0' })
  const users = r.rows.filter(x => x.role === 'user')
  eq('subagent task prompt kept as a user turn', users.length, 1)
  eq('subagent origin recorded', users[0].extra.originKind, 'system_trigger:subagent')
  eq('goal_continuation dropped', r.skipped['origin:system_trigger:goal_continuation'], 1)
  eq('skill_activation dropped', r.skipped['origin:skill_activation'], 1)
  eq('agent slot recorded on every row', r.rows.every(x => x.extra.agentSlot === 'agent-0'), true)
}

// ---------------------------------------------------------------------------
// 3. Per-line error isolation
// ---------------------------------------------------------------------------
{
  const r = parseWire(fixture('malformed-main.jsonl'), { sessionId: SESSION })
  eq('every unusable line counted', r.malformed, 4)
  eq('prompts on both sides of the damage survive', countRoles(r.rows).user, 2)
  eq('assistant text after the damage survives', countRoles(r.rows).assistant, 1)
}

// ---------------------------------------------------------------------------
// 4. Identity — parity with the capture worker
// ---------------------------------------------------------------------------
{
  eq('agent constant matches capture', CAPTURE_AGENT, CAPTURE_AGENT_UPSTREAM)
  eq('channel constant matches capture', CAPTURE_CHANNEL, CAPTURE_CHANNEL_UPSTREAM)
  eq('session key prefix matches the rows already in the store', deriveSessionKey('session_x'), 'kimi-code:session_x')

  const matrix = [
    { sessionId: 's1', role: 'user', content: 'hello' },
    { sessionId: 's1', role: 'assistant', content: 'hello' },
    { sessionId: 's2', role: 'user', content: 'hello' },
    { sessionId: 's1', role: 'tool', content: '[tool] Bash', toolName: 'Bash', toolResult: 'ok', sourceEvent: 'PostToolUse' },
    { sessionId: 's1', role: 'user', content: 'hello', sourceEvent: 'UserPromptSubmit' },
  ]
  check(
    'hash function is byte-identical to capture',
    matrix.every(m => contentHashEventId(m) === captureHash(m)),
  )
  const digests = new Set(matrix.map(m => contentHashEventId(m)))
  eq('distinct material yields distinct ids', digests.size, matrix.length)

  // The collision that matters: a backfilled prompt must land on the same
  // event_id the live hook path produces for that same prompt.
  const prompt = 'Add a widget to the demo page.'
  const live = messagesFromHookPayload('UserPromptSubmit', SESSION, { prompt })
  const liveUser = live.find(m => m.role === 'user')
  const backfilled = parseWire(fixture('pv14-main.jsonl'), { sessionId: SESSION }).rows.find(
    r => r.role === 'user',
  )
  eq('backfilled prompt dedups against the live-captured one', backfilled?.eventId, liveUser?.eventId)

  // …and the same for the shape that actually caused the data loss.
  //
  // The check above only exercises capture's *string* path. Real kimi prompts
  // arrive as an array of content parts — the whole reason capture dropped ~50
  // of them — so the string case can pass while the array renderings diverge and
  // every backfilled prompt doubles up against a live-captured one.
  //
  // Capture only grows array support when the capture fix (#473) lands, and this
  // package must be green before then, so the check is feature-gated: feed
  // capture an array payload, and if it extracts nothing, the installed worker
  // predates the fix and there is nothing to be parity with yet. The moment #473
  // merges, the gate opens and this bites.
  //
  // Note both sides trim. #473 adds `.trim()` to capture's string path so the two
  // shapes converge on one rendering; `contentText` here is that rule.
  const arrayPrompt = [
    { type: 'text', text: '  Add a widget to the demo page.  ' },
    { type: 'image', url: 'ignored' },
  ]
  const liveFromArray = messagesFromHookPayload('UserPromptSubmit', SESSION, {
    prompt: arrayPrompt,
  }).find(m => m.role === 'user')
  if (!liveFromArray) {
    console.log(
      '⊘ array parity — activates when capture array support (#473) lands (installed capture extracts nothing from an array prompt)',
    )
  } else {
    eq(
      'array parity — capture renders array prompts exactly as contentText does',
      liveFromArray.content,
      contentText(arrayPrompt),
    )
    eq(
      'array parity — an array-shaped prompt dedups against the backfilled row',
      liveFromArray.eventId,
      contentHashEventId({
        sessionId: SESSION,
        role: 'user',
        content: contentText(arrayPrompt) as string,
        sourceEvent: 'UserPromptSubmit',
      }),
    )
    // Whitespace is the failure mode a missing trim on either side produces.
    const padded = messagesFromHookPayload('UserPromptSubmit', SESSION, {
      prompt: '  Add a widget to the demo page.  ',
    }).find(m => m.role === 'user')
    eq(
      'array parity — string and array shapes render identically once trimmed',
      padded?.eventId,
      liveFromArray.eventId,
    )
  }

  // …while two subagents that happen to say the same thing stay two rows.
  const a = parseWire(fixture('pv14-main.jsonl'), { sessionId: SESSION }).rows.find(
    r => r.role === 'assistant' && r.extra.partType === 'text',
  )
  const b = parseWire(fixture('pv14-agent-0.jsonl'), { sessionId: SESSION, agentSlot: 'agent-0' }).rows.find(
    r => r.role === 'assistant' && r.extra.partType === 'text',
  )
  eq('identical assistant text in two files', a?.content, b?.content)
  check('…still hashes to two distinct rows', a?.eventId !== b?.eventId)

  // Replay stability: same bytes, same ids.
  const first = parseWire(fixture('pv15-main.jsonl'), { sessionId: SESSION }).rows.map(r => r.eventId)
  const second = parseWire(fixture('pv15-main.jsonl'), { sessionId: SESSION }).rows.map(r => r.eventId)
  eq('parsing is deterministic', JSON.stringify(first), JSON.stringify(second))
}

// ---------------------------------------------------------------------------
// 4b. truncate mirrors capture's cap
// ---------------------------------------------------------------------------
{
  const long = 'x'.repeat(MAX_CONTENT + 50)
  const t = truncate(long)
  check('over-long content is truncated', t.truncated && t.stored.endsWith('…[truncated]'))
  eq('short content is untouched', truncate('short').stored, 'short')
  eq('contentText ignores non-text parts', contentText([{ type: 'image' }, { type: 'text', text: 'a' }]), 'a')
  eq('contentText passes strings through', contentText('plain'), 'plain')
  eq('contentText rejects empty arrays', contentText([]), undefined)
  eq('contentText trims the string shape', contentText('  padded  '), 'padded')
  eq('contentText trims the array shape', contentText([{ type: 'text', text: '  padded  ' }]), 'padded')
  eq('both shapes render identically', contentText('  x  '), contentText([{ type: 'text', text: ' x ' }]))
  eq('contentText rejects whitespace-only strings', contentText('   '), undefined)
}

// ---------------------------------------------------------------------------
// 5. Write / dry-run semantics against a stubbed client
// ---------------------------------------------------------------------------
class StubClient {
  queries: string[] = []
  /** event_ids the fake database already holds. */
  stored = new Set<string>()
  constructor(private conversationExists = true) {}
  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
    this.queries.push(sql.trim().split('\n')[0].trim())
    if (/^SELECT id FROM ros_conversations/.test(sql.trim())) {
      return { rows: this.conversationExists ? [{ id: 'conv-1' }] : [], rowCount: this.conversationExists ? 1 : 0 }
    }
    if (/INSERT INTO ros_conversations/.test(sql)) {
      this.conversationExists = true
      return { rows: [{ id: 'conv-1' }], rowCount: 1 }
    }
    if (/SELECT metadata->>'event_id'/.test(sql)) {
      const wanted = (params[1] as string[]) ?? []
      const rows = wanted.filter(id => this.stored.has(id)).map(event_id => ({ event_id }))
      return { rows, rowCount: rows.length }
    }
    if (/INSERT INTO ros_messages/.test(sql)) {
      const metadata = JSON.parse(params[8] as string) as { event_id: string }
      this.stored.add(metadata.event_id)
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
}

function planFrom(files: Array<[string, string]>): SessionPlan {
  const transcripts = files.map(([agentSlot, file]) => ({
    file,
    sessionId: SESSION,
    agentSlot,
    workspace: 'wd_demo',
  }))
  const plans = planSessions(transcripts, {
    readFile: f => fs.readFileSync(path.join(WIRE, f), 'utf8'),
  })
  return plans[0]
}

{
  const plan = planFrom([
    ['main', 'pv14-main.jsonl'],
    ['agent-0', 'pv14-agent-0.jsonl'],
  ])
  eq('both files land in one conversation', plan.files, 2)
  eq('session key is the canonical one', plan.sessionKey, `kimi-code:${SESSION}`)
  eq('title taken from the main file', plan.title, 'Add a widget to the demo page.')
  eq('protocol versions recorded', plan.protocolVersions.join(','), '1.4')
  let ordered = true
  for (let i = 1; i < plan.rows.length; i++) {
    if (plan.rows[i - 1].createdAt > plan.rows[i].createdAt) ordered = false
  }
  check('merged rows are in transcript order', ordered)

  const write = new StubClient(false)
  const first = await runSession(write, plan, false)
  eq('first write inserts every row', first.inserted, plan.rows.length)
  eq('first write skips nothing', first.skipped, 0)

  const second = await runSession(write, plan, false)
  eq('second write inserts nothing', second.inserted, 0)
  eq('second write skips every row', second.skipped, plan.rows.length)

  // A dry run over the same, now-populated, stub predicts the same skips.
  const dry = new StubClient(true)
  dry.stored = write.stored
  const predicted = await runSession(dry, plan, true)
  eq('dry run predicts the real skip count', predicted.skipped, plan.rows.length)
  eq('dry run predicts no inserts', predicted.inserted, 0)
  check(
    'dry run issues no BEGIN / INSERT / UPDATE',
    dry.queries.every(q => !/^(BEGIN|INSERT|UPDATE|DELETE)/i.test(q)),
    dry.queries.join(' | '),
  )
}

{
  // Same line twice inside one file: one row, not two.
  const doubled = fixture('pv15-main.jsonl')
    .split('\n')
    .filter(Boolean)
    .flatMap(l => [l, l])
    .join('\n')
  const rows = parseWire(doubled, { sessionId: SESSION }).rows
  const unique = new Set(rows.map((r: BackfillRow) => r.eventId))
  const single = parseWire(fixture('pv15-main.jsonl'), { sessionId: SESSION }).rows
  eq('duplicated lines collapse to one row each', unique.size, single.length)

  const stub = new StubClient(false)
  const plan: SessionPlan = {
    sessionId: SESSION,
    sessionKey: deriveSessionKey(SESSION),
    rows,
    files: 1,
    malformed: 0,
    skipped: {},
    protocolVersions: ['1.5'],
    cwd: null,
    title: 'demo',
    errors: [],
  }
  const res = await runSession(stub, plan, false)
  eq('a doubled transcript writes each row once', res.inserted, single.length)
  eq('the duplicate half is skipped', res.skipped, rows.length - single.length)

  // Greenfield dry run must predict exactly what that write just did — no
  // conversation row on the server, but the batch still duplicates itself.
  const greenfield = new StubClient(false)
  const predicted = await runSession(greenfield, plan, true)
  eq('greenfield dry run counts intra-batch duplicates as skips', predicted.inserted, res.inserted)
  eq('…and matches the real skip count', predicted.skipped, res.skipped)
  check(
    'greenfield dry run still writes nothing',
    greenfield.queries.every(q => !/^(BEGIN|INSERT|UPDATE|DELETE)/i.test(q)),
    greenfield.queries.join(' | '),
  )
}

{
  // A session with nothing to say must not touch the conversation row — a
  // re-run over already-ingested sessions has to leave updated_at alone.
  const empty: SessionPlan = {
    sessionId: SESSION,
    sessionKey: deriveSessionKey(SESSION),
    rows: [],
    files: 1,
    malformed: 0,
    skipped: {},
    protocolVersions: ['1.4'],
    cwd: null,
    title: 'demo',
    errors: [],
  }
  const stub = new StubClient(true)
  const res = await runSession(stub, empty, false)
  eq('an empty plan inserts nothing', res.inserted, 0)
  eq('an empty plan skips nothing', res.skipped, 0)
  eq('an empty plan issues no query at all', stub.queries.length, 0)

  eq('splitByEventId honours ids already held', splitByEventId(
    [{ eventId: 'a' }, { eventId: 'b' }] as unknown as BackfillRow[],
    new Set(['a']),
  ).inserted, 1)
}

// ---------------------------------------------------------------------------
// 6. Discovery + end-to-end dry run
// ---------------------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-backfill-test-'))
  const sessionsDir = path.join(root, 'sessions')
  const layout: Array<[string, string, string]> = [
    ['wd_demo_aaaa', SESSION, 'main'],
    ['wd_demo_aaaa', SESSION, 'agent-0'],
    ['wd_other_bbbb', 'session_11111111-1111-4111-8111-111111111111', 'main'],
  ]
  const sources = ['pv14-main.jsonl', 'pv14-agent-0.jsonl', 'pv15-main.jsonl']
  layout.forEach(([ws, sess, slot], i) => {
    const dir = path.join(sessionsDir, ws, sess, 'agents', slot)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(path.join(WIRE, sources[i]), path.join(dir, 'wire.jsonl'))
  })
  // Noise that must be ignored: a stray file and a non-session directory.
  fs.writeFileSync(path.join(sessionsDir, 'session_index.jsonl'), 'ignored\n')
  fs.mkdirSync(path.join(sessionsDir, 'wd_demo_aaaa', 'not-a-session'), { recursive: true })

  const found = discoverTranscripts(sessionsDir)
  eq('discovery finds every wire.jsonl', found.length, 3)
  eq('discovery groups two slots under one session', found.filter(t => t.sessionId === SESSION).length, 2)
  eq('discovery on a missing root returns nothing', discoverTranscripts(path.join(root, 'nope')).length, 0)

  const useBuilt = fs.existsSync(DIST)
  const cmd = useBuilt ? process.execPath : 'npx'
  const argv = (args: string[]): string[] => (useBuilt ? [DIST, ...args] : ['--yes', 'tsx', SRC, ...args])
  const proc = spawnSync(cmd, argv(['--dry-run', '--offline', '--sessions-dir', sessionsDir]), {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, RIVETOS_PG_URL: '' },
  })
  eq('e2e dry run exits clean', proc.status, 0)
  check('e2e dry run announces itself', /DRY RUN \(nothing written\)/.test(proc.stdout), proc.stdout + proc.stderr)
  check('e2e dry run lists both sessions', /sessions=2/.test(proc.stdout), proc.stdout)
  check('e2e dry run prints the summary table', /totals: files=3/.test(proc.stdout), proc.stdout)
  check('e2e dry run tells you how to commit', /--write to commit/.test(proc.stdout), proc.stdout)

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 7. Argument parsing
// ---------------------------------------------------------------------------
{
  eq('dry-run is the default', parseArgs([]).dryRun, true)
  eq('thinking is on by default', parseArgs([]).thinking, true)
  eq('tools are off by default', parseArgs([]).includeTools, false)
  eq('--write opts into writing', parseArgs(['--write']).dryRun, false)
  eq('--no-dry-run is an alias', parseArgs(['--no-dry-run']).dryRun, false)
  eq('--sessions-dir takes a value', parseArgs(['--sessions-dir', '/tmp/x']).sessionsDir, '/tmp/x')
  eq('--session is repeatable', parseArgs(['--session', 'a', '--session', 'b']).sessionFilter.length, 2)
  let threw = false
  try {
    parseArgs(['--nonsense'])
  } catch {
    threw = true
  }
  check('unknown arguments are rejected', threw)
  threw = false
  try {
    parseArgs(['--pg-url'])
  } catch {
    threw = true
  }
  check('a flag missing its value is rejected', threw)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
