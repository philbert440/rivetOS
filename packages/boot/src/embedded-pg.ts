/**
 * Embedded PGlite host — Postgres-in-WASM on a loopback wire socket.
 *
 * Presence of `memory.postgres.embedded` selects this transport for the same
 * postgres backend. Clients keep using RIVETOS_PG_URL; the socket exists only
 * while this process owns it.
 *
 * PGlite is a single PG session multiplexed under every connection, so
 * session-level SET and named prepared statements leak across clients unless
 * we RESET/DEALLOCATE on handler close.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MemoryPostgresEmbeddedSection, RivetConfig } from './config.js'

/** Subset of `@rivetos/core` logger — core does not export the Logger type. */
export interface EmbeddedPgLog {
  info(message: string, ...args: unknown[]): void
  warn?(message: string, ...args: unknown[]): void
  error?(message: string, ...args: unknown[]): void
}

export const EMBEDDED_PG_LOCKFILE = 'rivetos-owner.lock'

const DEFAULT_DATA_DIR = '~/.rivetos/pglite'
const DEFAULT_PORT = 5433
const DEFAULT_MAX_CONNECTIONS = 96
const LISTEN_NOTICE =
  'embedded postgres: LISTEN/NOTIFY does not cross the socket; task waiter + graphile poll'

export interface ResolvedEmbeddedPg {
  dataDir: string
  port: number
  autoMigrate: boolean
  maxConnections: number
  pgUrl: string
  liteMode: boolean
}

export interface EmbeddedPgHandle {
  pgUrl: string
  owned: boolean
  close(): Promise<void>
  /** In-process exec on the WASM session. Present only when owned. */
  exec?(sql: string): Promise<unknown>
}

export interface EmbeddedPgLock {
  pid: number
  port: number
  startedAt: string
}

/**
 * Resolve `memory.postgres.embedded` (presence = this transport).
 * Expands `~` in data_dir. Returns undefined when the block is absent.
 */
export function resolveEmbeddedPg(
  config: RivetConfig,
  home: string = homedir(),
): ResolvedEmbeddedPg | undefined {
  const pg: Record<string, unknown> | undefined = config.memory?.postgres
  if (!pg || pg.embedded === undefined || pg.embedded === null) return undefined
  if (typeof pg.embedded !== 'object' || Array.isArray(pg.embedded)) return undefined

  const embedded = pg.embedded as MemoryPostgresEmbeddedSection
  const dataDirRaw = typeof embedded.data_dir === 'string' ? embedded.data_dir : DEFAULT_DATA_DIR
  const port = typeof embedded.port === 'number' ? embedded.port : DEFAULT_PORT
  const autoMigrate = typeof embedded.auto_migrate === 'boolean' ? embedded.auto_migrate : true
  const maxConnections =
    typeof embedded.max_connections === 'number'
      ? embedded.max_connections
      : DEFAULT_MAX_CONNECTIONS

  const dataDir = resolvePath(expandTilde(dataDirRaw, home))
  const pgUrl = `postgres://postgres:postgres@127.0.0.1:${String(port)}/postgres`

  const embedEndpoint = typeof pg.embed_endpoint === 'string' ? pg.embed_endpoint.trim() : ''
  const embedUrl = process.env.RIVETOS_EMBED_URL?.trim() ?? ''
  const liteMode = embedEndpoint === '' && embedUrl === ''

  return { dataDir, port, autoMigrate, maxConnections, pgUrl, liteMode }
}

export function applyEmbeddedPgUrl(config: RivetConfig, pgUrl: string): void {
  process.env.RIVETOS_PG_URL = pgUrl
  process.env.RIVETOS_PG_EMBEDDED = '1'
  if (!config.memory) config.memory = {}
  if (!config.memory.postgres) config.memory.postgres = {}
  config.memory.postgres.connection_string = pgUrl
}

export async function migrateEmbedded(pgUrl: string, migrationsDir?: string): Promise<void> {
  const { run } = (await import('@rivetos/memory-postgres/schema/migrate')) as {
    run: (opts: { pgUrl: string; migrationsDir: string }) => Promise<void>
  }
  const dir = migrationsDir ?? resolveBuiltMigrationsDir()
  await run({ pgUrl, migrationsDir: dir })
}

export async function acquireEmbeddedPg(
  resolved: ResolvedEmbeddedPg,
  opts: { log: EmbeddedPgLog },
): Promise<EmbeddedPgHandle> {
  mkdirSync(resolved.dataDir, { recursive: true })
  const lockPath = join(resolved.dataDir, EMBEDDED_PG_LOCKFILE)

  for (let attempt = 0; attempt < 5; attempt++) {
    let fd: number | undefined
    try {
      fd = openSync(lockPath, 'wx')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      const attached = tryAttach(lockPath, resolved, opts.log)
      if (attached === 'alive') {
        return { pgUrl: resolved.pgUrl, owned: false, close: () => Promise.resolve() }
      }
      if (attached === 'stale') {
        try {
          unlinkSync(lockPath)
        } catch {
          /* raced */
        }
        continue
      }
      continue
    }

    try {
      const payload: EmbeddedPgLock = {
        pid: process.pid,
        port: resolved.port,
        startedAt: new Date().toISOString(),
      }
      writeFileSync(fd, JSON.stringify(payload))
    } catch (err) {
      closeSync(fd)
      try {
        unlinkSync(lockPath)
      } catch {
        /* best-effort */
      }
      throw err
    }
    closeSync(fd)

    try {
      return await startEmbeddedPg(resolved, opts, lockPath)
    } catch (err) {
      try {
        unlinkSync(lockPath)
      } catch {
        /* best-effort */
      }
      throw err
    }
  }

  throw new Error(`embedded postgres: could not acquire lock ${lockPath}`)
}

