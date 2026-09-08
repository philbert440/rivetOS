/**
 * `rivetos db ...` — schema migration and inspection commands.
 *
 * Sub-commands:
 *   db migrate        Apply pending migrations from @rivetos/memory-postgres
 *   db status         Show applied migrations on the configured Postgres
 *
 * Reads RIVETOS_PG_URL from env (or `--url <pg>` arg). When
 * `memory.postgres.embedded` is set, acquires or attaches the engine first.
 */

import { spawn } from 'node:child_process'
import { migrateEmbedded, readEmbeddedPgLock, embeddedPgLockAlive } from '@rivetos/boot'
import {
  dirSizeBytes,
  findRivetConfigPath,
  formatBytes,
  readEmbeddedConfig,
  withEmbeddedPg,
} from '../lib/embedded.js'
import { loadRivetEnv } from '../lib/env-file.js'
import { resolveMemoryMigrateScript } from '../paths.js'

async function spawnMigrateChild(args: string[], pgUrl?: string): Promise<void> {
  const script = resolveMemoryMigrateScript()
  if (!script) {
    console.error(
      '[db migrate] cannot locate @rivetos/memory-postgres migrate runner — is the package installed and built?',
    )
    process.exit(1)
  }

  const env = pgUrl ? { ...process.env, RIVETOS_PG_URL: pgUrl } : process.env
  const child = spawn(process.execPath, [script, ...args], {
    stdio: 'inherit',
    env,
  })

  await new Promise<void>((resolveProm, rejectProm) => {
    child.on('exit', (code) => {
      if (code === 0) resolveProm()
      else rejectProm(new Error(`migrate exited ${code}`))
    })
    child.on('error', rejectProm)
  })
}

export async function runDbMigrate(args: string[], explicitConfig?: string): Promise<void> {
  // `--url <pg>` targets an explicit (external) database: never touch the embedded engine.
  if (args.includes('--url')) {
    await spawnMigrateChild(args)
    return
  }
  const configPath = findRivetConfigPath(explicitConfig)
  const embedded = configPath ? readEmbeddedConfig(configPath) : undefined
  if (embedded) {
    await withEmbeddedPg(embedded.config, async (handle) => {
      // Owned + no runner arguments → in-process. Any runner argument (--baseline, --dir, …)
      // goes through the real runner as an ASYNC child — the socket host keeps serving.
      if (handle.owned && args.length === 0) {
        await migrateEmbedded(handle.pgUrl)
        return
      }
      await spawnMigrateChild(args, handle.pgUrl)
    })
    return
  }
  await spawnMigrateChild(args)
}

export async function runDbStatus(explicitConfig?: string): Promise<void> {
  const configPath = findRivetConfigPath(explicitConfig)
  if (configPath) {
    const embedded = readEmbeddedConfig(configPath)
    const config = embedded?.config
    const resolved = embedded?.resolved
    if (config && resolved) {
      await withEmbeddedPg(config, async (handle) => {
        printEmbeddedStatusHeader(resolved.dataDir, resolved.port, handle.owned)
        await printMigrationStatus(handle.pgUrl, { embedded: true })
      })
      return
    }
  }

  const pgUrl = process.env.RIVETOS_PG_URL
  if (!pgUrl) {
    console.error('[db status] RIVETOS_PG_URL not set')
    process.exit(1)
  }
  await printMigrationStatus(pgUrl)
}

function printEmbeddedStatusHeader(dataDir: string, configPort: number, owned: boolean): void {
  const lock = readEmbeddedPgLock(dataDir)
  const alive = lock ? embeddedPgLockAlive(lock) : owned
  const size = formatBytes(dirSizeBytes(dataDir))
  const port = lock?.port ?? configPort
  const pid = lock?.pid ?? (owned ? process.pid : undefined)
  console.log('[db status] embedded PGlite')
  console.log(`  data_dir: ${dataDir}`)
  console.log(`  size: ${size}`)
  if (pid == null) {
    console.log('  owner_pid: none')
  } else {
    console.log(`  owner_pid: ${String(pid)} (${alive ? 'alive' : 'dead'})`)
  }
  console.log(`  port: ${String(port)}`)
}

async function printMigrationStatus(
  pgUrl: string,
  opts: { embedded?: boolean } = {},
): Promise<void> {
  const { Client } = (await import('pg')).default
  const client = new Client({ connectionString: pgUrl })
  await client.connect()
  try {
    const exists = await client.query<{ reg: string | null }>(
      "SELECT to_regclass('_rivetos_migrations') AS reg",
    )
    if (!exists.rows[0]?.reg) {
      if (opts.embedded) console.log('  migrations_applied: 0')
      console.log(
        '[db status] _rivetos_migrations table does not exist (no migrations applied yet)',
      )
      return
    }
    const res = await client.query('SELECT name, applied_at FROM _rivetos_migrations ORDER BY name')
    if (opts.embedded) console.log(`  migrations_applied: ${String(res.rows.length)}`)
    if (res.rows.length === 0) {
      console.log('[db status] no migrations applied')
      return
    }
    console.log(`[db status] ${res.rows.length} migration(s) applied:`)
    for (const row of res.rows) {
      const { name, applied_at } = row as { name: string; applied_at: Date }
      console.log(`  ${name}  (${applied_at.toISOString()})`)
    }
  } finally {
    await client.end()
  }
}

export default async function dbCommand(): Promise<void> {
  loadRivetEnv()
  const sub = process.argv[3]
  const rest = process.argv.slice(4)

  switch (sub) {
    case 'migrate':
      await runDbMigrate(rest)
      break
    case 'status':
      await runDbStatus()
      break
    default:
      console.log(`
rivetos db — schema migration commands (Postgres or embedded PGlite)

Usage:
  rivetos db migrate [--url <pg>]   Apply pending migrations (embedded: acquire or attach)
  rivetos db status                 Show applied migrations (embedded: data dir, size, owner, port)
`)
      if (sub) process.exit(1)
  }
}
