/**
 * spawn-turn tests — the child-exit latch.
 *
 * `waitExit()` used to attach its `close` listener on demand and shortcut on
 * `proc.exitCode !== null`. Both halves miss a real terminal state: a child
 * that closed before the first call never re-emits `close`, and a child killed
 * by a signal leaves `exitCode` null forever. Either way the promise never
 * settles, and the executor's `result` — which must resolve on every terminal
 * path — hangs with it. These pin the latch that replaced it.
 */

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeCliTimeoutError,
  KILL_GRACE_MS,
  spawnClaudeTurn,
} from './spawn-turn.js'

type SpawnFn = typeof import('node:child_process').spawn

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  killed: boolean
  kill: (signal?: NodeJS.Signals | number) => boolean
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

/** A throwaway executable standing in for the claude binary. */
function fakeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spawn-'))
  dirs.push(dir)
  const file = path.join(dir, 'claude')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}

const FLAGS = {
  binary: 'claude',
  modelId: '',
  toolsArg: '',
  effort: 'low' as const,
  permissionMode: 'default',
  excludeDynamicSections: false,
  systemText: '',
}

function spawnFake(body: string, opts?: { timeoutMs?: number }) {
  return spawnClaudeTurn({ ...FLAGS, binary: fakeScript(body) }, 'hi', opts)
}

function makeFakeChild(): { child: FakeChild; sent: Array<NodeJS.Signals | number | undefined> } {
  const sent: Array<NodeJS.Signals | number | undefined> = []
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.killed = false
  child.kill = (signal?: NodeJS.Signals | number) => {
    sent.push(signal)
    child.killed = true
    return true
  }
  return { child, sent }
}

function simulateExit(
  child: FakeChild,
  code: number | null = null,
  signal: NodeJS.Signals | null = 'SIGTERM',
): void {
  child.exitCode = code
  child.signalCode = signal
  if (!child.stdout.writableEnded) child.stdout.end()
  if (!child.stderr.writableEnded) child.stderr.end()
  child.emit('exit', code, signal)
  child.emit('close', code, signal)
}

function spawnFakeChild(opts?: { timeoutMs?: number }) {
  const { child, sent } = makeFakeChild()
  const turn = spawnClaudeTurn(FLAGS, 'hi', {
    ...opts,
    spawn: (() => child) as unknown as SpawnFn,
  })
  return { turn, child, sent }
}

describe('spawnClaudeTurn waitExit', () => {
  it('resolves after a signal death whose close already fired', async () => {
    const turn = spawnFake('#!/usr/bin/env bash\ncat > /dev/null\nexec sleep 60\n')
    turn.kill()
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    // The discriminating case: a signalled child leaves `proc.exitCode` null
    // forever, so the old "already exited" shortcut never fired — and `close`
    // is spent, so an attach-on-demand listener never fired either.
    await expect(turn.waitExit()).resolves.toBeNull()
  })

  it('resolves when the child closed BEFORE the first waitExit() call', async () => {
    const turn = spawnFake('#!/usr/bin/env bash\ncat > /dev/null\nexit 7\n')
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    await expect(turn.waitExit()).resolves.toBe(7)
  })

  it('answers every concurrent caller', async () => {
    const turn = spawnFake('#!/usr/bin/env bash\ncat > /dev/null\nexit 0\n')
    await expect(Promise.all([turn.waitExit(), turn.waitExit()])).resolves.toEqual([0, 0])
  })
})

describe('spawnClaudeTurn timeout_ms', () => {
  const live: ReturnType<typeof spawnClaudeTurn>[] = []

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    for (const t of live.splice(0)) t.kill()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not arm a timer when timeoutMs is 0 or omitted', async () => {
    const { turn, sent } = spawnFakeChild({ timeoutMs: 0 })
    live.push(turn)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toEqual([])
    expect(turn.proc.exitCode).toBeNull()
    expect(turn.proc.signalCode).toBeNull()
  })

  it('SIGTERM then clears the SIGKILL timer when the child exits', async () => {
    const timeoutMs = 1_000
    const { turn, child, sent } = spawnFakeChild({ timeoutMs })
    live.push(turn)
    const iterating = (async () => {
      for await (const _ of turn.events()) {
        /* drain */
      }
    })()
    const rejected = expect(iterating).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ClaudeCliTimeoutError &&
        err.code === 'timeout' &&
        err.timeoutMs === timeoutMs &&
        err.message === `claude-cli spawn timed out after ${timeoutMs}ms`
      )
    })
    await vi.advanceTimersByTimeAsync(timeoutMs)
    expect(sent).toEqual(['SIGTERM'])
    simulateExit(child, null, 'SIGTERM')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
    expect(sent).toEqual(['SIGTERM'])
    await rejected
  })

  it('rejects the iterator when the child ignores kill and stdout stays open', async () => {
    const timeoutMs = 1_000
    const { turn, sent } = spawnFakeChild({ timeoutMs })
    live.push(turn)
    const iterating = (async () => {
      for await (const _ of turn.events()) {
        /* drain */
      }
    })()
    const rejected = expect(iterating).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ClaudeCliTimeoutError &&
        err.code === 'timeout' &&
        err.timeoutMs === timeoutMs &&
        err.message === `claude-cli spawn timed out after ${timeoutMs}ms`
      )
    })
    await vi.advanceTimersByTimeAsync(timeoutMs)
    expect(sent).toEqual(['SIGTERM'])
    expect(turn.proc.exitCode).toBeNull()
    expect(turn.proc.signalCode).toBeNull()
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
    expect(sent).toEqual(['SIGTERM', 'SIGKILL'])
    // stdout never ends; iterator must still reject from the terminate latch.
    await rejected
  })

  it('SIGKILLs after KILL_GRACE_MS when SIGTERM is ignored', async () => {
    const timeoutMs = 500
    const { turn, child, sent } = spawnFakeChild({ timeoutMs })
    live.push(turn)
    const iterating = (async () => {
      for await (const _ of turn.events()) {
        /* drain */
      }
    })()
    const rejected = expect(iterating).rejects.toBeInstanceOf(ClaudeCliTimeoutError)
    await vi.advanceTimersByTimeAsync(timeoutMs)
    expect(sent).toEqual(['SIGTERM'])
    expect(turn.proc.signalCode).toBeNull()
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
    expect(sent).toEqual(['SIGTERM', 'SIGKILL'])
    simulateExit(child, null, 'SIGKILL')
    await rejected
  })
})
