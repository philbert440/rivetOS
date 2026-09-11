/**
 * spawn-turn — one headless `opencode run` spawn, its flag set, its child env,
 * and the JSON-line parser.
 *
 * Drive contract (opencode 1.18.30): non-interactive
 *
 *   opencode run --format json [-m provider/model] [--variant v] [-s id] <prompt>
 *
 * `--format json` writes one JSON object per line (the same objects as the
 * `message`/`part` rows in opencode.db). `--session`/`-s` resumes an existing
 * session; a missing id exits non-zero (treated as session_not_found). There
 * is no flag to pin a NEW session id. `--variant` is the effort flag:
 * RivetOS low→minimal, medium→omit, high→high, xhigh/max→max.
 *
 * Locked constraint (same as the claude-cli / kimi-code executor): no
 * RivetOS-side per-turn timeout. The runner enforces budgets between turns
 * via the abort signal; `kill()` here only bounds how long a kill can hang.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Grace period between SIGTERM and SIGKILL.
 *
 * 10s matches kimi-code so a SIGKILL does not race the last SQLite WAL write.
 */
export const KILL_GRACE_MS = 10_000

/** Max bytes of child stderr retained (only the first 500 chars are surfaced). */
export const STDERR_CAP = 64 * 1024

/**
 * Prompt clamp, in BYTES. Linux `MAX_ARG_STRLEN` is 128 KiB per argv element
 * and `run` takes the whole prompt as one, so an oversized task scaffold would
 * fail the spawn with E2BIG rather than the model saying anything. Clamp with
 * a visible marker instead: a truncated prompt is recoverable, a dead spawn is
 * not.
 *
 * Bytes, not characters, because the kernel counts bytes: 96k CHARACTERS of
 * CJK or emoji is ~288 KiB of UTF-8 and still blows the limit — failing safe,
 * but with a spawn error instead of a truncation notice.
 */
export const PROMPT_MAX_BYTES = 96_000

/** `opencode run` is assumed to reject an empty prompt; substitute rather than spawn empty. */
export const EMPTY_PROMPT_PLACEHOLDER = '(no instruction was provided for this turn)'

// ---------------------------------------------------------------------------
// JSON line shapes (only the fields consumed here)
// ---------------------------------------------------------------------------

/**
 * One stdout JSON object from `opencode run --format json`.
 *
 * Lines are the same objects as `message`/`part` rows: user/assistant
 * envelopes (`role`) and parts (`type`: text | reasoning | step-start |
 * step-finish | tool). Parsed defensively; unknown `type` is ignored.
 */
export interface OpencodeStreamLine {
  type?: string
  role?: string
  sessionID?: string
  sessionId?: string
  session_id?: string
  text?: string
  tool?: string
  part?: Record<string, unknown>
  state?: Record<string, unknown>
  tokens?: Record<string, unknown>
  error?: unknown
  [key: string]: unknown
}

/**
 * A missing `-s/--session` id fails with a non-zero exit (wording unknown).
 * Any non-zero exit while `--session` was passed is treated as session_not_found.
 * The regex still matches the documented "Session not found" class on stderr.
 */
export const RESUME_REJECTED_RE = /session not found/i

/**
 * Map a RivetOS effort id onto OpenCode `--variant`.
 * low→minimal, medium→omit, high→high, xhigh/max→max. Unknown → omit.
 */
export function variantForEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined
  const key = effort.trim().toLowerCase()
  if (key === 'low' || key === 'minimal') return 'minimal'
  if (key === 'medium' || key === 'default' || key === '') return undefined
  if (key === 'high') return 'high'
  if (key === 'xhigh' || key === 'max') return 'max'
  return undefined
}

// ---------------------------------------------------------------------------
// Prompt + args + env
// ---------------------------------------------------------------------------

/**
 * Clamp a prompt to `PROMPT_MAX_BYTES` of UTF-8, keeping the head and saying
 * so.
 *
 * The cut is made on the byte buffer and decoded through `StringDecoder`,
 * which holds back an incomplete trailing sequence instead of emitting U+FFFD
 * — so a clamp that lands mid-character drops that character rather than
 * corrupting it.
 */
export function clampPrompt(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return EMPTY_PROMPT_PLACEHOLDER
  const bytes = Buffer.from(trimmed, 'utf8')
  if (bytes.byteLength <= PROMPT_MAX_BYTES) return trimmed
  const head = new StringDecoder('utf8').write(bytes.subarray(0, PROMPT_MAX_BYTES))
  return `${head}\n\n…[prompt truncated by RivetOS at ${String(PROMPT_MAX_BYTES)} bytes]`
}

