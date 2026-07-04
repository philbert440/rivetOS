/**
 * SSH + systemd helpers shared across `update`, `mesh`, and `doctor`.
 *
 * Two execution styles:
 *   - `sshExec`      — streamed (stdio inherit), used for long/visible steps.
 *   - `sshExecQuiet` — captured stdout, used for quick non-critical probes.
 *
 * Host/user values that flow into these come from mesh.json and `--ssh-user`;
 * callers should validate `--ssh-user` via `isSafeArg` before passing it in.
 */

import { execSync, spawn } from 'node:child_process'

const SSH_BASE_OPTS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=5',
  '-o',
  'StrictHostKeyChecking=no',
]

/**
 * Allowlist for values interpolated into shell commands (version tags, channels,
 * ssh users, unit names). Permits letters, digits, and `.`, `_`, `-`, `/`, `@`,
 * `:` — everything a real ref/user needs and nothing a shell treats specially.
 */
const SAFE_ARG = /^[\w.\-/@:]+$/

export function isSafeArg(value: string): boolean {
  return value.length > 0 && SAFE_ARG.test(value)
}

/**
 * Throw if `value` contains shell metacharacters. Use at the boundary where a
 * user-supplied value (--version, --channel, --ssh-user) first enters a command.
 */
export function assertSafeArg(value: string, label: string): string {
  if (!isSafeArg(value)) {
    throw new Error(
      `Refusing unsafe ${label} "${value}" — only letters, digits and . _ - / @ : are allowed.`,
    )
  }
  return value
}

/**
 * Run a command on a remote host via SSH using spawn (non-blocking, streamed).
 * Resolves on exit 0; rejects on non-zero exit, spawn error, or timeout.
 */
export function sshExec(
  host: string,
  command: string,
  label: string,
  timeoutMs: number,
  sshUser = 'rivet',
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('ssh', [...SSH_BASE_OPTS, `${sshUser}@${host}`, command], {
      stdio: 'inherit',
      env: { ...process.env, HOME: process.env.HOME ?? '/root' },
    })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`${label} timed out after ${String(Math.round(timeoutMs / 1000))}s`))
    }, timeoutMs)

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${label} spawn error: ${err.message}`))
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`${label} exited with code ${String(code)}`))
    })
  })
}

/**
 * Quick SSH command that returns stdout, or empty string on failure.
 * Used for non-critical checks like reading the remote commit SHA.
 */
export function sshExecQuiet(host: string, command: string, sshUser = 'rivet'): string {
  try {
    return execSync(
      `ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no ${sshUser}@${host} "${command}"`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
  } catch {
    return ''
  }
}

/**
 * Resolve the SSH user for a remote host. Tries the requested user first; if
 * auth fails, falls back to `root` with a warning. Returns the working user, or
 * null if both fail.
 */
export function resolveSshUser(
  host: string,
  requestedUser: string | string[],
  tag: string,
): string | null {
  const tryUser = (user: string): boolean => {
    try {
      execSync(
        `ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no ${user}@${host} "echo ok"`,
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      return true
    } catch {
      return false
    }
  }

  const candidates = [...new Set(Array.isArray(requestedUser) ? requestedUser : [requestedUser])]
  for (const user of candidates) {
    if (tryUser(user)) return user
  }

  if (!candidates.includes('root') && tryUser('root')) {
    console.error(
      `    ${tag} [warn] node not reachable as ${candidates.join('/')}, falling back to root`,
    )
    return 'root'
  }

  return null
}

/**
 * Quick SSH reachability check (boolean). Tries requestedUser then root@.
 */
export function checkSshReachable(host: string, requestedUser = 'rivet'): boolean {
  const usersToTry = requestedUser !== 'root' ? [requestedUser, 'root'] : ['root']
  for (const user of usersToTry) {
    try {
      execSync(
        `ssh -o ConnectTimeout=3 -o BatchMode=yes -o StrictHostKeyChecking=no ${user}@${host} "echo ok"`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      if (user !== requestedUser) {
        console.error(
          `    [warn] ${host} not yet migrated to ${requestedUser} user, SSH succeeded as root`,
        )
      }
      return true
    } catch {
      // try next user
    }
  }
  return false
}

/**
 * Restart a local systemd unit, trying direct `systemctl` then `sudo systemctl`.
 * Returns true if either succeeded. Never throws.
 */
export function restartViaSystemd(unit = 'rivetos'): boolean {
  for (const cmd of [`systemctl restart ${unit}`, `sudo systemctl restart ${unit}`]) {
    try {
      execSync(cmd, { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] })
      return true
    } catch {
      // try next
    }
  }
  return false
}
