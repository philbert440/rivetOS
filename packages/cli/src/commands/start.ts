/**
 * rivetos start [--config <path>] [--role <role>]
 *
 * Roles:
 *   agent      Default. Starts the agent runtime (boot pipeline).
 *   worker     Starts the embedding + compaction workers (no agent).
 *   monolith   Starts both — agent + workers in one process tree.
 *   migrate    Apply pending DB migrations and exit (CI / startup hook use).
 */

import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolveMemoryMigrateScript } from '../paths.js'

type Role = 'agent' | 'worker' | 'monolith' | 'migrate'

function parseArgs(): { configPath?: string; role: Role } {
  const args = process.argv.slice(3)
  let configPath: string | undefined
  let role: Role = (process.env.RIVETOS_ROLE as Role | undefined) ?? 'agent'

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
      configPath = args[++i]
    } else if (args[i] === '--role' && args[i + 1]) {
      const next = args[++i]
      if (next === 'agent' || next === 'worker' || next === 'monolith' || next === 'migrate') {
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

function findRepoRoot(start: string): string | null {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, 'services/embedding-worker/index.js'))) {
      return dir
    }
    const next = dirname(dir)
    if (next === dir) break
    dir = next
  }
  return null
}

function spawnWorker(name: string, scriptRelPath: string): ChildProcess {
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = findRepoRoot(here)
  if (!repoRoot) {
    console.error(`[${name}] cannot locate ${scriptRelPath} — repo checkout missing?`)
    process.exit(1)
  }
  const script = resolve(repoRoot, scriptRelPath)
  const child = spawn(process.execPath, [script], {
    stdio: 'inherit',
    env: process.env,
  })
  child.on('exit', (code, signal) => {
    console.log(`[${name}] exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
  })
  return child
}

async function startWorkers(): Promise<void> {
  const embed = spawnWorker('embedding-worker', 'services/embedding-worker/index.js')
  const compact = spawnWorker('compaction-worker', 'services/compaction-worker/index.js')

  const shutdown = (sig: NodeJS.Signals) => {
    console.log(`[start] received ${sig}, stopping workers`)
    embed.kill(sig)
    compact.kill(sig)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Stay alive until both children exit.
  await Promise.all([
    new Promise<void>((res) => embed.once('exit', () => res())),
    new Promise<void>((res) => compact.once('exit', () => res())),
  ])
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
    case 'worker':
      await startWorkers()
      break
    case 'monolith': {
      const configPath = findConfig(explicit)
      // Workers run as children; agent runs in this process.
      // If agent throws, the children get cleaned up by SIGTERM.
      const workerProm = startWorkers()
      try {
        await startAgent(configPath)
      } finally {
        process.kill(process.pid, 'SIGTERM')
        await workerProm.catch(() => undefined)
      }
      break
    }
    case 'agent':
    default: {
      const configPath = findConfig(explicit)
      await startAgent(configPath)
    }
  }
}
