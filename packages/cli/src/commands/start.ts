/**
 * rivetos start [--config <path>] [--role <role>]
 *
 * Roles:
 *   agent      Default. Starts the agent runtime (boot pipeline).
 *   migrate    Apply pending DB migrations and exit (CI / startup hook use).
 *
 * The embedding and compaction workers run as their own systemd services
 * (services/embedding-worker, services/compaction-worker) — not via this CLI.
 */

import { spawn } from 'node:child_process'
import { migrateEmbedded } from '@rivetos/boot'
import { findRivetConfigPath, readEmbeddedConfig, withEmbeddedPg } from '../lib/embedded.js'
import { loadRivetEnv } from '../lib/env-file.js'
import { resolveMemoryMigrateScript } from '../paths.js'

type Role = 'agent' | 'migrate'

function isRole(value: string): value is Role {
  return value === 'agent' || value === 'migrate'
}

const HELP_TEXT = `Usage: rivetos start [options]

Start the RivetOS agent runtime (boot pipeline) or apply pending DB migrations.

Options:
  -c, --config <path>   Path to config.yaml (default: ~/.rivetos/config.yaml)
      --role <role>     'agent' (default) or 'migrate'
  -h, --help            Show this help and exit

Environment:
  RIVETOS_ROLE          Seeds the default role; an explicit --role overrides it.
                        Must be 'agent' or 'migrate' — any other value is an error.
`

function parseArgs(): { configPath?: string; role: Role } {
  const args = process.argv.slice(3)
  let configPath: string | undefined
  // RIVETOS_ROLE only seeds the default — an explicit --role below wins.
  // Validated the same way as the flag so a stale value (e.g. the removed
  // 'worker' role) fails loudly instead of silently booting an agent.
  const envRole = process.env.RIVETOS_ROLE
  if (envRole && !isRole(envRole)) {
    console.error(`unknown role: ${envRole} (from RIVETOS_ROLE)`)
    process.exit(1)
  }
  let role: Role = envRole && isRole(envRole) ? envRole : 'agent'

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write(HELP_TEXT)
      process.exit(0)
    } else if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
      configPath = args[++i]
    } else if (args[i] === '--role' && args[i + 1]) {
      const next = args[++i]
      if (isRole(next)) {
        role = next
      } else {
        console.error(`unknown role: ${next}`)
        process.exit(1)
      }
    }
  }
  return { configPath, role }
}

function findConfig(explicit?: string): string {
  const found = findRivetConfigPath(explicit)
  if (found) return found
  console.error('No config found. Run `rivetos config init` or use --config <path>')
  process.exit(1)
}

async function startAgent(configPath: string): Promise<void> {
  const { boot } = await import('@rivetos/boot')
  await boot(configPath)
}

async function spawnMigrateChild(extraArgs: string[] = [], pgUrl?: string): Promise<void> {
  const script = resolveMemoryMigrateScript()
  if (!script) {
    console.error('[migrate] cannot locate @rivetos/memory-postgres migrate runner')
    process.exit(1)
  }
  const env = pgUrl ? { ...process.env, RIVETOS_PG_URL: pgUrl } : process.env
  await new Promise<void>((res, rej) => {
    const child = spawn(process.execPath, [script, ...extraArgs], {
      stdio: 'inherit',
      env,
    })
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`migrate exit ${code}`))))
    child.on('error', rej)
  })
}

/**
 * Embedded: acquire/attach, migrate in-process when this process owns the
 * engine, otherwise async-spawn the migrator (spawnSync would deadlock the
 * socket). Non-embedded: existing child-process migrator.
 */
export async function runMigrate(explicitConfig?: string): Promise<void> {
  const configPath = findRivetConfigPath(explicitConfig)
  const embedded = configPath ? readEmbeddedConfig(configPath) : undefined
  if (embedded) {
    await withEmbeddedPg(embedded.config, async (handle) => {
      if (handle.owned) {
        await migrateEmbedded(handle.pgUrl)
        return
      }
      await spawnMigrateChild([], handle.pgUrl)
    })
    return
  }
  await spawnMigrateChild()
}

export default async function start(): Promise<void> {
  loadRivetEnv()
  const { configPath: explicit, role } = parseArgs()

  console.log(`[start] role=${role}`)

  switch (role) {
    case 'migrate':
      await runMigrate(explicit)
      break
    case 'agent':
    default: {
      const configPath = findConfig(explicit)
      await startAgent(configPath)
    }
  }
}
