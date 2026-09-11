/**
 * Detect coding harnesses on PATH (and a few well-known extra dirs) so
 * `rivetos plugins install` and `rivetos doctor` can wire memory capture
 * only into binaries that actually exist on this laptop.
 *
 * Independent of boot / embedded PG. The PATH walk is a copy of den-server
 * `term/tmux.ts` `findOnPath` (not exported from there) plus extra dirs that
 * a login-shell PATH often omits when the CLI is launched from systemd or
 * a GUI.
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { HARNESS_IDS, type HarnessId } from '@rivetos/types'

/** Binary name on PATH for each harness id. `codex` is already a HarnessId;
 *  the `| 'codex'` is kept so the map reads the same as the install task. */
export const HARNESS_BINARIES: Record<HarnessId | 'codex', string> = {
  'claude-code': 'claude',
  'grok-build': 'grok',
  'kimi-code': 'kimi',
  hermes: 'hermes',
  'deepseek-harness': 'dsh',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
}

/** `providers.<key>` in config.yaml — deepseek-harness is not a CLI harness
 *  provider (`CLI_HARNESS_PROVIDERS` in @rivetos/boot). */
export type HarnessProviderKey =
  | 'claude-cli'
  | 'grok-cli'
  | 'kimi-code'
  | 'hermes-cli'
  | 'codex-cli'
  | 'opencode-cli'
  | 'pi-cli'

export const HARNESS_PROVIDER_KEYS: Record<HarnessId, HarnessProviderKey | undefined> = {
  'claude-code': 'claude-cli',
  'grok-build': 'grok-cli',
  'kimi-code': 'kimi-code',
  hermes: 'hermes-cli',
  'deepseek-harness': undefined,
  codex: 'codex-cli',
  opencode: 'opencode-cli',
  pi: 'pi-cli',
}

/** Config-home directory name under `$HOME`. Kimi's setup script also
 *  understands `~/.kimi-code`; detection reports `~/.kimi` as specified. */
export const HARNESS_CONFIG_DIRS: Record<HarnessId, string> = {
  'claude-code': '.claude',
  'grok-build': '.grok',
  'kimi-code': '.kimi',
  hermes: '.hermes',
  'deepseek-harness': '.dsh',
  codex: '.codex',
  // OpenCode is XDG: `$XDG_CONFIG_HOME/opencode` else `~/.config/opencode`.
  opencode: '.config/opencode',
  pi: '.pi/agent',
}

const HERMES_VENV_REL = join('hermes-agent', 'venv')

/** Well-known extra dirs searched after PATH. `~` is expanded against `home`. */
export const DEFAULT_EXTRA_DIRS = [
  '~/.local/bin',
  '~/.npm-global/bin',
  '~/.bun/bin',
  '~/.local/share/mise/shims',
  '/opt/homebrew/bin',
  '/usr/local/bin',
]

export interface FindOnPathOpts {
  pathEnv?: string
  extraDirs?: string[]
  home?: string
}

export interface DetectedHarness {
  id: HarnessId
  /** argv[0] / roster key — `claude`, `grok`, `kimi`, `hermes`, `dsh`, `codex`. */
  command: string
  /** Absolute path of the executable. */
  binary: string
  providerKey: HarnessProviderKey | undefined
  configHome: string
  version?: string
  /** Hermes only: `~/.hermes/hermes-agent/venv` when that directory exists. */
  venv?: string
  /** OpenCode only: `$XDG_DATA_HOME/opencode` else `~/.local/share/opencode`. */
  dataHome?: string
}