export async function startEmbeddedPg(
  resolved: ResolvedEmbeddedPg,
  opts: { log: EmbeddedPgLog },
  lockPath?: string,
): Promise<EmbeddedPgHandle> {
  const { PGlite } = await import('@electric-sql/pglite')
  const { vector } = await import('@electric-sql/pglite-pgvector')
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm')
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket')

  mkdirSync(resolved.dataDir, { recursive: true })

  const t0 = Date.now()
  const db = await PGlite.create(pathToFileURL(resolved.dataDir).href, {
    extensions: { vector, pg_trgm },
    relaxedDurability: true,
  })
  const bootMs = Date.now() - t0
  opts.log.info(`embedded postgres ready in ${String(bootMs)}ms`)

  const server = new PGLiteSocketServer({
    db,
    host: '127.0.0.1',
    port: resolved.port,
    maxConnections: resolved.maxConnections,
  })
  try {
    await server.start()
  } catch (err) {
    await db.close().catch(() => undefined)
    throw err
  }
  opts.log.info(LISTEN_NOTICE)

  // PGLiteSocketServer keeps `handlers` private; the hygiene hook only needs the structural surface.
  installSessionHygiene(server as unknown as SessionHygieneServer, db, resolved.liteMode)

  if (resolved.liteMode) {
    await db.exec(`SET rivet.defer_embed_enqueue = 'on'`).catch(() => undefined)
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    try {
      await server.stop()
    } catch {
      /* already stopped */
    }
    try {
      await db.close()
    } catch {
      /* already closed */
    }
    if (lockPath) {
      try {
        unlinkSync(lockPath)
      } catch {
        /* already gone */
      }
    }
  }

  return {
    pgUrl: resolved.pgUrl,
    owned: true,
    close,
    exec: (sql: string) => db.exec(sql),
  }
}

function expandTilde(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

function resolveBuiltMigrationsDir(): string {
  const req = createRequire(__filename)
  const migrateJs = req.resolve('@rivetos/memory-postgres/schema/migrate')
  return join(dirname(migrateJs), 'migrations')
}

function tryAttach(
  lockPath: string,
  resolved: ResolvedEmbeddedPg,
  log: EmbeddedPgLog,
): 'alive' | 'stale' | 'missing' {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw err
  }

  let parsed: { pid?: unknown; port?: unknown }
  try {
    parsed = JSON.parse(raw) as { pid?: unknown; port?: unknown }
  } catch {
    return 'stale'
  }
  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return 'stale'
  }

  try {
    process.kill(parsed.pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return 'stale'
    // EPERM: process exists but is not signalable — treat as alive.
  }

  log.info(`embedded postgres: attaching to owner pid ${String(parsed.pid)} on ${resolved.pgUrl}`)
  return 'alive'
}

interface SessionHygieneServer {
  handlers?: unknown
  addEventListener?(type: string, listener: () => void): void
}

function installSessionHygiene(
  server: SessionHygieneServer,
  db: { exec: (sql: string) => Promise<unknown> },
  liteMode: boolean,
): void {
  const hooked = new WeakSet<object>()
  const sql = liteMode
    ? `RESET ALL; DEALLOCATE ALL; SET rivet.defer_embed_enqueue = 'on';`
    : `RESET ALL; DEALLOCATE ALL;`

  const hookHandlers = (): void => {
    for (const handler of listHandlers(server.handlers)) {
      if (hooked.has(handler)) continue
      hooked.add(handler)
      handler.addEventListener('close', () => {
        void db.exec(sql).catch(() => undefined)
      })
    }
  }

  server.addEventListener?.('connection', () => {
    setImmediate(hookHandlers)
  })
}

function listHandlers(handlers: unknown): EventTarget[] {
  if (handlers instanceof Map) return [...handlers.values()] as EventTarget[]
  if (handlers instanceof Set) return [...handlers] as EventTarget[]
  if (Array.isArray(handlers)) return handlers as EventTarget[]
  return []
}

/** Best-effort lock read for doctor / CLI. Missing or invalid → undefined. */
export function readEmbeddedPgLock(dataDir: string): EmbeddedPgLock | undefined {
  const lockPath = join(dataDir, EMBEDDED_PG_LOCKFILE)
  if (!existsSync(lockPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<EmbeddedPgLock>
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return undefined
    return {
      pid: parsed.pid,
      port: parsed.port,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    }
  } catch {
    return undefined
  }
}

export function embeddedPgLockAlive(lock: EmbeddedPgLock): boolean {
  try {
    process.kill(lock.pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}
