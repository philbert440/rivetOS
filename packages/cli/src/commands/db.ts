/**
 * `rivetos db ...` — schema migration and inspection commands.
 *
 * Sub-commands:
 *   db migrate        Apply pending migrations from @rivetos/memory-postgres
 *   db status         Show applied migrations on the configured Postgres
 *
 * Reads RIVETOS_PG_URL from env (or `--url <pg>` arg).
 */

import { spawn } from 'node:child_process'
import { resolveMemoryMigrateScript } from '../paths.js'

async function migrate(args: string[]): Promise<void> {
  const script = resolveMemoryMigrateScript()
  if (!script) {
    console.error(
      '[db migrate] cannot locate @rivetos/memory-postgres migrate runner — is the package installed and built?',
    )
    process.exit(1)
  }

  const child = spawn(process.execPath, [script, ...args], {
    stdio: 'inherit',
    env: process.env,
  })

  await new Promise<void>((resolveProm, rejectProm) => {
    child.on('exit', (code) => {
      if (code === 0) resolveProm()
      else rejectProm(new Error(`migrate exited ${code}`))
    })
    child.on('error', rejectProm)
  })
}

async function status(): Promise<void> {
  const pgUrl = process.env.RIVETOS_PG_URL
  if (!pgUrl) {
    console.error('[db status] RIVETOS_PG_URL not set')
    process.exit(1)
  }
  const { Client } = (await import('pg')).default
  const client = new Client({ connectionString: pgUrl })
  await client.connect()
  try {
    const exists = await client.query<{ reg: string | null }>(
      "SELECT to_regclass('_rivetos_migrations') AS reg",
    )
    if (!exists.rows[0]?.reg) {
      console.log(
        '[db status] _rivetos_migrations table does not exist (no migrations applied yet)',
      )
      return
    }
    const res = await client.query('SELECT name, applied_at FROM _rivetos_migrations ORDER BY name')
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
  const sub = process.argv[3]
  const rest = process.argv.slice(4)

  switch (sub) {
    case 'migrate':
      await migrate(rest)
      break
    case 'status':
      await status()
      break
    default:
      console.log(`
rivetos db — schema migration commands

Usage:
  rivetos db migrate [--url <pg>]   Apply pending migrations
  rivetos db status                 Show applied migrations
`)
      if (sub) process.exit(1)
  }
}
