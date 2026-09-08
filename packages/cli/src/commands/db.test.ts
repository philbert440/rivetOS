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
  resolveEnvVars: <T>(obj: T): T => obj,
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

import dbCommand, { runDbMigrate, runDbStatus, takeConfigFlag } from './db.js'

// Config port 5433 vs owner lock/handle port 5599 — Client + status must use the owner.
const CONFIG_PGURL = 'postgres://postgres:postgres@127.0.0.1:5433/postgres'
const OWNER_PGURL = 'postgres://postgres:postgres@127.0.0.1:5599/postgres'
const CONFIG = { memory: { postgres: { embedded: {} } } }
const RESOLVED = {
  dataDir: '/tmp/pglite-db-status',
  port: 5433,
  autoMigrate: true,
  maxConnections: 96,
  pgUrl: CONFIG_PGURL,
  liteMode: true,
}
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// A REAL file: the maintenance path reads config.yaml leniently (no schema validation) and only
// looks at memory.postgres.embedded — an unrelated invalid section must not block `db migrate`.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rivet-db-test-'))
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml')
writeFileSync(
  CONFIG_PATH,
  'memory:\n  postgres:\n    embedded: { port: 5433 }\nproviders:\n  bogus: { this_is: invalid }\n',
)

function fakeChild(code = 0): EventEmitter {
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('exit', code))
  return child
}

function closeHandle(owned: boolean): {
  pgUrl: string
  owned: boolean
  close: ReturnType<typeof vi.fn>
} {
  return {
    pgUrl: OWNER_PGURL,
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
  boot.readEmbeddedPgLock
    .mockReset()
    .mockReturnValue({ pid: 4242, port: 5599, startedAt: '2026-01-01' })
  boot.embeddedPgLockAlive.mockReset().mockReturnValue(true)
  spawnMock.mockReset().mockImplementation(() => fakeChild(0))
  resolveScript.mockReturnValue('/fake/migrate.js')
  pg.connect.mockReset().mockResolvedValue(undefined)
  pg.end.mockReset().mockResolvedValue(undefined)
  pg.query.mockReset()
  pg.Client.mockClear()
})

const ORIG_ARGV = process.argv

afterEach(() => {
  vi.clearAllMocks()
  process.argv = ORIG_ARGV
})

