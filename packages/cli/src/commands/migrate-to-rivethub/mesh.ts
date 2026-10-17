/**
 * `migrate-to-rivethub --mesh`: run the command on every agent node over SSH,
 * one node at a time, then on this node — the way `rivetos update --mesh`
 * walks the mesh (mesh.json roster, per-node SSH user, local last).
 *
 * Remotes run their own `rivetos migrate-to-rivethub`, so every node does its
 * own preflight against its own facts. Nodes go one at a time (not in
 * parallel like update) so the first Postgres adoption finishes before the
 * next node looks at the shared database, and so a bad release stops at the
 * first node instead of reaching all of them.
 *
 * A real (non dry) run is started detached on the node (setsid + nohup,
 * output to a log under ~/.cache/rivethub-migrate) and then followed over a
 * second SSH connection, so a dropped connection or a timeout here never
 * kills a node mid-switch: the follow reconnects, and the node's own run
 * finishes (or recovers) either way.
 */

import { basename, dirname, join } from 'node:path'
import { installRoot } from '@rivetos/types'
import type { MeshFile, MeshNode } from '../../lib/mesh-file.js'
import { quoteShellArg } from '../../lib/ssh.js'
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED } from './execute.js'
import type { Host } from './host.js'
import { RUN_DIR } from './lock.js'
import { forwardedFlags, type MigrateOptions } from './options.js'
import { stampOf } from './plan.js'

/** Remote directory (relative to the SSH login's home) for --binary uploads. */
export const REMOTE_BINARY_DIR = RUN_DIR

/** How long to follow one node's detached run before giving up on it. */
export const REMOTE_RUN_TIMEOUT_MS = 60 * 60_000
/** SSH reconnects while following a detached run. */
export const FOLLOW_RECONNECTS = 12
const RECONNECT_DELAY_MS = 5_000
/** sshRun's code for an SSH failure (ssh's own exit 255, or killed). */
const SSH_FAILED = 255
/** The detached run is gone without leaving an exit code. */
export const EXIT_RUN_LOST = 4

export interface MeshDeps {
  host: Host
  loadMesh(): Promise<MeshFile | null>
  isLocal(address: string): boolean
  resolveSshUser(address: string, users: string[], tag: string): string | null
  /** Streamed remote command; resolves with the remote exit code. */
  sshRun(address: string, user: string, command: string, timeoutMs: number): Promise<number>
  migrateLocal(opts: MigrateOptions): Promise<number>
}

export type NodeOutcome = 'done' | 'planned' | 'refused' | 'failed' | 'skipped' | 'unreachable'

interface Row {
  name: string
  outcome: NodeOutcome
  detail: string
}

/** Why a node is not walked, or undefined when it is. */
export function skipReason(node: MeshNode): string | undefined {
  if (node.role && node.role !== 'agent') {
    return `role=${node.role} (workers move separately; see docs/migrating-to-rivethub.md)`
  }
  if (node.platform && node.platform !== 'linux') return `platform=${node.platform}`
  if (node.metadata?.deployable === false) return 'deployable=false'
  return undefined
}

/**
 * Remote shell command: prefer the node's source checkout CLI (the one
 * `rivetos update` keeps current), then a `rivetos` on PATH that knows the
 * command — on a node that already switched, `rivetos` may be RivetHub's
 * alias, which does not. Exit 3 when no capable CLI exists.
 */
export function remoteCommand(root: string, flags: string[]): string {
  const cli = `${root}/packages/cli/dist/index.js`
  const args = ['migrate-to-rivethub', ...flags].join(' ')
  return [
    `if [ -f ${quoteShellArg(cli)} ]; then cli="node ${quoteShellArg(cli)}";`,
    'elif command -v rivetos >/dev/null 2>&1; then cli=rivetos;',
    'else echo "no RivetOS CLI on this node" >&2; exit 3; fi;',
    '$cli migrate-to-rivethub --help 2>/dev/null | grep -q migrate-to-rivethub ||',
    '{ echo "this node\'s RivetOS CLI predates migrate-to-rivethub — run rivetos update --mesh first" >&2; exit 3; };',
    `$cli ${args}`,
  ].join(' ')
}

