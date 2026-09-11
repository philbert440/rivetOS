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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeCliTimeoutError,
  KILL_GRACE_MS,
  spawnClaudeTurn,
} from './spawn-turn.js'

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

function spawnFake(body: string, opts?: { timeoutMs?: number }) {
  return spawnClaudeTurn(
    {
      binary: fakeScript(body),
      modelId: '',
      toolsArg: '',
      effort: 'low',
      permissionMode: 'default',
      excludeDynamicSections: false,
      systemText: '',
    },
    'hi',
    opts,
  )
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

const SLEEP = '#!/usr/bin/env bash\ncat > /dev/null\nexec sleep 60\n'
const IGNORE_TERM = "#!/usr/bin/env bash\ntrap '' TERM\ncat > /dev/null\nsleep 60\n"

describe('spawnClaudeTurn timeout_ms', () => {
  const live: ReturnType<typeof spawnClaudeTurn>[] = []

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const t of live.splice(0)) t.kill()
  })

  it('does not arm a timer when timeoutMs is 0 or omitted', async () => {
    const turn = spawnFake(SLEEP, { timeoutMs: 0 })
    live.push(turn)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(turn.proc.exitCode).toBeNull()
    expect(turn.proc.signalCode).toBeNull()
  })

  it('rejects the event iterator with a timeout error after timeoutMs', async () => {
    const timeoutMs = 1_000
    const turn = spawnFake(SLEEP, { timeoutMs })
    live.push(turn)
    const iterating = (async () => {
      for await (const _ of turn.events()) {
        /* drain */
      }
    })()
    await vi.advanceTimersByTimeAsync(timeoutMs)
    await expect(iterating).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ClaudeCliTimeoutError &&
        err.code === 'timeout' &&
        err.timeoutMs === timeoutMs &&
        err.message === `claude-cli spawn timed out after ${timeoutMs}ms`
      )
    })
  })

  it('SIGKILLs after KILL_GRACE_MS when SIGTERM is ignored', async () => {
    const timeoutMs = 500
    const turn = spawnFake(IGNORE_TERM, { timeoutMs })
    live.push(turn)
    const iterating = (async () => {
      for await (const _ of turn.events()) {
        /* drain */
      }
    })()
    await vi.advanceTimersByTimeAsync(timeoutMs)
    expect(turn.proc.signalCode).toBeNull()
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
    await expect(iterating).rejects.toBeInstanceOf(ClaudeCliTimeoutError)
    expect(turn.proc.signalCode).toBe('SIGKILL')
  })
})