export interface DetectHarnessesOpts {
  pathEnv?: string
  extraDirs?: string[]
  home?: string
  /** Skip the best-effort `--version` spawn (tests). */
  skipVersion?: boolean
  exec?: typeof execFileAsync
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

/** Spawn errors/signals (`code: null`), timeouts, and non-zero exits are failures. */
export function execFailed(result: ExecResult): boolean {
  return result.timedOut || result.code !== 0
}

/**
 * Async `execFile` with a timeout. Never `spawnSync` — a local-mode node
 * hosts the PGlite socket in-process and a blocking spawn starves it.
 *
 * Spawned detached so the timeout can SIGTERM/SIGKILL the whole process
 * group (grandchildren inherit the pipes; killing only the child leaves
 * `close` hanging). Resolves on `exit`, not `close`, and stops waiting
 * on the pipes once the leader is gone.
 */
export function execFileAsync(
  file: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<ExecResult> {
  const { timeoutMs = 15_000, env, cwd } = opts
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      env: env ?? process.env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      const pid = child.pid
      if (pid) {
        killProcessGroup(pid, 'SIGTERM')
        killTimer = setTimeout(() => {
          killProcessGroup(pid, 'SIGKILL')
        }, 2_000)
      }
    }, timeoutMs)
    const settle = (result: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // When we timed out, the leader often dies on SIGTERM immediately.
      // Keep the scheduled group SIGKILL so SIGTERM-resistant grandchildren
      // (npm/pip, `trap "" TERM`) still get reaped ~2 s later.
      if (!timedOut && killTimer !== undefined) clearTimeout(killTimer)
      child.stdout?.removeAllListeners('data')
      child.stderr?.removeAllListeners('data')
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve(result)
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      settle({ stdout, stderr: stderr || err.message, code: null, timedOut })
    })
    child.on('exit', (code) => {
      settle({ stdout, stderr, code, timedOut })
    })
  })
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return home + p.slice(1)
  return p
}

/** which(1)-style lookup over PATH (+ extra dirs) with fs.access — no shell.
 *  Returns the absolute path of the first executable regular file, else null. */
export function findOnPath(name: string, opts: FindOnPathOpts = {}): string | null {
  const home = opts.home ?? homedir()
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? ''
  const extra = (opts.extraDirs ?? DEFAULT_EXTRA_DIRS).map((d) => expandHome(d, home))
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const dir of [...pathEnv.split(delimiter), ...extra]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  for (const dir of dirs) {
    const candidate = resolve(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (!statSync(candidate).isFile()) continue
      return candidate
    } catch {
      // not here — keep looking
    }
  }
  return null
}

async function probeVersion(bin: string, exec: typeof execFileAsync): Promise<string | undefined> {
  const result = await exec(bin, ['--version'], { timeoutMs: 3_000 })
  if (result.timedOut || result.code !== 0) return undefined
  const line = result.stdout.trim().split('\n')[0]?.trim()
  return line || undefined
}

export async function detectHarnesses(opts: DetectHarnessesOpts = {}): Promise<DetectedHarness[]> {
  const home = opts.home ?? homedir()
  const exec = opts.exec ?? execFileAsync
  const found: DetectedHarness[] = []
  const pending: Array<Promise<void>> = []

  for (const id of HARNESS_IDS) {
    const command = HARNESS_BINARIES[id]
    const binary = findOnPath(command, {
      pathEnv: opts.pathEnv,
      extraDirs: opts.extraDirs,
      home,
    })
    if (!binary) continue
    const configHome =
      id === 'opencode'
        ? join(process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'opencode')
        : join(home, HARNESS_CONFIG_DIRS[id])
    const harness: DetectedHarness = {
      id,
      command,
      binary,
      providerKey: HARNESS_PROVIDER_KEYS[id],
      configHome,
    }
    if (id === 'hermes') {
      const venv = join(configHome, HERMES_VENV_REL)
      if (existsSync(venv)) harness.venv = venv
    }
    if (id === 'opencode') {
      harness.dataHome = join(
        process.env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'),
        'opencode',
      )
    }
    found.push(harness)
  }

  // Version probes only after the PATH walk, and only when at least one
  // binary was found — doctor should not pay six `--version` spawns on a
  // node with no coding harnesses.
  if (!opts.skipVersion && found.length > 0) {
    for (const harness of found) {
      pending.push(
        probeVersion(harness.binary, exec).then((version) => {
          if (version) harness.version = version
        }),
      )
    }
  }

  if (pending.length > 0) await Promise.all(pending)
  return found
}
