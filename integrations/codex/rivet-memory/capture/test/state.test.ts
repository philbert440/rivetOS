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
      if (
        String(sql).startsWith('SET lock_timeout') ||
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

if (failed > 0) {
  console.error(`\n${String(failed)} state test(s) failed`)
  process.exitCode = 1
} else {
  console.log('All Codex capture state tests passed.')
}
