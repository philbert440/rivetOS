/**
 * State persistence under concurrent ingest processes: two writers that each
 * loaded a stale map must not lose each other's cursors, and a cursor never
 * moves backwards. The mkdir lock serializes ingests; the merge protects
 * an unlocked writer. Tests must be able to fail.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  emptyState,
  loadState,
  mergeState,
  saveState,
  parseDelayMs,
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

describe('parseDelayMs', () => {
  it('parses, bounds and defaults', () => {
    expect(parseDelayMs(['--ingest-session', 'x'])).toBe(0)
    expect(parseDelayMs(['--ingest-session', 'x', '--delay-ms', '1500'])).toBe(1500)
    expect(parseDelayMs(['--delay-ms', '-5'])).toBe(0)
    expect(parseDelayMs(['--delay-ms', '999999'])).toBe(60000)
  })
})