function runBase(runId: string): string {
  return `${RUN_DIR}/run-${runId}`
}

/**
 * Start `inner` detached from the SSH session: a new session (setsid) that
 * ignores SIGHUP (nohup), output in <base>.log, exit code in <base>.exit
 * once it finishes. Returns once the run has written its pid.
 */
export function detachedStartCommand(runId: string, inner: string): string {
  const base = runBase(runId)
  const script = `echo $$ > ${base}.pid; ( ${inner} ); echo $? > ${base}.exit.tmp && mv ${base}.exit.tmp ${base}.exit`
  return [
    `mkdir -p ${RUN_DIR} || exit 1;`,
    `rm -f ${base}.exit ${base}.pid;`,
    'if command -v setsid >/dev/null 2>&1; then s=setsid; else s=; fi;',
    `$s nohup bash -c ${quoteShellArg(script)} > ${base}.log 2>&1 < /dev/null &`,
    `for i in $(seq 1 50); do [ -s ${base}.pid ] && exit 0; sleep 0.1; done;`,
    'echo "the migration did not start on this node" >&2; exit 1',
  ].join(' ')
}

/**
 * Stream a detached run's log until it finishes and exit with its code;
 * EXIT_RUN_LOST when the run died without one (killed, rebooted).
 */
export function followCommand(runId: string, fromStart: boolean): string {
  const base = runBase(runId)
  return [
    `tail -n ${fromStart ? '+1' : '20'} -F ${base}.log 2>/dev/null & t=$!;`,
    `while [ ! -f ${base}.exit ]; do`,
    `if ! kill -0 "$(cat ${base}.pid 2>/dev/null)" 2>/dev/null && [ ! -f ${base}.exit ]; then`,
    `kill $t 2>/dev/null; echo "the migration on this node stopped without a result; see ~/${base}.log" >&2; exit ${String(EXIT_RUN_LOST)};`,
    'fi; sleep 2; done;',
    `sleep 1; kill $t 2>/dev/null; exit "$(cat ${base}.exit)"`,
  ].join(' ')
}

async function runDetached(
  deps: MeshDeps,
  address: string,
  user: string,
  inner: string,
  tag: string,
): Promise<number> {
  const { host } = deps
  const runId = stampOf(host.now())
  const started = await deps.sshRun(address, user, detachedStartCommand(runId, inner), 60_000)
  if (started !== 0) {
    host.error(`  ${tag} ❌ could not start the migration on ${address} (exit ${String(started)})`)
    return started === SSH_FAILED ? EXIT_FAILED : started
  }
  host.log(`  ${tag} running detached on the node; its log: ~/${runBase(runId)}.log`)
  const deadline = host.now().getTime() + REMOTE_RUN_TIMEOUT_MS
  for (let attempt = 0; ; attempt++) {
    const left = deadline - host.now().getTime()
    if (left <= 0) {
      host.error(
        `  ${tag} ❌ no result after ${String(REMOTE_RUN_TIMEOUT_MS / 60_000)} min; the run continues on the node — check ~/${runBase(runId)}.log there.`,
      )
      return EXIT_FAILED
    }
    const code = await deps.sshRun(address, user, followCommand(runId, attempt === 0), left)
    if (code !== SSH_FAILED) return code
    if (attempt >= FOLLOW_RECONNECTS) {
      host.error(
        `  ${tag} ❌ lost the SSH connection to ${address}; the run continues on the node — check ~/${runBase(runId)}.log there.`,
      )
      return EXIT_FAILED
    }
    host.error(`  ${tag} ⚠️  lost the SSH connection; the node's run continues. Reconnecting…`)
    await host.sleep(RECONNECT_DELAY_MS)
  }
}

function outcomeOf(code: number, dryRun: boolean): NodeOutcome {
  if (code === EXIT_OK) return dryRun ? 'planned' : 'done'
  if (code === EXIT_REFUSED) return 'refused'
  return 'failed'
}