export interface OpencodeSpawnFlags {
  /** Path to the `opencode` binary. */
  binary: string
  /** Model id for `--model` (`provider/model`). Empty/undefined = CLI default. */
  modelId?: string
  /** Native session id for `--session` — turns ≥2 of a task. Omit for a fresh session. */
  resumeSessionId?: string
  /** Working directory. Pins the project bucket AND scopes session resume. */
  cwd?: string
  /** RivetOS effort id; mapped to `--variant`. */
  effort?: string
}

/**
 * Assemble one `opencode run` argv (opencode 1.18.30):
 *   opencode run --format json [-m model] [--variant v] [-s id] <prompt>
 */
export function buildArgs(flags: OpencodeSpawnFlags, prompt: string): string[] {
  const args: string[] = ['run', '--format', 'json']
  if (flags.modelId) args.push('--model', flags.modelId)
  const variant = variantForEffort(flags.effort)
  if (variant) args.push('--variant', variant)
  if (flags.resumeSessionId) args.push('--session', flags.resumeSessionId)
  args.push(clampPrompt(prompt))
  return args
}

/**
 * Child env: inherit, then apply overrides where `undefined` DELETES an
 * inherited var (the task executor uses that to drop a surrounding den
 * terminal's RIVETOS_SESSION_KEY).
 */
export function buildChildEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined) Reflect.deleteProperty(env, k)
    else env[k] = v
  }
  return env
}

// ---------------------------------------------------------------------------
// Line iterator
// ---------------------------------------------------------------------------

export async function* iterateLines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buffer = ''
  for await (const chunk of stream) {
    const str: string = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    buffer += str
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      yield buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      idx = buffer.indexOf('\n')
    }
  }
  if (buffer.length > 0) yield buffer
}

// ---------------------------------------------------------------------------
// spawnOpencodeTurn
// ---------------------------------------------------------------------------

export interface SpawnedTurn {
  /** The child process (pid / exitCode inspection). */
  proc: ChildProcessWithoutNullStreams
  /** The exact argv the child was spawned with. */
  args: string[]
  /** Wall clock immediately before spawn — the floor for the wire reconcile. */
  startedAtMs: number
  /** Parsed JSON lines. Non-JSON lines are skipped. Iterate once. */
  events: () => AsyncIterable<OpencodeStreamLine>
  /** Capped stderr captured so far. */
  stderrText: () => string
  /** SIGTERM, then SIGKILL after the grace period. Idempotent; no-op once exited. */
  kill: () => void
  /** Resolves with the exit code (null when the child died on a signal). */
  waitExit: () => Promise<number | null>
}

/**
 * Spawn one `opencode run` turn. Throws synchronously only if `spawn()` itself
 * throws; ENOENT and friends arrive as an async `error` event on `proc`, which
 * the caller must handle (its `result` contract must never reject).
 */
export function spawnOpencodeTurn(
  flags: OpencodeSpawnFlags,
  prompt: string,
  opts?: { env?: Record<string, string | undefined>; killGraceMs?: number },
): SpawnedTurn {
  const args = buildArgs(flags, prompt)
  const startedAtMs = Date.now()

  const proc = spawn(flags.binary, args, {
    env: buildChildEnv(opts?.env),
    cwd: flags.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Nothing is written on stdin — the prompt is argv. Close it so an opencode
  // build that ever reads stdin (ACP mode) sees EOF instead of hanging.
  proc.stdin.end()

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

  // Exit is latched from a listener attached HERE, at spawn time, and every
  // waitExit() reads the latch. Two ways an attach-on-demand version could
  // hang forever, both on paths this executor leans on:
  //   - the child closes before the first waitExit() call, so `close` has
  //     already fired by the time the listener is attached; and
  //   - a signal death, where `proc.exitCode` stays null, so the
  //     "already exited" shortcut never fires either.
  // A hung waitExit strands the turn, and `result` must resolve on every
  // terminal path.
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

  async function* events(): AsyncIterable<OpencodeStreamLine> {
    for await (const line of iterateLines(proc.stdout)) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      yield parsed as OpencodeStreamLine
    }
  }

  const waitExit = (): Promise<number | null> =>
    exitCode === undefined
      ? new Promise((resolve) => exitWaiters.push(resolve))
      : Promise.resolve(exitCode)

  return { proc, args, startedAtMs, events, stderrText: () => stderr, kill, waitExit }
}
