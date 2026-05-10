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

import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolveMemoryMigrateScript } from '../paths.js'

type Role = 'agent' | 'migrate'

function parseArgs(): { configPath?: string; role: Role } {
  const args = process.argv.slice(3)
  let configPath: string | undefined
  let role: Role = (process.env.RIVETOS_ROLE as Role | undefined) ?? 'agent'

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
      configPath = args[++i]
    } else if (args[i] === '--role' && args[i + 1]) {
      const next = args[++i]
      if (next === 'agent' || next === 'migrate') {
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
  if (explicit) return explicit
  const candidates = [
    resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml'),
    resolve(process.env.HOME ?? '.', '.rivetos', 'config.yml'),
    resolve('.', 'config.yaml'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  console.error('No config found. Run `rivetos config init` or use --config <path>')
  process.exit(1)
}

async function startAgent(configPath: string): Promise<void> {
  const { boot } = await import('@rivetos/boot')
  await boot(configPath)
}

async function runMigrate(): Promise<void> {
  const script = resolveMemoryMigrateScript()
  if (!script) {
    console.error('[migrate] cannot locate @rivetos/memory-postgres migrate runner')
    process.exit(1)
  }
  await new Promise<void>((res, rej) => {
    const child = spawn(process.execPath, [script], {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`migrate exit ${code}`))))
    child.on('error', rej)
  })
}

export default async function start(): Promise<void> {
  const { configPath: explicit, role } = parseArgs()

  console.log(`[start] role=${role}`)

  switch (role) {
    case 'migrate':
      await runMigrate()
      break
    case 'agent':
    default: {
      const configPath = findConfig(explicit)
      await startAgent(configPath)
    }
  }
}
