/**
 * Hook worker: deadline, spool retain/retry/drop. Ingest is injected — no DB.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  armWorkerDeadline,
  ingestSpoolFile,
  runWorker,
  spoolAttempt,
  sweepStaleSpools,
  withSpoolAttempt,
  DEFAULT_WORKER_DEADLINE_MS,
} from './hooks.js'

const tmpDirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rivetos-hook-spool-'))
  tmpDirs.push(d)
  return d
}

function writeSpool(dir: string, name: string, payload: Record<string, unknown>): string {
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(payload))
  return file
}

const promptPayload = {
  hook_event_name: 'UserPromptSubmit',
  session_id: 'sess-1',
  prompt: 'hello',
}

describe('spoolAttempt / withSpoolAttempt', () => {
  it('reads the attempt counter from the filename and bumps it', () => {
    expect(spoolAttempt('/tmp/x.a1.json')).toBe(1)
    expect(spoolAttempt('/tmp/x.a3.json')).toBe(3)
    expect(spoolAttempt('/tmp/legacy.json')).toBe(1)
    expect(withSpoolAttempt('/tmp/x.a1.json', 2)).toBe('/tmp/x.a2.json')
  })
})

describe('armWorkerDeadline', () => {
  it('invokes the process-exit path and closes clients when the deadline fires', async () => {
    vi.useFakeTimers()
    const exit = vi.fn()
    const close = vi.fn(async () => undefined)
    armWorkerDeadline({ ms: DEFAULT_WORKER_DEADLINE_MS, exit, close, closeTimeoutMs: 0 })
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DEFAULT_WORKER_DEADLINE_MS)
    expect(close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('does not exit if cancelled before expiry', async () => {
    vi.useFakeTimers()
    const exit = vi.fn()
    const close = vi.fn(async () => undefined)
    const wd = armWorkerDeadline({ ms: 5_000, exit, close, closeTimeoutMs: 0 })
    wd.cancel()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(exit).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })
})

describe('ingestSpoolFile', () => {
  it('removes the spool after a successful ingest', async () => {
    const dir = tempDir()
    const file = writeSpool(dir, 'ok.a1.json', promptPayload)
    await ingestSpoolFile(file, {
      ingestHookEvent: async () => ({
        sessionKey: 'k',
        conversationId: 'c',
        created: true,
        inserted: 1,
      }),
      log: () => undefined,
    })
    expect(existsSync(file)).toBe(false)
  })

  it('retains the spool (bumped attempt) when ingest fails', async () => {
    const dir = tempDir()
    const file = writeSpool(dir, 'fail.a1.json', promptPayload)
    await ingestSpoolFile(file, {
      ingestHookEvent: async () => {
        throw new Error('db down')
      },
      log: () => undefined,
      maxAttempts: 5,
    })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(dir, 'fail.a2.json'))).toBe(true)
  })

  it('drops a poison spool after N attempts', async () => {
    const dir = tempDir()
    const file = writeSpool(dir, 'poison.a2.json', promptPayload)
    await ingestSpoolFile(file, {
      ingestHookEvent: async () => {
        throw new Error('still bad')
      },
      log: () => undefined,
      maxAttempts: 2,
    })
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toEqual([])
  })
})

describe('sweepStaleSpools', () => {
  it('retries a stale spool then drops it after N attempts', async () => {
    const dir = tempDir()
    const file = writeSpool(dir, 'stale.a1.json', promptPayload)
    const old = new Date(Date.now() - 200_000)
    utimesSync(file, old, old)

    let calls = 0
    const fail = async () => {
      calls++
      throw new Error('poison')
    }

    await sweepStaleSpools({
      spoolDir: dir,
      deadlineMs: 120_000,
      maxAttempts: 3,
      ingestHookEvent: fail,
      log: () => undefined,
      now: () => Date.now(),
    })
    expect(calls).toBe(1)
    const afterFirst = readdirSync(dir).filter((n) => n.endsWith('.json'))
    expect(afterFirst).toEqual(['stale.a2.json'])

    const next = join(dir, 'stale.a2.json')
    utimesSync(next, old, old)
    await sweepStaleSpools({
      spoolDir: dir,
      deadlineMs: 120_000,
      maxAttempts: 3,
      ingestHookEvent: fail,
      log: () => undefined,
    })
    utimesSync(join(dir, 'stale.a3.json'), old, old)
    await sweepStaleSpools({
      spoolDir: dir,
      deadlineMs: 120_000,
      maxAttempts: 3,
      ingestHookEvent: fail,
      log: () => undefined,
    })
    expect(calls).toBe(3)
    expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toEqual([])
  })

  it('does not retry a fresh spool', async () => {
    const dir = tempDir()
    writeSpool(dir, 'fresh.a1.json', promptPayload)
    let calls = 0
    await sweepStaleSpools({
      spoolDir: dir,
      deadlineMs: 120_000,
      ingestHookEvent: async () => {
        calls++
        return { sessionKey: 'k', conversationId: 'c', created: true, inserted: 1 }
      },
      log: () => undefined,
    })
    expect(calls).toBe(0)
    expect(existsSync(join(dir, 'fresh.a1.json'))).toBe(true)
  })
})

describe('runWorker', () => {
  it('processes the assigned spool then sweeps stale leftovers', async () => {
    const dir = tempDir()
    const assigned = writeSpool(dir, 'assigned.a1.json', promptPayload)
    const stale = writeSpool(dir, 'old.a1.json', promptPayload)
    const old = new Date(Date.now() - 200_000)
    utimesSync(stale, old, old)
    const seen: string[] = []
    await runWorker(assigned, {
      spoolDir: dir,
      deadlineMs: 120_000,
      ingestHookEvent: async () => {
        seen.push('ok')
        return { sessionKey: 'k', conversationId: 'c', created: true, inserted: 1 }
      },
      log: () => undefined,
    })
    expect(seen.length).toBe(2)
    expect(existsSync(assigned)).toBe(false)
    expect(existsSync(stale)).toBe(false)
  })
})