describe('runDbMigrate embedded', () => {
  it('acquire → apply → migrateEmbedded → close when owned', async () => {
    const handle = closeHandle(true)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)

    await runDbMigrate([], CONFIG_PATH)

    expect(boot.acquireEmbeddedPg).toHaveBeenCalled()
    expect(boot.applyEmbeddedPgUrl).toHaveBeenCalledWith(
      expect.objectContaining({ memory: expect.anything() }),
      OWNER_PGURL,
    )
    expect(boot.migrateEmbedded).toHaveBeenCalledWith(OWNER_PGURL)
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

    await runDbMigrate(['--dir', '/x/migrations'], CONFIG_PATH)

    expect(boot.migrateEmbedded).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalled()
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['/fake/migrate.js', '--dir', '/x/migrations'])
    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv
    expect(env.RIVETOS_PG_URL).toBe(OWNER_PGURL)
    expect(handle.close).toHaveBeenCalled()
    // order: acquire < apply < spawn < close
    expect(boot.acquireEmbeddedPg.mock.invocationCallOrder[0]).toBeLessThan(
      boot.applyEmbeddedPgUrl.mock.invocationCallOrder[0],
    )
    expect(boot.applyEmbeddedPgUrl.mock.invocationCallOrder[0]).toBeLessThan(
      spawnMock.mock.invocationCallOrder[0],
    )
    expect(spawnMock.mock.invocationCallOrder[0]).toBeLessThan(
      handle.close.mock.invocationCallOrder[0],
    )
    // lenient config read: the schema validator is never consulted for maintenance
    expect(boot.loadConfig).not.toHaveBeenCalled()
  })

  it('owned + runner arguments (--baseline) go through the real runner as an async child', async () => {
    const handle = closeHandle(true)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)

    await runDbMigrate(['--baseline'], CONFIG_PATH)

    expect(boot.migrateEmbedded).not.toHaveBeenCalled()
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['/fake/migrate.js', '--baseline'])
    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv
    expect(env.RIVETOS_PG_URL).toBe(OWNER_PGURL)
    expect(handle.close).toHaveBeenCalled()
  })

  it('--url targets an external database and never touches the embedded engine', async () => {
    await runDbMigrate(['--url', 'postgres://u:p@198.51.100.7:5432/other'], CONFIG_PATH)

    expect(boot.acquireEmbeddedPg).not.toHaveBeenCalled()
    expect(boot.migrateEmbedded).not.toHaveBeenCalled()
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      '/fake/migrate.js',
      '--url',
      'postgres://u:p@198.51.100.7:5432/other',
    ])
  })

  it('still closes when the migrator script is missing', async () => {
    const handle = closeHandle(false)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)
    resolveScript.mockReturnValueOnce('')

    await expect(runDbMigrate(['--dir', '/x'], CONFIG_PATH)).rejects.toThrow(/cannot locate/)
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
    expect(text).toContain('port: 5599')
    expect(text).not.toContain('port: 5433')
    expect(text).toContain('migrations_applied: 1')
    expect(text).toContain('0001_init.sql')
    // dials the handle's URL (the owner's port from the lock), not the config URL
    expect(handle.pgUrl).toBe(OWNER_PGURL)
    expect(pg.Client).toHaveBeenCalledWith({ connectionString: OWNER_PGURL })
    expect(pg.Client).not.toHaveBeenCalledWith({ connectionString: CONFIG_PGURL })
    expect(boot.applyEmbeddedPgUrl).toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalled()
    expect(boot.acquireEmbeddedPg.mock.invocationCallOrder[0]).toBeLessThan(
      boot.applyEmbeddedPgUrl.mock.invocationCallOrder[0],
    )
    expect(boot.applyEmbeddedPgUrl.mock.invocationCallOrder[0]).toBeLessThan(
      handle.close.mock.invocationCallOrder[0],
    )
  })

  it('prints owner: this command (no node running) when status itself owns the engine', async () => {
    const handle = closeHandle(true)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)
    pg.query
      .mockResolvedValueOnce({ rows: [{ reg: '_rivetos_migrations' }] })
      .mockResolvedValueOnce({ rows: [] })

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      lines.push(String(msg ?? ''))
    })

    await runDbStatus(CONFIG_PATH)
    spy.mockRestore()

    const text = lines.join('\n')
    expect(text).toContain('owner: this command (no node running)')
    expect(text).not.toContain('owner_pid:')
  })
})

describe('db --config flag', () => {
  it('takeConfigFlag strips --config / -c so the child never sees them', () => {
    expect(takeConfigFlag(['--config', '/x.yaml', '--baseline'])).toEqual({
      configPath: '/x.yaml',
      rest: ['--baseline'],
    })
    expect(takeConfigFlag(['--baseline', '-c', '/y.yaml'])).toEqual({
      configPath: '/y.yaml',
      rest: ['--baseline'],
    })
  })

  it('db migrate --config PATH is not forwarded to the child', async () => {
    const handle = closeHandle(true)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)
    process.argv = ['node', 'rivetos', 'db', 'migrate', '--config', CONFIG_PATH, '--baseline']

    await dbCommand()

    expect(boot.acquireEmbeddedPg).toHaveBeenCalled()
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['/fake/migrate.js', '--baseline'])
  })

  it('db status --config PATH uses the named config', async () => {
    const handle = closeHandle(false)
    boot.acquireEmbeddedPg.mockResolvedValue(handle)
    pg.query
      .mockResolvedValueOnce({ rows: [{ reg: '_rivetos_migrations' }] })
      .mockResolvedValueOnce({ rows: [] })
    process.argv = ['node', 'rivetos', 'db', 'status', '-c', CONFIG_PATH]
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await dbCommand()
    spy.mockRestore()

    expect(boot.acquireEmbeddedPg).toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalled()
    expect(pg.Client).toHaveBeenCalledWith({ connectionString: OWNER_PGURL })
  })
})
