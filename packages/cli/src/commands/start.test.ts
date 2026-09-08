import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boot = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveEmbeddedPg: vi.fn(),
  acquireEmbeddedPg: vi.fn(),
  applyEmbeddedPgUrl: vi.fn(),
  migrateEmbedded: vi.fn(),
  readEmbeddedPgLock: vi.fn(),
  embeddedPgLockAlive: vi.fn(),
  boot: vi.fn(),
}))

const spawnMock = vi.hoisted(() => vi.fn())
const resolveScript = vi.hoisted(() => vi.fn(() => '/fake/migrate.js'))

vi.mock('@rivetos/boot', () => boot)
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('../paths.js', () => ({ resolveMemoryMigrateScript: resolveScript }))

import { runMigrate } from './start.js'

const PGURL = 'postgres://postgres:postgres@127.0.0.1:5433/postgres'
const CONFIG = { memory: { postgres: { embedded: {} } } }
const RESOLVED = {
  dataDir: '/tmp/pglite',
  port: 5433,
  autoMigrate: true,
  maxConnections: 96,
  pgUrl: PGURL,
  liteMode: true,
}
const CONFIG_PATH = '/tmp/rivetos-test-config.yaml'

function fakeChild(code = 0): EventEmitter {
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('exit', code))
  return child
}

function closeHandle(owned: boolean): { pgUrl: string; owned: boolean; close: ReturnType<typeof vi.fn> } {
  return {
    pgUrl: PGURL,
    owned,
    close: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  boot.loadConfig.mockReset().mockResolvedValue(CONFIG)
  boot.resolveEmbeddedPg.mockReset().mockReturnValue(RESOLVED)
  boot.acquireEmbeddedPg.mockReset()
  boot.applyEmbeddedPgUrl.mockReset()
  boot.migrateEmbedded.mockReset().mockResolvedValue(undefined)
  spawnMock.mockReset().mockImplementation(() => fakeChild(0))
  resolveScript.mockReturnValue('/fake/migrate.js')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('runMigrate embedded', () => {
  it('acquire → apply → in-process migrateEmbedded → close when owned', async () => {
    const handle = closeHandle(true)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)

    await runMigrate(CONFIG_PATH)

    expect(boot.acquireEmbeddedPg).toHaveBeenCalled()
    expect(boot.applyEmbeddedPgUrl).toHaveBeenCalledWith(CONFIG, PGURL)
    expect(boot.migrateEmbedded).toHaveBeenCalledWith(PGURL)
    expect(handle.close).toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()

    const acquireAt = boot.acquireEmbeddedPg.mock.invocationCallOrder[0]
    const applyAt = boot.applyEmbeddedPgUrl.mock.invocationCallOrder[0]
    const migrateAt = boot.migrateEmbedded.mock.invocationCallOrder[0]
    const closeAt = handle.close.mock.invocationCallOrder[0]
    expect(acquireAt).toBeLessThan(applyAt)
    expect(applyAt).toBeLessThan(migrateAt)
    expect(migrateAt).toBeLessThan(closeAt)
  })

  it('acquire → apply → async spawn (not migrateEmbedded) → close when attaching', async () => {
    const handle = closeHandle(false)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)

    await runMigrate(CONFIG_PATH)

    expect(boot.migrateEmbedded).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalled()
    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv
    expect(env.RIVETOS_PG_URL).toBe(PGURL)
    expect(handle.close).toHaveBeenCalled()

    const acquireAt = boot.acquireEmbeddedPg.mock.invocationCallOrder[0]
    const applyAt = boot.applyEmbeddedPgUrl.mock.invocationCallOrder[0]
    const spawnAt = spawnMock.mock.invocationCallOrder[0]
    const closeAt = handle.close.mock.invocationCallOrder[0]
    expect(acquireAt).toBeLessThan(applyAt)
    expect(applyAt).toBeLessThan(spawnAt)
    expect(spawnAt).toBeLessThan(closeAt)
  })

  it('still closes when in-process migrate throws', async () => {
    const handle = closeHandle(true)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)
    boot.migrateEmbedded.mockRejectedValue(new Error('boom'))

    await expect(runMigrate(CONFIG_PATH)).rejects.toThrow('boom')
    expect(handle.close).toHaveBeenCalled()
  })
})

describe('runMigrate non-embedded', () => {
  it('spawns the migrator without acquire when embedded is not configured', async () => {
    boot.resolveEmbeddedPg.mockReturnValue(undefined)

    await runMigrate(CONFIG_PATH)

    expect(boot.acquireEmbeddedPg).not.toHaveBeenCalled()
    expect(boot.migrateEmbedded).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalled()
  })
})
