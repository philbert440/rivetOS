/**
 * /etc/hosts mesh-block heal used by `rivetos update` (local + remote).
 *
 * Non-fatal by design: a drifted hosts file should not fail a deploy.
 * Failures must still be visible — silent local catch hid sudo/mesh-file
 * problems for months while the remote path already warned (#461).
 *
 * Call sites:
 * - `rivetos update --mesh` local bare-metal step + each remote node
 * - single-node `rivetos update` bare-metal/manual (added 2026-08-11; was a
 *   gap so desk/lone-CT updates never refreshed the mesh hosts block)
 *
 * Remotes must capture SSH stderr: inherit-stdio left only "exited with
 * code N" in the skip line.
 */

import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { installRoot, sharedPath } from '@rivetos/types'
import { quoteShellArg } from '../../lib/ssh.js'

/** Canonical mesh.json path — resolved at call time (honors RIVETOS_SHARED_DIR). */
export function defaultMeshFile(): string {
  return sharedPath('mesh.json')
}

/** Remote setup-mesh-hosts.sh — resolved at call time (honors RIVETOS_INSTALL_ROOT). */
export function remoteMeshHostsScript(root?: string): string {
  const raw = root?.trim()
  return join(raw ? raw : installRoot(), 'infra', 'scripts', 'setup-mesh-hosts.sh')
}

/** True when the process is uid 0 (no sudo needed for /etc/hosts). */
export function isProcessRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

/**
 * Pull a human-useful detail out of an execSync failure.
 * Prefers stderr (setup-mesh-hosts / sudo write there) over the generic message.
 */
export function formatExecFailure(err: unknown): string {
  if (err == null) return 'unknown error'
  if (typeof err === 'string') return err
  if (typeof err !== 'object') return inspect(err)

  const e = err as {
    stderr?: Buffer | string
    stdout?: Buffer | string
    message?: string
    status?: number | null
  }

  const asText = (v: Buffer | string | undefined): string => {
    if (v == null) return ''
    return (typeof v === 'string' ? v : v.toString('utf-8')).trim()
  }

  const stderr = asText(e.stderr)
  const stdout = asText(e.stdout)
  // Last few lines are usually the real error (sudo noise / script err()).
  const pick = (s: string): string =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' | ')

  if (stderr) return pick(stderr)
  if (stdout) return pick(stdout)
  if (e.message) return e.message
  if (typeof e.status === 'number') return `exited with code ${e.status}`
  return inspect(err)
}

/**
 * Human-facing skip reason for a failed hosts heal (local or remote).
 * Adds a passwordless-sudo hint when the error is the usual no-TTY gap.
 */
export function formatMeshHostsSkipDetail(err: unknown): string {
  const detail = formatExecFailure(err)
  if (/password is required|a terminal is required|no tty|a password is required/i.test(detail)) {
    return `${detail} — configure passwordless sudo for setup-mesh-hosts.sh, or re-run as root`
  }
  return detail
}

/**
 * Local command to refresh the RivetOS mesh block in /etc/hosts.
 * Uses `sudo -n` when not root so agent/no-TTY runs fail fast instead of
 * hanging on a password prompt (or failing opaquely with "needs a terminal").
 */
export function buildLocalMeshHostsCommand(
  scriptPath: string,
  meshFile: string = defaultMeshFile(),
): string {
  const prefix = isProcessRoot() ? '' : 'sudo -n '
  return `${prefix}${scriptPath} ${meshFile} --quiet`
}

/**
 * Remote SSH command for the same heal step.
 * `sudo -n` when the SSH user is not root — passwordless sudo is expected
 * on mesh nodes; if missing, the warning names the real problem.
 */
export function buildRemoteMeshHostsCommand(sshUser: string, root?: string): string {
  const meshFile = defaultMeshFile()
  const script = quoteShellArg(remoteMeshHostsScript(root))
  if (sshUser === 'root') {
    return `${script} ${meshFile} --quiet`
  }
  return `sudo -n ${script} ${meshFile} --quiet`
}

export type HealLocalResult = { ok: true } | { ok: false; detail: string }

/**
 * Run setup-mesh-hosts locally. Never throws — logs a warning on failure
 * so operators/agents see why mesh DNS may still be drifted.
 *
 * @param tag Log prefix (e.g. `"    "` or `"    [local] "`)
 */
export function healLocalMeshHosts(opts: {
  scriptPath: string
  meshFile?: string
  tag?: string
  timeoutMs?: number
}): HealLocalResult {
  const meshFile = opts.meshFile ?? defaultMeshFile()
  const tag = opts.tag ?? ''
  const cmd = buildLocalMeshHostsCommand(opts.scriptPath, meshFile)

  try {
    execSync(cmd, {
      stdio: 'pipe',
      timeout: opts.timeoutMs ?? 15_000,
      encoding: 'utf-8',
    })
    return { ok: true }
  } catch (err: unknown) {
    const detail = formatMeshHostsSkipDetail(err)
    console.log(`${tag}⚠️  /etc/hosts mesh block update skipped: ${detail}`)
    return { ok: false, detail }
  }
}
