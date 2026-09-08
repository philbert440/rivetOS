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
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
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
const ATTACH_TIMEOUT_MS = 20_000
const HYGIENE_TXN_WAIT_MS = 5_000
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

export const ATTACH_BACKUP_ERROR = 'stop the node or run backup from it'

export interface EmbeddedPgHandle {
  pgUrl: string
  owned: boolean
  close(): Promise<void>
  /** In-process exec on the WASM session. Present only when owned. */
  exec?(sql: string): Promise<unknown>
  /**
   * Native PGlite gzip tarball (`dumpDataDir`). Attach mode (another process
   * owns the engine) throws {@link ATTACH_BACKUP_ERROR}.
   */
  backup(outPath: string): Promise<void>
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
  const pgUrl = embeddedPgUrl(port)

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
  opts: { log: EmbeddedPgLog; attachTimeoutMs?: number },
): Promise<EmbeddedPgHandle> {
  const attachTimeoutMs = opts.attachTimeoutMs ?? ATTACH_TIMEOUT_MS
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
      if (attached.state === 'alive') {
        // The owner publishes the lock before PGlite finishes booting (4–6 s): wait for the
        // socket it recorded to actually listen before handing anyone a URL.
        const port = attached.port
        if (port !== resolved.port) {
          opts.log.warn?.(
            `embedded postgres: owner pid ${String(attached.pid)} listens on ${String(port)}, config says ${String(resolved.port)} — using the owner's port`,
          )
        }
        const pgUrl = embeddedPgUrl(port)
        const ready = await waitForPort(port, attachTimeoutMs)
        if (!ready) {
          throw new Error(
            `embedded postgres: owner pid ${String(attached.pid)} holds ${lockPath} but nothing listens on 127.0.0.1:${String(port)} after ${String(attachTimeoutMs)}ms — if that process is dead, remove the lock`,
            { cause: err },
          )
        }
        return {
          pgUrl,
          owned: false,
          close: () => Promise.resolve(),
          backup: () => Promise.reject(new Error(ATTACH_BACKUP_ERROR)),
        }
      }
      if (attached.state === 'stale') {
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
  // ESM-only packages loaded from CJS boot; declared as optionalDependencies (fleet nodes never load them).
  const loadEngine = async () => {
    const [pglite, pgvector, trgm, socket] = await Promise.all([
      // eslint-disable-next-line @nx/enforce-module-boundaries -- optionalDependencies
      import('@electric-sql/pglite'),
      // eslint-disable-next-line @nx/enforce-module-boundaries -- optionalDependencies
      import('@electric-sql/pglite-pgvector'),
      // eslint-disable-next-line @nx/enforce-module-boundaries -- optionalDependencies
      import('@electric-sql/pglite/contrib/pg_trgm'),
      // eslint-disable-next-line @nx/enforce-module-boundaries -- optionalDependencies
      import('@electric-sql/pglite-socket'),
    ])
    return {
      PGlite: pglite.PGlite,
      vector: pgvector.vector,
      pg_trgm: trgm.pg_trgm,
      PGLiteSocketServer: socket.PGLiteSocketServer,
    }
  }
  let engine: Awaited<ReturnType<typeof loadEngine>>
  try {
    engine = await loadEngine()
  } catch (err) {
    throw new Error(
      'memory.postgres.embedded needs @electric-sql/pglite, @electric-sql/pglite-pgvector and ' +
        '@electric-sql/pglite-socket (optionalDependencies of @rivetos/boot) — install them: ' +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    )
  }
  const { PGlite, vector, pg_trgm, PGLiteSocketServer } = engine

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
  // `handlers` is private in the published .d.ts but a plain Set at runtime — verified against
  // @electric-sql/pglite-socket 0.2.11. embedded-pg.test.ts's reset assertions catch a future change.
  installSessionHygiene(server as unknown as SessionHygieneServer, db, resolved.liteMode, opts.log)

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
    backup: async (outPath: string) => {
      mkdirSync(dirname(outPath), { recursive: true })
      const dumped = await (
        db as { dumpDataDir: (compression: 'gzip' | 'none') => Promise<unknown> }
      ).dumpDataDir('gzip')
      const bytes = await dumpToBuffer(dumped)
      writeFileSync(outPath, bytes)
      try {
        chmodSync(outPath, 0o600)
      } catch {
        // Windows may ignore mode bits
      }
    },
  }
}