export async function meshMigrate(opts: MigrateOptions, deps: MeshDeps): Promise<number> {
  const { host } = deps
  const verb = opts.rollback ? 'rollback' : 'migration'
  host.log(`🔩 RivetHub ${verb} across the mesh${opts.dryRun ? ' (dry run)' : ''}`)
  host.log('')

  const mesh = await deps.loadMesh()
  if (!mesh) {
    host.error('  ❌ No mesh.json found — run without --mesh to migrate this node only.')
    return EXIT_REFUSED
  }
  const nodes = Object.values(mesh.nodes)
  const remotes = nodes.filter((n) => !deps.isLocal(n.host))
  const rows: Row[] = []

  for (const node of remotes) {
    const tag = `[${node.name}]`
    const skip = skipReason(node)
    if (skip) {
      host.log(`  ${tag} ⏭️  ${skip}`)
      rows.push({ name: node.name, outcome: 'skipped', detail: skip })
      continue
    }
    const users = [node.sshUser, opts.sshUser].filter((u): u is string => !!u)
    const user = deps.resolveSshUser(node.host, users, tag)
    if (!user) {
      host.error(`  ${tag} ❌ cannot reach ${node.host} over SSH as ${users.join('/')}`)
      rows.push({ name: node.name, outcome: 'unreachable', detail: node.host })
      continue
    }

    let remoteBinary: string | undefined
    if (opts.binary) {
      const migrate = join(dirname(opts.binary), 'rivethub-migrate')
      const dest = `${user}@${node.host}:${REMOTE_BINARY_DIR}/`
      const upload = host.run(
        `ssh -o BatchMode=yes -o ConnectTimeout=5 ${user}@${node.host} 'mkdir -p ${REMOTE_BINARY_DIR}' && ` +
          `scp -q -o BatchMode=yes -o ConnectTimeout=5 ${quoteShellArg(opts.binary)} ${quoteShellArg(migrate)} ${dest}`,
        { timeoutMs: 300_000 },
      )
      if (upload.code !== 0) {
        host.error(`  ${tag} ❌ uploading --binary failed: ${upload.stderr.trim()}`)
        rows.push({ name: node.name, outcome: 'failed', detail: 'upload' })
        continue
      }
      remoteBinary = `${REMOTE_BINARY_DIR}/${basename(opts.binary)}`
    }

    const root = node.installRoot?.trim() || installRoot()
    host.log(`  ${tag} ── ${node.host} as ${user}`)
    const inner = remoteCommand(root, forwardedFlags(opts, remoteBinary))
    const code = opts.dryRun
      ? await deps.sshRun(node.host, user, inner, 30 * 60_000)
      : await runDetached(deps, node.host, user, inner, tag)
    const outcome = code === 3 || code === EXIT_RUN_LOST ? 'failed' : outcomeOf(code, opts.dryRun)
    rows.push({
      name: node.name,
      outcome,
      detail:
        code === 3
          ? 'no capable CLI'
          : code === EXIT_RUN_LOST
            ? 'run lost (see node log)'
            : `exit ${String(code)}`,
    })
    host.log('')
    if (outcome === 'failed' && !opts.dryRun) {
      host.error(`  ${tag} ❌ stopping the mesh walk here; fix this node and re-run.`)
      break
    }
  }

  const stopped = rows.some((r) => r.outcome === 'failed') && !opts.dryRun
  if (!stopped) {
    host.log('  ── this node (last) ──')
    const code = await deps.migrateLocal({ ...opts, mesh: false })
    rows.push({
      name: '(local)',
      outcome: outcomeOf(code, opts.dryRun),
      detail: `exit ${String(code)}`,
    })
  }

  host.log('')
  host.log('  ══════════════════════════════════════════════')
  host.log('  Node              Result        Detail')
  host.log('  ──────────────────────────────────────────────')
  for (const r of rows) {
    host.log(`  ${r.name.padEnd(18)}${r.outcome.padEnd(14)}${r.detail}`)
  }
  host.log('  ══════════════════════════════════════════════')

  if (rows.some((r) => r.outcome === 'failed' || r.outcome === 'unreachable')) return EXIT_FAILED
  if (rows.some((r) => r.outcome === 'refused')) return EXIT_REFUSED
  return EXIT_OK
}
