/**
 * State persistence under concurrent ingest processes: two writers that each
 * loaded a stale map must not lose each other's cursors, and a cursor never
 * moves backwards. The mkdir lock serializes ingests; the merge protects
 * an unlocked writer. Tests must be able to fail.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  emptyState,
  loadState,
  mergeState,
  saveState,
  parseDelayMs,
  claimPending,
  pendingQueuePath,
  queuePending,
  takePending,
} from '../src/opencode-memory-capture.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmpState(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'oc-state-'))
  dirs.push(d)
  return path.join(d, 'opencode-capture-state.json')
}

describe('saveState / mergeState', () => {
  it('two interleaved saves from stale maps keep both sessions and never regress', () => {
    const file = tmpState()
    const a = { ...emptyState(), sessions: { A: { partTimeUpdated: 100, messageTimeUpdated: 90 } } }
    const b = {
      ...emptyState(),
      sessions: { B: { partTimeUpdated: 200, messageTimeUpdated: 190 } },
    }
    saveState(a, file) // A lands
    saveState(b, file) // B loaded {} before A landed — must not drop A
    const onDisk = loadState(file)
    expect(onDisk.sessions?.A).toEqual({ partTimeUpdated: 100, messageTimeUpdated: 90 })
    expect(onDisk.sessions?.B).toEqual({ partTimeUpdated: 200, messageTimeUpdated: 190 })

    // a stale writer for A with an OLDER cursor cannot move it backwards
    const stale = {
      ...emptyState(),
      sessions: { A: { partTimeUpdated: 50, messageTimeUpdated: 40 } },
    }
    saveState(stale, file)
    expect(loadState(file).sessions?.A).toEqual({ partTimeUpdated: 100, messageTimeUpdated: 90 })
    // and the in-memory copy was lifted to the persisted value
    expect(stale.sessions?.A.partTimeUpdated).toBe(100)
  })

  it('mergeState takes the max of the global high-water marks', () => {
    const disk = { ...emptyState(), partTimeUpdated: 500, messageTimeUpdated: 400 }
    const next = {
      ...emptyState(),
      partTimeUpdated: 300,
      messageTimeUpdated: 450,
      lastIngestSource: 'plugin',
    }
    const m = mergeState(disk, next)
    expect(m.partTimeUpdated).toBe(500)
    expect(m.messageTimeUpdated).toBe(450)
    expect(m.lastIngestSource).toBe('plugin')
  })

  it('writes atomically (no temp files left behind)', () => {
    const file = tmpState()
    saveState(emptyState(), file)
    const left = readFileSync(file, 'utf8')
    expect(JSON.parse(left).version).toBe(1)
    const siblings = readdirSync(path.dirname(file))
    expect(siblings.filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('pending queue', () => {
  it('queues, dedupes by key, and clears on take', () => {
    const file = tmpState()
    queuePending(file, { sessionId: 'ses_a' })
    queuePending(file, { sessionId: 'ses_b' })
    queuePending(file, { sessionId: 'ses_a' })
    expect(existsSync(pendingQueuePath(file))).toBe(true)
    const taken = takePending(file, 'sessionId')
    expect(taken.map((e) => e.sessionId)).toEqual(['ses_a', 'ses_b'])
    expect(existsSync(pendingQueuePath(file))).toBe(false)
    expect(takePending(file, 'sessionId')).toEqual([])
  })
})

describe('claimPending', () => {
  it('claims by rename, recovers orphaned batches, keeps late appends, drops only on done()', () => {
    const file = tmpState()
    queuePending(file, { sessionId: 'ses_a' })
    // an orphan left by a holder that died mid-batch
    writeFileSync(
      `${pendingQueuePath(file)}.claimed.999.1`,
      JSON.stringify({ sessionId: 'ses_z' }) + '\n',
    )
    const claim = claimPending(file, 'sessionId')
    expect(claim.entries.map((e) => e.sessionId).sort()).toEqual(['ses_a', 'ses_z'])
    expect(claim.files.length).toBe(2)
    // an append that races the claim lands in a fresh queue file
    queuePending(file, { sessionId: 'ses_b' })
    expect(existsSync(pendingQueuePath(file))).toBe(true)
    // the holder failed (no done()) → nothing dropped: the next holder sees all three
    const again = claimPending(file, 'sessionId')
    expect(again.entries.map((e) => e.sessionId).sort()).toEqual(['ses_a', 'ses_b', 'ses_z'])
    again.done()
    expect(existsSync(pendingQueuePath(file))).toBe(false)
    expect(claimPending(file, 'sessionId').entries).toEqual([])
  })
})

describe('parseDelayMs', () => {
  it('parses, bounds and defaults', () => {
    expect(parseDelayMs(['--ingest-session', 'x'])).toBe(0)
    expect(parseDelayMs(['--ingest-session', 'x', '--delay-ms', '1500'])).toBe(1500)
    expect(parseDelayMs(['--delay-ms', '-5'])).toBe(0)
    expect(parseDelayMs(['--delay-ms', '999999'])).toBe(60000)
  })
})
