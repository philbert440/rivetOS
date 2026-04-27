/**
 * `rivetos db ...` — schema migration and inspection commands.
 *
 * Sub-commands:
 *   db migrate        Apply pending migrations from deploy/schema/migrations/
 *   db status         Show applied migrations on the configured Postgres
 *
 * Reads RIVETOS_PG_URL from env (or `--url <pg>` arg).
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

function findRepoRoot(start: string): string | null {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, 'deploy/schema/migrate.mjs'))) {
      return dir
    }
    const next = dirname(dir)
    if (next === dir) break
    dir = next
  }
  return null
}

async function migrate(args: string[]): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = findRepoRoot(here)
  if (!repoRoot) {
    console.error(
      '[db migrate] cannot locate deploy/schema/migrate.mjs — is the repo checkout intact?',
    )
    process.exit(1)
  }

  const script = resolve(repoRoot, 'deploy/schema/migrate.mjs')
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
