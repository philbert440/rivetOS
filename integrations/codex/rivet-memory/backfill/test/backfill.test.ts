/**
 * Tests for the Codex transcript backfill.
 *
 * Layers:
 *   1. parseRollout against the capture fixture — wrappers dropped,
 *      user+assistant+tool, item ids.
 *   2. Identity parity with the capture worker on the same bytes.
 *   3. Dedup against a stubbed pg client — same rows twice → inserted then skipped.
 *   4. Dry-run / empty plan issue no writes.
 *   5. Discovery over a YYYY/MM/DD directory layout.
 *   6. Argument parsing.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseRollout,
  planSessions,
  discoverTranscripts,
  countRoles,
  eventIdFromItem,
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
} from '../src/codex-transcript-backfill.ts'

import {
  parseRolloutText as captureParse,
  eventIdFromItem as captureEventId,
  deriveSessionKey as captureSessionKey,
  CAPTURE_AGENT as CAPTURE_AGENT_UPSTREAM,
  CAPTURE_CHANNEL as CAPTURE_CHANNEL_UPSTREAM,
} from '../../capture/src/codex-memory-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(
  __dirname,
  '../../capture/test/fixtures/sample-rollout',
  'rollout-2026-09-07T12-00-00-89965427-b96f-4d5e-8ad5-c3dd138e33dc.jsonl',
)
const SESSION = '89965427-b96f-4d5e-8ad5-c3dd138e33dc'

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

const fixtureText = readFileSync(FIXTURE, 'utf8')

console.log('Running Codex transcript backfill tests...\n')

console.log('— identity —')
{
  eq('CAPTURE_AGENT matches capture', CAPTURE_AGENT, CAPTURE_AGENT_UPSTREAM)
  eq('CAPTURE_CHANNEL matches capture', CAPTURE_CHANNEL, CAPTURE_CHANNEL_UPSTREAM)
  eq('session_key scheme matches', deriveSessionKey(SESSION), captureSessionKey(SESSION))
  eq(
    'event id scheme matches on rs_',
    eventIdFromItem(SESSION, { id: 'rs_user1' }, 4),
    captureEventId(SESSION, { id: 'rs_user1' }, 4),
  )
  eq(
    'line-index fallback matches',
    eventIdFromItem(SESSION, {}, 9),
    captureEventId(SESSION, {}, 9),
  )
}

console.log('\n— parseRollout fixture —')
{
  const r = parseRollout(fixtureText, { sessionId: SESSION, file: FIXTURE })
  const c = countRoles(r.rows)
  eq('session id', r.sessionId, SESSION)
  eq('cwd', r.cwd, '/tmp/demo')
  eq('one user', c.user, 1)
  check('assistant text + thinking', c.assistant >= 1 && c.thinking >= 1, JSON.stringify(c))
  check('tool call + result', c.tool >= 2, `tool=${c.tool}`)
  eq('no malformed', r.malformed, 0)
  eq('first user text', r.firstUserText, 'list the files')
  eq('user event id', r.rows.find((x) => x.role === 'user')?.eventId, 'rs_user1')
  eq('tool call event id', r.rows.find((x) => x.eventId === 'ctc_1')?.content, '[tool] shell')
  eq(
    'tool result event id',
    r.rows.find((x) => x.eventId === 'ctco_1')?.toolResult,
    'a.txt',
  )
  check('developer dropped', (r.skipped.developer ?? 0) >= 1)
  check('wrapper users dropped', (r.skipped['user:wrapper-or-empty'] ?? 0) >= 2)
}

console.log('\n— parse parity with capture —')
{
  const back = parseRollout(fixtureText, { sessionId: SESSION, file: FIXTURE })
  const cap = captureParse(fixtureText, SESSION, FIXTURE)
  eq('same number of rows', back.rows.length, cap.messages.length)
  const backIds = back.rows.map((r) => r.eventId).join(',')
  const capIds = cap.messages.map((m) => m.eventId).join(',')
  eq('event ids match capture', backIds, capIds)
  const backRoles = back.rows.map((r) => r.role).join(',')
  const capRoles = cap.messages.map((m) => m.role).join(',')
  eq('roles match capture', backRoles, capRoles)
}

console.log('\n— truncate —')
{
  eq('short text unchanged', truncate('hi').truncated, false)
  const t = truncate('y'.repeat(MAX_CONTENT + 1))
  check('over cap is truncated', t.truncated && t.stored.endsWith('…[truncated]'))
}

console.log('\n— splitByEventId / empty plan —')
{
  const rows: BackfillRow[] = [
    {
      role: 'user',
      content: 'a',
      eventId: 'rs_a',
      eventTs: null,
      createdAt: new Date(1).toISOString(),
      lineIndex: 0,
      extra: {},
    },
    {
      role: 'user',
      content: 'a',
      eventId: 'rs_a',
      eventTs: null,
      createdAt: new Date(2).toISOString(),
      lineIndex: 1,
      extra: {},
    },
  ]
  const split = splitByEventId(rows, new Set())
  eq('intra-batch duplicate counts as skip', split.inserted, 1)
  eq('intra-batch skip', split.skipped, 1)
}

console.log('\n— stub runSession —')
{
  type Row = Record<string, unknown>
  const convs: Row[] = []
  const msgs: Row[] = []
  const writes: string[] = []
  let ids = 0
  const client = {
    async query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim()
      writes.push(s.split(' ')[0] + ' ' + (s.split(' ')[1] ?? ''))
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith('SET LOCAL') || s.startsWith('SELECT pg_advisory')) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith('SELECT id FROM ros_conversations')) {
        const hit = convs.find((c) => c.session_key === params[0] && c.agent === params[1])
        return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 }
      }
      if (s.startsWith('INSERT INTO ros_conversations')) {
        const existing = convs.find((c) => c.session_key === params[0] && c.agent === params[1])
        if (existing) return { rows: [{ id: existing.id }], rowCount: 1 }
        const id = `c-${String(++ids)}`
        convs.push({ id, session_key: params[0], agent: params[1] })
        return { rows: [{ id }], rowCount: 1 }
      }
      if (s.includes("metadata->>'event_id'")) {
        const want = new Set(params[1] as string[])
        const rows = msgs
          .filter((m) => m.conversation_id === params[0] && want.has(String(m.event_id)))
          .map((m) => ({ event_id: m.event_id }))
        return { rows, rowCount: rows.length }
      }
      if (s.startsWith('INSERT INTO ros_messages')) {
        const meta = JSON.parse(String(params[8])) as { event_id: string }
        msgs.push({
          conversation_id: params[0],
          event_id: meta.event_id,
          role: params[3],
        })
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected sql: ${s}`)
    },
  }

  const parsed = parseRollout(fixtureText, { sessionId: SESSION, file: FIXTURE })
  const plan: SessionPlan = {
    sessionId: SESSION,
    sessionKey: deriveSessionKey(SESSION),
    rows: parsed.rows,
    files: 1,
    malformed: 0,
    skipped: {},
    cwd: parsed.cwd,
    title: parsed.firstUserText ?? 'Codex session',
    errors: [],
    file: FIXTURE,
  }

  const empty = await runSession(client, { ...plan, rows: [] }, false)
  eq('empty plan writes nothing', empty.inserted + empty.skipped, 0)
  check(
    'empty plan issued no INSERT',
    !writes.some((w) => w.startsWith('INSERT')),
    `writes=${writes.join(',')}`,
  )

  writes.length = 0
  const first = await runSession(client, plan, false)
  eq('write inserts parsed rows', first.inserted, parsed.rows.length)
  eq('write skips none', first.skipped, 0)
  const roles = new Set(msgs.map((m) => m.role))
  check('landed user', roles.has('user'))
  check('landed assistant', roles.has('assistant'))
  check('landed tool', roles.has('tool'))

  const second = await runSession(client, plan, false)
  eq('second write skips all', second.skipped, parsed.rows.length)
  eq('second write inserts none', second.inserted, 0)

  const dry = await runSession(client, plan, true)
  eq('dry-run against existing skips all', dry.skipped, parsed.rows.length)
  eq('dry-run inserts none', dry.inserted, 0)
}

console.log('\n— discovery —')
{
  const root = mkdtempSync(path.join(tmpdir(), 'codex-bf-'))
  const day = path.join(root, '2026', '09', '07')
  mkdirSync(day, { recursive: true })
  const dest = path.join(
    day,
    `rollout-2026-09-07T12-00-00-${SESSION}.jsonl`,
  )
  writeFileSync(dest, fixtureText)
  writeFileSync(path.join(day, 'notes.txt'), 'ignore')
  const found = discoverTranscripts(root)
  eq('discovers one rollout', found.length, 1)
  eq('discovered session id', found[0]?.sessionId, SESSION)

  const plans = planSessions(found)
  eq('one session plan', plans.length, 1)
  eq('plan session_key', plans[0]?.sessionKey, `codex:${SESSION}`)
  check('plan has user+assistant+tool', (plans[0]?.rows.length ?? 0) >= 4)
  check(
    'plan rows carry jsonl pointers',
    plans[0]?.rows.every(
      (r) =>
        typeof r.extra.session_jsonl_path === 'string' &&
        typeof r.extra.session_jsonl_line === 'number',
    ) === true,
  )
}

console.log('\n— parseArgs —')
{
  const d = parseArgs([])
  eq('default is dry-run', d.dryRun, true)
  eq('write flips dry-run', parseArgs(['--write']).dryRun, false)
  eq('offline flag', parseArgs(['--offline']).offline, true)
  eq('json flag', parseArgs(['--json']).json, true)
  eq('session filter', parseArgs(['--session', SESSION]).sessionFilter[0], SESSION)
  let threw = false
  try {
    parseArgs(['--bogus'])
  } catch {
    threw = true
  }
  check('unknown arg throws', threw)
}

if (failed > 0) {
  console.error(`\n${String(failed)} test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll Codex transcript backfill tests passed.')
}
