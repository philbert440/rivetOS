/**
 * OpenCode rivet-memory plugin tests.
 *
 * Fires session.idle twice inside the debounce window and once after, and
 * asserts spawn count/args. Tests must be able to fail.
 *
 * Run: npx vitest run plugin/test/plugin.test.ts
 * (from integrations/opencode/rivet-memory). Skipped in this session — no shell.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    on: vi.fn(),
    exitCode: 0,
    killed: false,
  })),
}))

vi.mock('node:child_process', () => ({ spawn }))

import { DEBOUNCE_MS, RivetMemory } from '../rivet-memory.ts'

const SESSION = 'ses_abcdefghijklmnopqrstuvwxyz'
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_SRC = path.join(PLUGIN_DIR, '..', 'rivet-memory.ts')

describe('RivetMemory plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawn.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces session.idle: two fires in-window spawn once; one after spawns again', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })

    await plugin.event({
      event: { type: 'session.idle', properties: { sessionID: SESSION } },
    })
    await plugin.event({
      event: { type: 'session.idle', properties: { sessionID: SESSION } },
    })

    expect(spawn).toHaveBeenCalledTimes(0)

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(spawn).toHaveBeenCalledTimes(1)

    await plugin.event({
      event: { type: 'session.idle', properties: { sessionID: SESSION } },
    })
    expect(spawn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(spawn).toHaveBeenCalledTimes(2)

    for (const call of spawn.mock.calls) {
      expect(call[0]).toBe('bash')
      expect(call[1]).toEqual([
        expect.stringContaining('bin/opencode-memory-capture.sh'),
        '--ingest-session',
        SESSION,
      ])
      expect(call[2]).toMatchObject({
        stdio: 'ignore',
        detached: true,
      })
    }
  })

  it('ingests immediately on session.compacted / session.deleted / session.error', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })

    await plugin.event({
      event: { type: 'session.compacted', properties: { sessionID: SESSION } },
    })
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

  it('ignores message.* events', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { sessionID: SESSION },
      },
    })
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: { sessionID: SESSION },
      },
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)
    expect(spawn).toHaveBeenCalledTimes(0)
  })

  it('does not throw on malformed events', async () => {
    const plugin = await RivetMemory({ directory: '/tmp' })
    await expect(plugin.event({ event: {} })).resolves.toBeUndefined()
    await expect(plugin.event({ event: { type: 'session.idle' } })).resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledTimes(0)
  })

  it('plugin source is well-formed for setup rewrite', () => {
    const src = readFileSync(PLUGIN_SRC, 'utf8')
    expect(src).toMatch(/export const RivetMemory = async/)
    expect(src).toMatch(/const PLUGIN_PATH = "[^"]+"/)
    expect(src).toContain("from 'node:child_process'")
    expect(src).toContain("from 'node:path'")
    expect(src).not.toMatch(/from ['"]node:fs['"]/)
    expect(src).toContain('session.idle')
    expect(src).toContain('session.compacted')
    expect(src).toContain('--ingest-session')
  })
})
