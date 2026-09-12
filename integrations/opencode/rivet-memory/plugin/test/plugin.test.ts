/**
 * OpenCode rivet-memory plugin tests.
 *
 * Terminal events must spawn the ingester synchronously (before the handler
 * resolves) — a short-lived `opencode run` exits right after session.idle, so
 * any parent-side timer would be lost. Tests must be able to fail.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn(), exitCode: null, killed: false })),
}))

vi.mock('node:child_process', () => ({ spawn }))

import * as pluginModule from '../rivet-memory.ts'
import { RivetMemory } from '../rivet-memory.ts'

const SESSION = 'ses_abcdefghijklmnopqrstuvwxyz'
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_SRC = path.join(PLUGIN_DIR, '..', 'rivet-memory.ts')

function idle(sessionID = SESSION) {
  return { event: { type: 'session.idle', properties: { sessionID } } }
}

describe('RivetMemory plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawn.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('exports only plugin functions (OpenCode rejects any other export value)', () => {
    const values = Object.values(pluginModule)
    expect(values.length).toBeGreaterThan(0)
    for (const v of values) expect(typeof v).toBe('function')
  })

  it('spawns the ingester synchronously on session.idle, before the handler resolves', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })
    const pending = plugin.event(idle())
    expect(spawn).toHaveBeenCalledTimes(1)
    await pending
    const [cmd, args, opts] = spawn.mock.calls[0]
    expect(cmd).toBe('bash')
    expect(args).toEqual([
      expect.stringContaining('bin/opencode-memory-capture.sh'),
      '--ingest-session',
      SESSION,
      '--delay-ms',
      '1500',
    ])
    expect(opts).toMatchObject({ stdio: 'ignore', detached: true })
    expect(spawn.mock.results[0].value.unref).toHaveBeenCalled()
  })

  it('rate-limits identical events inside 200 ms, spawns again after', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })
    await plugin.event(idle())
    await vi.advanceTimersByTimeAsync(50)
    await plugin.event(idle())
    expect(spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)
    await plugin.event(idle())
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('a still-running child never suppresses a new spawn', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })
    await plugin.event(idle())
    await vi.advanceTimersByTimeAsync(1000)
    // first child has exitCode null (running) — the next idle must still spawn
    await plugin.event(idle())
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('attaches an error listener so an asynchronous spawn error cannot throw into opencode', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })
    await plugin.event(idle())
    const child = spawn.mock.results[0].value as { on: ReturnType<typeof vi.fn> }
    const errorCalls = child.on.mock.calls.filter((c: unknown[]) => c[0] === 'error')
    expect(errorCalls.length).toBe(1)
    const handler = errorCalls[0][1] as (err: Error) => void
    expect(() => handler(new Error('spawn bash ENOENT'))).not.toThrow()
  })

  it('spawns immediately on session.compacted / session.deleted / session.error', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })
    await plugin.event({ event: { type: 'session.compacted', properties: { sessionID: SESSION } } })
    await plugin.event({
      event: { type: 'session.deleted', properties: { sessionID: 'ses_deleted0000000000000001' } },
    })
    await plugin.event({
      event: { type: 'session.error', properties: { sessionID: 'ses_error000000000000000001' } },
    })
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(spawn.mock.calls[0][1]?.[2]).toBe(SESSION)
    expect(spawn.mock.calls[1][1]?.[2]).toBe('ses_deleted0000000000000001')
    expect(spawn.mock.calls[2][1]?.[2]).toBe('ses_error000000000000000001')
  })

  it('ignores message.* and non-terminal session events', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })
    for (const type of [
      'message.updated',
      'message.part.updated',
      'session.updated',
      'session.status',
    ]) {
      await plugin.event({ event: { type, properties: { sessionID: SESSION } } })
    }
    await vi.advanceTimersByTimeAsync(5000)
    expect(spawn).toHaveBeenCalledTimes(0)
  })

  it('does not throw on malformed events', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })
    await expect(plugin.event({ event: {} })).resolves.toBeUndefined()
    await expect(plugin.event({ event: { type: 'session.idle' } })).resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledTimes(0)
  })

  it('plugin source is well-formed for the setup rewrite and Bun', () => {
    const src = readFileSync(PLUGIN_SRC, 'utf8')
    expect(src).toMatch(/export const RivetMemory = async/)
    expect(src).toMatch(/const PLUGIN_PATH = '[^']+'/)
    expect(src).toContain("from 'node:child_process'")
    expect(src).toContain("from 'node:path'")
    expect(src).not.toMatch(/from ['"]node:fs['"]/)
    expect(src).not.toMatch(/export const [A-Z_]+ = \d/)
    expect(src).toContain('session.idle')
    expect(src).toContain('--ingest-session')
  })
})
