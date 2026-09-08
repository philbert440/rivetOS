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
}))

const spawnMock = vi.hoisted(() => vi.fn())
const resolveScript = vi.hoisted(() => vi.fn(() => '/fake/migrate.js'))
const pg = vi.hoisted(() => {
  const connect = vi.fn().mockResolvedValue(undefined)
  const end = vi.fn().mockResolvedValue(undefined)
  const query = vi.fn()
  // `new Client()` in db.ts — a mock constructor must be a real function, not an arrow.
  const Client = vi.fn().mockImplementation(function ClientMock() {
    return { connect, query, end }
  })
  return { connect, end, query, Client }
})

vi.mock('@rivetos/boot', () => boot)
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('../paths.js', () => ({ resolveMemoryMigrateScript: resolveScript }))
vi.mock('pg', () => ({ default: { Client: pg.Client } }))

import { runDbMigrate, runDbStatus } from './db.js'

const PGURL = 'postgres://postgres:postgres@127.0.0.1:5433/postgres'
const CONFIG = { memory: { postgres: { embedded: {} } } }
const RESOLVED = {
  dataDir: '/tmp/pglite-db-status',
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
  boot.readEmbeddedPgLock.mockReset().mockReturnValue({ pid: 4242, port: 5433, startedAt: '2026-01-01' })
  boot.embeddedPgLockAlive.mockReset().mockReturnValue(true)
  spawnMock.mockReset().mockImplementation(() => fakeChild(0))
  resolveScript.mockReturnValue('/fake/migrate.js')
  pg.connect.mockReset().mockResolvedValue(undefined)
  pg.end.mockReset().mockResolvedValue(undefined)
  pg.query.mockReset()
  pg.Client.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('runDbMigrate embedded', () => {
  it('acquire → apply → migrateEmbedded → close when owned', async () => {
    const handle = closeHandle(true)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)

    await runDbMigrate([], CONFIG_PATH)

    expect(boot.acquireEmbeddedPg).toHaveBeenCalled()
    expect(boot.applyEmbeddedPgUrl).toHaveBeenCalledWith(CONFIG, PGURL)
    expect(boot.migrateEmbedded).toHaveBeenCalledWith(PGURL)
    expect(handle.close).toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()

    expect(boot.acquireEmbeddedPg.mock.invocationCallOrder[0]).toBeLessThan(
      boot.applyEmbeddedPgUrl.mock.invocationCallOrder[0],
    )
    expect(boot.applyEmbeddedPgUrl.mock.invocationCallOrder[0]).toBeLessThan(
      boot.migrateEmbedded.mock.invocationCallOrder[0],
    )
    expect(boot.migrateEmbedded.mock.invocationCallOrder[0]).toBeLessThan(
      handle.close.mock.invocationCallOrder[0],
    )
  })

  it('acquire → apply → async spawn → close when attaching', async () => {
    const handle = closeHandle(false)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)

    await runDbMigrate(['--url', 'ignored'], CONFIG_PATH)

    expect(boot.migrateEmbedded).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalled()
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['/fake/migrate.js', '--url', 'ignored'])
    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv
    expect(env.RIVETOS_PG_URL).toBe(PGURL)
    expect(handle.close).toHaveBeenCalled()
  })
})

describe('runDbMigrate non-embedded', () => {
  it('spawns the migrator without acquire', async () => {
    boot.resolveEmbeddedPg.mockReturnValue(undefined)

    await runDbMigrate([], CONFIG_PATH)

    expect(boot.acquireEmbeddedPg).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalled()
  })
})

describe('runDbStatus embedded', () => {
  it('prints data dir, size, owner, port, and applied count after acquire/apply/close', async () => {
    const handle = closeHandle(false)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)
    pg.query
      .mockResolvedValueOnce({ rows: [{ reg: '_rivetos_migrations' }] })
      .mockResolvedValueOnce({
        rows: [{ name: '0001_init.sql', applied_at: new Date('2026-01-01T00:00:00Z') }],
      })

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      lines.push(String(msg ?? ''))
    })

    await runDbStatus(CONFIG_PATH)
    spy.mockRestore()

    const text = lines.join('\n')
    expect(text).toContain('[db status] embedded PGlite')
    expect(text).toContain('data_dir: /tmp/pglite-db-status')
    expect(text).toContain('owner_pid: 4242 (alive)')
    expect(text).toContain('port: 5433')
    expect(text).toContain('migrations_applied: 1')
    expect(text).toContain('0001_init.sql')
    expect(boot.applyEmbeddedPgUrl).toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalled()
    expect(boot.acquireEmbeddedPg.mock.invocationCallOrder[0]).toBeLessThan(
      boot.applyEmbeddedPgUrl.mock.invocationCallOrder[0],
    )
    expect(boot.applyEmbeddedPgUrl.mock.invocationCallOrder[0]).toBeLessThan(
      handle.close.mock.invocationCallOrder[0],
    )
  })
})
