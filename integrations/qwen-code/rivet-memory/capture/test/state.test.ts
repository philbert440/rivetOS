/**
 * Capture-state merge tests.
 *
 *   1. mergeCaptureState keeps unrelated session cursors and never regresses.
 *   2. parseDelayMs reads --delay-ms.
 *   3. status payload / formatStatus.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  loadCaptureState,
  mergeCaptureState,
  parseDelayMs,
  formatStatus,
  statusPayload,
  saveCaptureState,
  emptyCaptureState,
  type CaptureState,
} from '../src/qwen-memory-capture.ts'

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

console.log('Running Qwen Code capture state tests...\n')

console.log('— mergeCaptureState never regresses cursors —')
{
  const base: CaptureState = {
    version: 1,
    lastIngestAt: '2026-09-15T20:00:00.000Z',
    lastIngestSource: 'hook:Stop',
    cursors: {
      '/home/example/a.jsonl': { offset: 100, pending: '' },
      '/home/example/b.jsonl': { offset: 50, pending: 'partial' },
    },
  }
  const merged = mergeCaptureState(base, {
    lastIngestAt: '2026-09-15T20:01:00.000Z',
    lastIngestSource: 'hook:SessionEnd',
    cursors: {
      '/home/example/a.jsonl': { offset: 80, pending: '' },
      '/home/example/c.jsonl': { offset: 10, pending: '' },
    },
    inserted: 3,
    skipped: 1,
  })
  eq('older offset for A is dropped', merged.cursors['/home/example/a.jsonl']?.offset, 100)
  eq('unrelated B kept', merged.cursors['/home/example/b.jsonl']?.offset, 50)
  eq('new C added', merged.cursors['/home/example/c.jsonl']?.offset, 10)
  eq('newer lastIngestAt wins', merged.lastIngestAt, '2026-09-15T20:01:00.000Z')
  eq('newer source wins', merged.lastIngestSource, 'hook:SessionEnd')
}

console.log('\n— parseDelayMs —')
{
  eq('missing is 0', parseDelayMs(['--ingest-file', 'x.jsonl']), 0)
  eq('reads --delay-ms', parseDelayMs(['--ingest-file', 'x.jsonl', '--delay-ms', '400']), 400)
  eq('non-numeric is 0', parseDelayMs(['--delay-ms', 'nope']), 0)
}

console.log('\n— load / save / status —')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'qwen-state-'))
  const file = path.join(dir, 'qwen-code-capture-state.json')
  eq('missing file is empty', loadCaptureState(file).version, 1)
  const empty = emptyCaptureState()
  check(
    'formatStatus on empty mentions no ingest',
    formatStatus(empty, file).includes('no ingest yet'),
  )
  saveCaptureState(
    {
      version: 1,
      lastIngestAt: '2026-09-15T20:24:54.104Z',
      lastIngestSource: 'hook:Stop',
      hookInstalledAt: '2026-09-15T20:00:00.000Z',
      inserted: 6,
      skipped: 0,
      cursors: { '/home/example/x.jsonl': { offset: 12, pending: '' } },
    },
    file,
  )
  const loaded = loadCaptureState(file)
  eq('round-trip lastIngestSource', loaded.lastIngestSource, 'hook:Stop')
  eq('round-trip cursor offset', loaded.cursors['/home/example/x.jsonl']?.offset, 12)
  const payload = statusPayload(loaded, file)
  eq('status files count', payload.files, 1)
  eq('status inserted', payload.inserted, 6)
  check(
    'human line names qwen-memory-capture',
    formatStatus(loaded, file).includes('qwen-memory-capture --status'),
  )
  rmSync(dir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${String(failed)} state test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll Qwen Code capture state tests passed.')
}
