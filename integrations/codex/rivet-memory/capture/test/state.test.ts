/**
 * Capture-state lock + merge tests.
 *
 *   1. mergeCaptureState keeps unrelated session cursors and never regresses.
 *   2. Two overlapping handleHookPayload runs persist both cursors.
 *   3. mkdir lock: stale lock is stolen; live lock times out and proceeds.
 *   4. parseDelayMs reads --delay-ms.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acquireStateLock,
  queuePending,
  takePending,
  pendingQueuePath,
  withStateLock,
  releaseStateLock,
  handleHookPayload,
  loadCaptureState,
  mergeCaptureState,
  parseDelayMs,
  saveCaptureState,
  formatStatus,
  statusPayload,
  type Queryable,
} from '../src/codex-memory-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sample-rollout',
  'rollout-2026-09-07T12-00-00-89965427-b96f-4d5e-8ad5-c3dd138e33dc.jsonl',
)

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
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected sql: ${s}`)
    },
  }
  return { client, convs, msgs }
}

console.log('Running Codex capture state tests...\n')

eq('parseDelayMs missing is 0', parseDelayMs(['--hook']), 0)
eq('parseDelayMs reads --delay-ms', parseDelayMs(['--hook', '--delay-ms', '1500']), 1500)
eq('parseDelayMs rejects negative', parseDelayMs(['--delay-ms', '-1']), 0)

console.log('\n— mergeCaptureState —')
{
  const base = {
    version: 1 as const,
    lastIngestAt: '2026-01-01T00:00:00.000Z',
    lastIngestSource: 'hook:Stop',
    cursors: {
      '/tmp/a.jsonl': { offset: 100, pending: '' },
    },
  }
  const merged = mergeCaptureState(base, {
    lastIngestAt: '2026-01-01T00:00:01.000Z',
    lastIngestSource: 'hook:SessionEnd',
    cursors: {
      '/tmp/b.jsonl': { offset: 40, pending: '' },
      '/tmp/a.jsonl': { offset: 50, pending: '' },
    },
  })
  eq('unrelated cursor B is kept', merged.cursors['/tmp/b.jsonl']?.offset, 40)
  eq('cursor A does not regress', merged.cursors['/tmp/a.jsonl']?.offset, 100)
  eq('newer lastIngestSource wins', merged.lastIngestSource, 'hook:SessionEnd')
}

console.log('\n— concurrent handleHookPayload —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-state-'))
  const stateFile = path.join(dir, 'codex-capture-state.json')
  const a = path.join(dir, 'rollout-a.jsonl')
  const b = path.join(dir, 'rollout-b.jsonl')
  writeFileSync(a, readFileSync(FIXTURE))
  writeFileSync(b, readFileSync(FIXTURE))
  const stub = createStub()
  const [ra, rb] = await Promise.all([
    handleHookPayload(
      {
        hook_event_name: 'Stop',
        session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        transcript_path: a,
      },
      { client: stub.client, stateFile, sessionsDir: dir },
    ),
    handleHookPayload(
      {
        hook_event_name: 'Stop',
        session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        transcript_path: b,
      },
      { client: stub.client, stateFile, sessionsDir: dir },
    ),
  ])
  check('first fire resolved file A', ra.file === path.resolve(a))
  check('second fire resolved file B', rb.file === path.resolve(b))
  const state = loadCaptureState(stateFile)
  check('cursor for A persisted', typeof state.cursors[path.resolve(a)]?.offset === 'number')
  check('cursor for B persisted', typeof state.cursors[path.resolve(b)]?.offset === 'number')
  eq('both cursors present', Object.keys(state.cursors).length, 2)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n— mkdir lock stale vs timeout —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-lock-'))
  const stateFile = path.join(dir, 'state.json')
  saveCaptureState({ version: 1, cursors: {} }, stateFile)

  const staleDir = `${stateFile}.lock`
  mkdirSync(staleDir)
  writeFileSync(
    path.join(staleDir, 'owner.json'),
    `${JSON.stringify({ pid: 999_999_999, ts: Date.now() - 200_000 })}\n`,
  )
  const stolen = await acquireStateLock(stateFile, { staleMs: 120_000, waitMs: 500, pollMs: 50 })
  eq('stale lock is acquired (dead owner)', stolen.held, true)
  releaseStateLock(stolen)

  // a LIVE owner keeps its lock however old the stamp is
  mkdirSync(staleDir)
  writeFileSync(
    path.join(staleDir, 'owner.json'),
    `${JSON.stringify({ pid: process.pid, ts: Date.now() - 200_000 })}\n`,
  )
  const live = await acquireStateLock(stateFile, { staleMs: 120_000, waitMs: 200, pollMs: 50 })
  eq('old stamp with a live owner is NOT stolen', live.held, false)
  let ran = false
  const skipped = await withStateLock(
    stateFile,
    async () => {
      ran = true
      return 'x'
    },
    { waitMs: 100, pollMs: 20 },
  )
  eq('withStateLock skips (null) while the lock is busy', skipped, null)
  eq('busy skip never ran the callback', ran, false)
  rmSync(staleDir, { recursive: true, force: true })
  releaseStateLock(stolen)

  mkdirSync(`${stateFile}.lock`)
  writeFileSync(
    path.join(`${stateFile}.lock`, 'owner.json'),
    `${JSON.stringify({ pid: 1, ts: Date.now() })}\n`,
  )
  const timed = await acquireStateLock(stateFile, { staleMs: 120_000, waitMs: 250, pollMs: 50 })
  eq('live lock times out and proceeds without hold', timed.held, false)
  check('live lock dir still exists after timeout', existsSync(`${stateFile}.lock`))
  rmSync(`${stateFile}.lock`, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n— --status is one JSON line + one human line —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-status-'))
  const stateFile = path.join(dir, 'state.json')
  const state = {
    version: 1 as const,
    lastIngestAt: '2026-09-12T17:20:00.000Z',
    lastIngestSource: 'hook:Stop',
    files: 1,
    inserted: 4,
    skipped: 0,
    cursors: {
      '/tmp/a.jsonl': { offset: 10, pending: '' },
      '/tmp/b.jsonl': { offset: 20, pending: '' },
    },
  }
  saveCaptureState(state, stateFile)
  const loaded = loadCaptureState(stateFile)
  const json = JSON.stringify(statusPayload(loaded, stateFile))
  const human = formatStatus(loaded, stateFile)
  check('JSON status is one line', !json.includes('\n'))
  check('human status is one line', !human.includes('\n'))
  const parsed = JSON.parse(json) as { files?: unknown; lastIngestSource?: unknown }
  eq('status files is cursor count not state.files=1', parsed.files, 2)
  eq('status JSON lastIngestSource', parsed.lastIngestSource, 'hook:Stop')
  check('human line mentions lastIngestAt', human.includes('lastIngestAt=2026-09-12T17:20:00.000Z'))
  check('human files= uses cursor count', human.includes('files=2'))
  rmSync(dir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${String(failed)} state test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll Codex capture state tests passed.')
}

console.log('\n— pending queue —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-pending-'))
  const stateFile = path.join(dir, 'state.json')
  queuePending(stateFile, { file: '/x/a.jsonl', closeSession: true, event: 'SessionEnd' })
  queuePending(stateFile, { file: '/x/b.jsonl' })
  queuePending(stateFile, { file: '/x/a.jsonl' })
  eq('queue file exists', existsSync(pendingQueuePath(stateFile)), true)
  const taken = takePending(stateFile, 'file')
  eq('take dedupes by file', taken.map((e) => e.file).join(','), '/x/a.jsonl,/x/b.jsonl')
  eq('take keeps the first entry fields', taken[0]?.closeSession, true)
  eq('take clears the queue', existsSync(pendingQueuePath(stateFile)), false)
  eq('second take is empty', takePending(stateFile, 'file').length, 0)
  rmSync(dir, { recursive: true, force: true })
}
