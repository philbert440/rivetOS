/**
 * spawn-turn — one interactive `dsh --profile tui` spawn, its flag set, and
 * its child env.
 *
 * Verified against @deepseek-ai/dsh 0.1.1-rc.2 on ct117 (`dsh --help`):
 *
 *   dsh --profile tui                      ← fresh TUI session
 *   dsh --profile tui --resume <session>   ← reopen an existing native id
 *
 * `--resume` is an APP flag after `--profile tui`, not a launcher pin. There
 * is no `--session-id`. The CLI mints `session-<uuid>` itself and files it
 * under `$DSH_HOME/sessions/<cwd-slug>/session-<uuid>/`.
 *
 * This is the den-session form. Capture is out-of-band (Cordis session/event
 * plugin) — this spawn installs no hooks and does not parse a stream-json
 * wire. The den term manager uses node-pty + the roster argv; this helper is
 * the unit-tested flag/env surface and the exit latch the executor wraps.
 *
 * Locked constraint (same as claude-cli / kimi-code): no RivetOS-side
 * per-turn timeout. `kill()` here only bounds how long a kill can hang.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Grace period between SIGTERM and SIGKILL. TUI has no wire-flush budget. */
export const KILL_GRACE_MS = 2_000

/** Max bytes of child stderr retained (only the first 500 chars are surfaced). */
export const STDERR_CAP = 64 * 1024

// ---------------------------------------------------------------------------
// Args + env
// ---------------------------------------------------------------------------

export interface DshSpawnFlags {
  /** Absolute path to the `dsh` binary. Den PATH has no ~/.local/bin. */
  binary: string
  /**
   * Native session id for `--resume`. Omit for a fresh session. dsh has no
   * `--session-id` pin — a fresh spawn lets the CLI mint the id.
   */
  resumeSessionId?: string
  /** Working directory. Pins the cwd-slug bucket under ~/.dsh/sessions/. */
  cwd?: string
}

/**
 * Assemble one interactive TUI argv.
 *
 * Never a `--session-id` (dsh has none). Never a model flag (model is pinned
 * in `~/.dsh/cordis.patch.yml`). `--resume` comes after `--profile tui`.
 */
export function buildArgs(flags: DshSpawnFlags): string[] {
  const args = ['--profile', 'tui']
  if (flags.resumeSessionId) args.push('--resume', flags.resumeSessionId)
  return args
}

/**
 * Child env: inherit, then apply overrides where `undefined` DELETES an
 * inherited var (the den executor uses that to drop a surrounding terminal's
 * RIVETOS_SESSION_KEY so out-of-band capture does not file TUI turns into
 * the wrong conversation).
 *
 * `DSH_HOME` is always scrubbed unless the caller set it: an inherited value
 * from the operator's shell would silently point the session store at a
 * different tree than the one the control plane reads.
 */
export function buildChildEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined) Reflect.deleteProperty(env, k)
    else env[k] = v
  }
  if (extra === undefined || !Object.prototype.hasOwnProperty.call(extra, 'DSH_HOME')) {
    delete env.DSH_HOME
  }
  return env
}

// ---------------------------------------------------------------------------
// spawnDshTui
// ---------------------------------------------------------------------------

export interface SpawnedTurn {
  /** The child process (pid / exitCode inspection). */
  proc: ChildProcessWithoutNullStreams
  /** The exact argv the child was spawned with. */
  args: string[]
  /** Wall clock immediately before spawn. */
  startedAtMs: number
  /** Capped stderr captured so far. */
  stderrText: () => string
  /** SIGTERM, then SIGKILL after the grace period. Idempotent; no-op once exited. */
  kill: () => void
  /** Resolves with the exit code (null when the child died on a signal). */
  waitExit: () => Promise<number | null>
}

/**
 * Spawn one interactive `dsh --profile tui` process. Throws synchronously
 * only if `spawn()` itself throws; ENOENT and friends arrive as an async
 * `error` event on `proc`.
 *
 * stdin stays OPEN — this is a TUI, not a one-shot `-p` prompt. Callers that
 * do not drive the TUI should still close stdin themselves.
 */
export function spawnDshTui(
  flags: DshSpawnFlags,
  opts?: { env?: Record<string, string | undefined>; killGraceMs?: number },
): SpawnedTurn {
  const args = buildArgs(flags)
  const startedAtMs = Date.now()

  const proc = spawn(flags.binary, args, {
    env: buildChildEnv(opts?.env),
    cwd: flags.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const graceMs = opts?.killGraceMs ?? KILL_GRACE_MS
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const exited = (): boolean => proc.exitCode !== null || proc.signalCode !== null
  const kill = (): void => {
    if (exited()) return
    if (!proc.killed) proc.kill('SIGTERM')
    if (!killTimer) {
      killTimer = setTimeout(() => {
        if (!exited()) proc.kill('SIGKILL')
      }, graceMs)
      killTimer.unref()
    }
  }

  // Exit is latched from a listener attached HERE, at spawn time — same
  // reason as kimi-code: attach-on-demand waitExit hangs when close already
  // fired or the child died on a signal (exitCode stays null).
  let exitCode: number | null | undefined
  const exitWaiters: Array<(code: number | null) => void> = []
  proc.once('close', (code) => {
    exitCode = code
    if (killTimer) clearTimeout(killTimer)
    for (const waiter of exitWaiters.splice(0)) waiter(code)
  })

  let stderr = ''
  proc.stderr.on('data', (d: Buffer) => {
    if (stderr.length < STDERR_CAP) stderr += d.toString()
  })

  const waitExit = (): Promise<number | null> =>
    exitCode === undefined
      ? new Promise((resolve) => exitWaiters.push(resolve))
      : Promise.resolve(exitCode)

  return { proc, args, startedAtMs, stderrText: () => stderr, kill, waitExit }
}
