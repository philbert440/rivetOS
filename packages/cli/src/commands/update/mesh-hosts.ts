/**
 * /etc/hosts mesh-block heal used by `rivetos update` (local + remote).
 *
 * Non-fatal by design: a drifted hosts file should not fail a deploy.
 * Failures must still be visible — silent local catch hid sudo/mesh-file
 * problems for months while the remote path already warned.
 */

import { execSync } from 'node:child_process'

export const DEFAULT_MESH_FILE = '/rivet-shared/mesh.json'
export const REMOTE_MESH_HOSTS_SCRIPT = '/opt/rivetos/infra/scripts/setup-mesh-hosts.sh'

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
  if (typeof err !== 'object') return String(err)

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
  return String(err)
}

/**
 * Local command to refresh the RivetOS mesh block in /etc/hosts.
 * Uses `sudo -n` when not root so agent/no-TTY runs fail fast instead of
 * hanging on a password prompt (or failing opaquely with "needs a terminal").
 */
export function buildLocalMeshHostsCommand(
  scriptPath: string,
  meshFile: string = DEFAULT_MESH_FILE,
): string {
  const prefix = isProcessRoot() ? '' : 'sudo -n '
  return `${prefix}${scriptPath} ${meshFile} --quiet`
}

/**
 * Remote SSH command for the same heal step.
 * `sudo -n` when the SSH user is not root — passwordless sudo is expected
 * on mesh nodes; if missing, the warning names the real problem.
 */
export function buildRemoteMeshHostsCommand(sshUser: string): string {
  if (sshUser === 'root') {
    return `${REMOTE_MESH_HOSTS_SCRIPT} ${DEFAULT_MESH_FILE} --quiet`
  }
  return `sudo -n ${REMOTE_MESH_HOSTS_SCRIPT} ${DEFAULT_MESH_FILE} --quiet`
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
  const meshFile = opts.meshFile ?? DEFAULT_MESH_FILE
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
    let detail = formatExecFailure(err)
    // Nudge when the failure is the usual passwordless-sudo gap.
    if (/password is required|a terminal is required|no tty|a password is required/i.test(detail)) {
      detail = `${detail} — configure passwordless sudo for setup-mesh-hosts.sh, or re-run as root`
    }
    console.log(`${tag}⚠️  /etc/hosts mesh block update skipped: ${detail}`)
    return { ok: false, detail }
  }
}
