/**
 * Unit tests for the pi rivet-memory extension.
 *
 * Imports the extension with a fake `pi` that records on(event, handler)
 * registrations, fires turn_end / agent_end / session_shutdown, and asserts
 * a single debounced spawn per session file. node:child_process.spawn is
 * mocked — these tests must be able to fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import path from 'node:path'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

import rivetMemory from '../rivet-memory.ts'

const spawnMock = vi.mocked(spawn)

type Handler = (...args: unknown[]) => void

const SESSION_FILE =
  '/tmp/sessions/2026-09-11T14-25-16-803Z_01a091f5-6deb-723d-8737-eb83070c9154.jsonl'
const OTHER_FILE =
  '/tmp/sessions/2026-09-11T15-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
const EXPECTED_SCRIPT = path.join(
  '/opt/rivetos/integrations/pi/rivet-memory',
  'bin',
  'pi-memory-capture.sh',
)

function fakeChild(): {
  unref: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => void
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const child = {
    unref: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? []
      list.push(cb)
      listeners.set(event, list)
      return child
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of listeners.get(event) ?? []) cb(...args)
    },
  }
  return child
}

function install(sessionFile: string | null): {
  handlers: Map<string, Handler[]>
  ctx: { sessionManager: { getSessionFile: () => string | null; getSessionId: () => string } }
  fire: (event: string, payload?: unknown) => void
} {
  const handlers = new Map<string, Handler[]>()
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
  }
  rivetMemory(pi)
  const ctx = {
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => '01a091f5-6deb-723d-8737-eb83070c9154',
    },
  }
  const fire = (event: string, payload: unknown = {}): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx)
  }
  return { handlers, ctx, fire }
}

describe('rivet-memory pi extension', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeChild() as unknown as ReturnType<typeof spawn>)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers turn_end, agent_end, session_shutdown, session_before_switch, session_info_changed', () => {
    const { handlers } = install(SESSION_FILE)
    for (const event of [
      'turn_end',
      'agent_end',
      'session_shutdown',
      'session_before_switch',
      'session_info_changed',
    ]) {
      expect(handlers.get(event)?.length ?? 0, event).toBeGreaterThanOrEqual(1)
    }
  })

  it('coalesces turn_end + agent_end into a single spawn after 1.5s', async () => {
    const { fire } = install(SESSION_FILE)
    fire('turn_end', { turnIndex: 0 })
    fire('agent_end', { messages: [] })
    expect(spawnMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1499)
    expect(spawnMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'bash',
      [EXPECTED_SCRIPT, '--ingest-file', SESSION_FILE],
      expect.objectContaining({ stdio: 'ignore', detached: true }),
    )
    const opts = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }
    expect(opts.env).toBe(process.env)
  })

  it('turn_end + agent_end + session_shutdown flush to a single spawn (no extra after debounce)', async () => {
    const { fire } = install(SESSION_FILE)
    fire('turn_end', { turnIndex: 0 })
    fire('agent_end', { messages: [] })
    fire('session_shutdown', { reason: 'quit' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      EXPECTED_SCRIPT,
      '--ingest-file',
      SESSION_FILE,
    ])
  })

  it('session_info_changed and session_before_switch flush immediately', () => {
    const { fire } = install(SESSION_FILE)
    fire('session_info_changed', { name: 'renamed' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    spawnMock.mockClear()
    const { fire: fire2 } = install(OTHER_FILE)
    fire2('session_before_switch', {})
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      EXPECTED_SCRIPT,
      '--ingest-file',
      OTHER_FILE,
    ])
  })

  it('keeps one child at a time per file and drains pending on exit', () => {
    const first = fakeChild()
    spawnMock.mockImplementationOnce(() => first as unknown as ReturnType<typeof spawn>)
    const { fire } = install(SESSION_FILE)
    fire('session_shutdown', { reason: 'quit' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    fire('session_shutdown', { reason: 'quit' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const second = fakeChild()
    spawnMock.mockImplementationOnce(() => second as unknown as ReturnType<typeof spawn>)
    first.emit('exit', 0)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('tracks session files independently', async () => {
    const handlers = new Map<string, Handler[]>()
    const pi = {
      on: (event: string, handler: Handler) => {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
      },
    }
    rivetMemory(pi)
    const ctxA = {
      sessionManager: { getSessionFile: () => SESSION_FILE, getSessionId: () => 'a' },
    }
    const ctxB = {
      sessionManager: { getSessionFile: () => OTHER_FILE, getSessionId: () => 'b' },
    }
    for (const handler of handlers.get('session_shutdown') ?? []) {
      handler({ reason: 'quit' }, ctxA)
      handler({ reason: 'quit' }, ctxB)
    }
    expect(spawnMock).toHaveBeenCalledTimes(2)
    const files = spawnMock.mock.calls.map((c) => (c[1] as string[])[2])
    expect(files.sort()).toEqual([OTHER_FILE, SESSION_FILE].sort())
  })

  it('no-ops on ephemeral sessions (no session file)', async () => {
    const { fire } = install(null)
    fire('turn_end', { turnIndex: 0 })
    fire('agent_end', { messages: [] })
    fire('session_shutdown', { reason: 'quit' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not throw when pi.on throws during registration', () => {
    expect(() =>
      rivetMemory({
        on: () => {
          throw new Error('nope')
        },
      }),
    ).not.toThrow()
  })

  it('unref()s the detached child', () => {
    const child = fakeChild()
    spawnMock.mockImplementation(() => child as unknown as ReturnType<typeof spawn>)
    const { fire } = install(SESSION_FILE)
    fire('session_shutdown', { reason: 'quit' })
    expect(child.unref).toHaveBeenCalledTimes(1)
  })
})