async function dumpToBuffer(dumped: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(dumped)) return dumped
  if (dumped instanceof Uint8Array) return Buffer.from(dumped)
  if (dumped && typeof dumped === 'object' && 'arrayBuffer' in dumped) {
    const buf = await (dumped as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer()
    return Buffer.from(buf)
  }
  throw new Error('embedded postgres: dumpDataDir did not return a File/Blob/Uint8Array')
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

type AttachProbe =
  { state: 'alive'; pid: number; port: number } | { state: 'stale' } | { state: 'missing' }

function tryAttach(
  lockPath: string,
  resolved: ResolvedEmbeddedPg,
  log: EmbeddedPgLog,
): AttachProbe {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    throw err
  }

  let parsed: { pid?: unknown; port?: unknown }
  try {
    parsed = JSON.parse(raw) as { pid?: unknown; port?: unknown }
  } catch {
    return { state: 'stale' }
  }
  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return { state: 'stale' }
  }
  const port =
    typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0
      ? parsed.port
      : resolved.port

  try {
    process.kill(parsed.pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return { state: 'stale' }
    // EPERM: process exists but is not signalable — treat as alive.
  }

  log.info(
    `embedded postgres: attaching to owner pid ${String(parsed.pid)} on 127.0.0.1:${String(port)}`,
  )
  return { state: 'alive', pid: parsed.pid, port }
}

export function embeddedPgUrl(port: number): string {
  return `postgres://postgres:postgres@127.0.0.1:${String(port)}/postgres`
}

/** Connect-with-timeout retry until the loopback port accepts, or the deadline passes. */
export async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const open = await new Promise<boolean>((resolveOpen) => {
      const sock = net.connect({ host: '127.0.0.1', port })
      const done = (v: boolean) => {
        sock.removeAllListeners()
        sock.destroy()
        resolveOpen(v)
      }
      sock.setTimeout(500, () => done(false))
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
    })
    if (open) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 200))
  }
}

interface SessionHygieneServer {
  handlers?: unknown
  addEventListener?(type: string, listener: () => void): void
}

interface HygieneDb {
  exec: (sql: string) => Promise<unknown>
  isInTransaction?: () => boolean
}

function installSessionHygiene(
  server: SessionHygieneServer,
  db: HygieneDb,
  liteMode: boolean,
  log: EmbeddedPgLog,
): void {
  const hooked = new WeakSet<object>()
  const sql = liteMode
    ? `RESET ALL; DEALLOCATE ALL; SET rivet.defer_embed_enqueue = 'on';`
    : `RESET ALL; DEALLOCATE ALL;`

  // The socket's query queue serialises whole transactions, but a raw db.exec is not
  // queue-aware: never run the reset while another client's transaction is open
  // (RESET ALL would wipe its SET LOCALs; an aborted txn would fail the script).
  const runReset = async (): Promise<void> => {
    const deadline = Date.now() + HYGIENE_TXN_WAIT_MS
    while (db.isInTransaction?.() === true) {
      if (Date.now() >= deadline) {
        log.warn?.('embedded postgres: session reset skipped — a transaction stayed open for 5s')
        return
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    try {
      await db.exec(sql)
    } catch (err) {
      log.warn?.(
        `embedded postgres: session reset failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const hookHandlers = (): void => {
    for (const handler of listHandlers(server.handlers)) {
      if (hooked.has(handler)) continue
      hooked.add(handler)
      handler.addEventListener('close', () => {
        void runReset()
      })
    }
  }

  // The handler is added to the Set before `connection` is dispatched, so hook synchronously;
  // the setImmediate pass covers any implementation that adds it afterwards.
  server.addEventListener?.('connection', () => {
    hookHandlers()
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
