/**
 * rivetos migrate-to-rivethub
 *
 * Move this node (or, with --mesh, every agent node) from the RivetOS
 * TypeScript runtime to the RivetHub runtime, or roll that back:
 *
 *   1. Preflight — refuse with a reason before anything changes
 *   2. Install rh + rivethub-migrate (release download or --binary), validate config
 *   3. Stop + disable rivetos.service; back up ~/.rivetos
 *   4. Memory: rivethub-migrate postgres, or PGlite dump → SQLite import
 *   5. Install + start rivethub.service in the old unit's scope
 *   6. ~/.rivetos → ~/.rivethub link once RivetHub has moved the state; health
 *
 * Same structure as `rivetos update`: preflight, systemd scope detection,
 * ownership checks, mesh walk over SSH (local last), step logging, exit codes.
 * The moving parts live in ./migrate-to-rivethub/.
 */

import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { loadMeshFile } from '../lib/mesh-file.js'
import { resolveSshUser } from '../lib/ssh.js'
import { EXIT_REFUSED, executePlan } from './migrate-to-rivethub/execute.js'
import { realHost, type Host } from './migrate-to-rivethub/host.js'
import { meshMigrate } from './migrate-to-rivethub/mesh.js'
import { HELP_TEXT, parseMigrateArgs, type MigrateOptions } from './migrate-to-rivethub/options.js'
import { planMigration, planRollback, stampOf } from './migrate-to-rivethub/plan.js'
import { probeNode, type NodeFacts } from './migrate-to-rivethub/probe.js'

function describe(facts: NodeFacts): string[] {
  const mem = facts.memory
  const memory =
    mem.kind === 'postgres'
      ? 'Postgres'
      : mem.kind === 'pglite'
        ? `embedded PGlite (${mem.dataDir})`
        : mem.kind === 'sqlite'
          ? `SQLite (${mem.path})`
          : mem.kind === 'none'
            ? 'none configured'
            : 'unreadable config'
  const binary =
    facts.binary.source === 'local'
      ? `local ${facts.binary.rh}`
      : `release ${facts.binary.tag ?? 'latest'}`
  return [
    `   User: ${facts.user} (uid ${String(facts.uid)})   Home: ${facts.home}`,
    `   rivetos.service: ${facts.tsUnit}${facts.tsActive ? ' (active)' : ''}   rivethub.service: ${facts.hubUnit}`,
    `   Memory: ${memory}   RivetHub binary: ${binary}`,
  ]
}

/** Migrate or roll back this node only. */
export async function migrateLocal(opts: MigrateOptions, host: Host): Promise<number> {
  host.log(
    `🔩 RivetHub ${opts.rollback ? 'rollback' : 'migration'}${opts.dryRun ? ' (dry run)' : ''}`,
  )
  const facts = probeNode(host, opts)
  for (const line of describe(facts)) host.log(line)
  host.log('')
  const stamp = stampOf(host.now())
  const plan = opts.rollback ? planRollback(facts, stamp) : planMigration(facts, opts, stamp)
  return executePlan(plan, host, opts.dryRun)
}

function isLocalAddress(address: string): boolean {
  if (address === '127.0.0.1' || address === 'localhost' || address === '::1') return true
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) if (iface.address === address) return true
  }
  return false
}

function sshRun(address: string, user: string, command: string, timeoutMs: number) {
  return new Promise<number>((resolvePromise) => {
    const proc = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `${user}@${address}`, command],
      { stdio: 'inherit' },
    )
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    proc.on('error', () => {
      clearTimeout(timer)
      resolvePromise(255)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise(code ?? 255)
    })
  })
}

/** Entry point with an injectable host; returns the exit code. */
export async function migrateToRivethub(args: string[], host: Host = realHost()): Promise<number> {
  const parsed = parseMigrateArgs(args)
  if (!parsed.ok) {
    host.error(`❌ ${parsed.error}`)
    host.log(HELP_TEXT)
    return EXIT_REFUSED
  }
  const opts = parsed.opts
  if (opts.help) {
    host.log(HELP_TEXT)
    return 0
  }
  if (opts.mesh) {
    return meshMigrate(opts, {
      host,
      loadMesh: () => loadMeshFile(),
      isLocal: isLocalAddress,
      resolveSshUser: (address, users, tag) => resolveSshUser(address, users, tag),
      sshRun,
      migrateLocal: (o) => migrateLocal(o, host),
    })
  }
  return migrateLocal(opts, host)
}

export default async function migrateToRivethubCommand(args: string[]): Promise<void> {
  const code = await migrateToRivethub(args)
  if (code !== 0) process.exit(code)
}
