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
  apiKeySourceAllowed,
  ClaudeCliTimeoutError,
  KILL_GRACE_MS,
  parseAllowedApiKeySources,
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

  it('signals the whole process group when it leads one, and sweeps it on exit (#1053)', () => {
    const { child, sent } = makeFakeChild()
    const group: Array<[number, NodeJS.Signals]> = []
    let spawnOpts: { detached?: boolean } | undefined
    const turn = spawnClaudeTurn(FLAGS, 'hi', {
      spawn: ((_bin: string, _args: string[], o: { detached?: boolean }) => {
        spawnOpts = o
        return child
      }) as unknown as SpawnFn,
      killGroup: (pid, signal) => {
        group.push([pid, signal])
      },
    })
    live.push(turn)
    // its own group, so MCP servers and tool shells die with it
    expect(spawnOpts?.detached).toBe(process.platform !== 'win32')
    turn.kill()
    expect(group).toEqual([[4242, 'SIGTERM']])
    expect(sent).toEqual([]) // not a pid-only kill
    // The CLI exits on SIGTERM; a child of its that ignored it is swept right away.
    simulateExit(child, null, 'SIGTERM')
    expect(group).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL'],
    ])
  })

  it('falls back to the pid when the group cannot be signalled', () => {
    const { child, sent } = makeFakeChild()
    const turn = spawnClaudeTurn(FLAGS, 'hi', {
      spawn: (() => child) as unknown as SpawnFn,
      killGroup: () => {
        throw new Error('ESRCH')
      },
    })
    live.push(turn)
    turn.kill()
    expect(sent).toEqual(['SIGTERM'])
    simulateExit(child, null, 'SIGTERM')
  })

  it('never group-signals a fake child when only spawn is injected', () => {
    const { turn, child, sent } = spawnFakeChild()
    live.push(turn)
    turn.kill()
    expect(sent).toEqual(['SIGTERM'])
    simulateExit(child, null, 'SIGTERM')
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

describe('apiKeySourceAllowed', () => {
  it('allows a missing source and "none" with no list', () => {
    expect(apiKeySourceAllowed(undefined, undefined)).toBe(true)
    expect(apiKeySourceAllowed('', undefined)).toBe(true)
    expect(apiKeySourceAllowed('none', undefined)).toBe(true)
    expect(apiKeySourceAllowed('apiKeyHelper', undefined)).toBe(false)
    expect(apiKeySourceAllowed('apiKeyHelper', [])).toBe(false)
  })

  it('allows only an exact listed name', () => {
    expect(apiKeySourceAllowed('apiKeyHelper', ['apiKeyHelper'])).toBe(true)
    expect(apiKeySourceAllowed('other', ['apiKeyHelper'])).toBe(false)
    expect(apiKeySourceAllowed('none', ['other'])).toBe(true)
  })
})

describe('parseAllowedApiKeySources', () => {
  it('returns the list when every entry is a non-empty string', () => {
    expect(parseAllowedApiKeySources(undefined)).toBeUndefined()
    expect(parseAllowedApiKeySources(null)).toBeUndefined()
    expect(parseAllowedApiKeySources(['apiKeyHelper'])).toEqual(['apiKeyHelper'])
    expect(parseAllowedApiKeySources([])).toEqual([])
  })

  it('returns undefined on a bad shape so the gate stays closed', () => {
    expect(parseAllowedApiKeySources('apiKeyHelper')).toBeUndefined()
    expect(parseAllowedApiKeySources([''])).toBeUndefined()
    expect(parseAllowedApiKeySources([1])).toBeUndefined()
    expect(parseAllowedApiKeySources(['apiKeyHelper', ''])).toBeUndefined()
  })
})

describe('spawnClaudeTurn process group (real process)', () => {
  it.skipIf(process.platform === 'win32')(
    "a kill takes the CLI's own children with it (#1053)",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-group-'))
      dirs.push(dir)
      const pidFile = path.join(dir, 'child.pid')
      // Stands in for the CLI: starts a long-lived child (an MCP server, a
      // tool shell), then waits on it.
      const turn = spawnFake(
        `#!/usr/bin/env bash\nsleep 300 &\necho $! > ${pidFile}\ncat > /dev/null\nwait\n`,
      )
      const until = async (cond: () => boolean): Promise<void> => {
        const end = Date.now() + 5_000
        while (!cond()) {
          if (Date.now() > end) throw new Error('condition not met within 5s')
          await new Promise((r) => setTimeout(r, 20))
        }
      }
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '')
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim())
      const alive = (): boolean => {
        try {
          process.kill(grandchild, 0)
          return true
        } catch {
          return false
        }
      }
      expect(alive()).toBe(true)
      turn.kill()
      await until(() => !alive())
    },
  )
})
