/**
 * spawn-turn — one headless `pi --print --mode json` spawn, its flag set, its
 * child env, and the NDJSON line iterator.
 *
 * Confirmed against pi 0.85.1 (`@earendil-works/pi-coding-agent`, bin `pi`):
 *
 *   pi --print --mode json [--model m] [--session-id id | --session id]
 *      [--session-dir d] [--thinking level] <prompt>
 *
 *   - Binary name is `pi` (not `pi-coding-agent`).
 *   - The prompt is a positional ARGV value, not stdin. Linux caps a single
 *     argv element at 128 KiB (MAX_ARG_STRLEN), so the prompt is clamped —
 *     see `clampPrompt`.
 *   - `--mode json` writes the session JSONL (version 3) to stdout, one object
 *     per line, `session` line first. Parsed by `parsePiJsonLine` in wire.ts.
 *   - `--session <id>` resumes an existing session. `--session-id <uuid>` pins
 *     a NEW session (creates the id if missing). Do not pass both.
 *   - `--thinking` is `off|minimal|low|medium|high|max`. Unset = CLI default.
 *
 * Locked constraint (same as the claude-cli / kimi-code executors): no
 * RivetOS-side per-turn timeout. The runner enforces budgets between turns
 * via the abort signal; `kill()` here only bounds how long a kill can hang.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { parsePiJsonLine, type PiJsonEvent } from './wire.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Grace period between SIGTERM and SIGKILL.
 *
 * Print-mode cleanup budget was not timed on 0.85.1; 10s matches kimi-code
 * so a killed turn still has a chance to flush the session jsonl.
 */
export const KILL_GRACE_MS = 10_000

/** Max bytes of child stderr retained (only the first 500 chars are surfaced). */
export const STDERR_CAP = 64 * 1024

/**
 * Prompt clamp, in BYTES. Linux `MAX_ARG_STRLEN` is 128 KiB per argv element
 * and the whole prompt is one positional arg, so an oversized task scaffold
 * would fail the spawn with E2BIG rather than the model saying anything.
 * Clamp with a visible marker instead.
 */
export const PROMPT_MAX_BYTES = 96_000

/** Print mode should not be handed an empty prompt. */
export const EMPTY_PROMPT_PLACEHOLDER = '(no instruction was provided for this turn)'

/**
 * pi rejects a resumed session it cannot use. Exact refuse strings were not
 * sampled on 0.85.1; this matches the cwd-scoped "not found" / "different
 * directory" family plus a generic `session not found`.
 */
export const RESUME_REJECTED_RE =
  /Session "[^"]*" (?:not found|was created under a different directory)|session not found/i

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

export interface PiSpawnFlags {
  /** Path to the `pi` binary. */
  binary: string
  /** Model id for `--model` (empty/undefined = the CLI's configured default). */
  modelId?: string
  /** Native session id for `--session` — turns ≥2 of a task. Omit for a fresh session. */
  resumeSessionId?: string
  /** Pin a NEW session with `--session-id` (creates the id if missing). */
  pinSessionId?: string
  /** `--session-dir` override (tests / non-default data dir). */
  sessionDir?: string
  /** Reasoning effort for `--thinking`. Unset = CLI default. */
  thinking?: 'low' | 'medium' | 'high' | 'max' | 'minimal'
  /** Working directory. Sessions are bucketed per cwd on disk. */
  cwd?: string
}

/**
 * Assemble one `pi --print --mode json` argv. Prompt is positional last.
 * `--session-id` (pin new) and `--session` (resume existing) are mutually
 * exclusive — pin wins if both are set.
 */
export function buildArgs(flags: PiSpawnFlags, prompt: string): string[] {
  const args: string[] = ['--print', '--mode', 'json']
  if (flags.pinSessionId) args.push('--session-id', flags.pinSessionId)
  else if (flags.resumeSessionId) args.push('--session', flags.resumeSessionId)
  if (flags.sessionDir) args.push('--session-dir', flags.sessionDir)
  if (flags.modelId) args.push('--model', flags.modelId)
  if (flags.thinking) args.push('--thinking', flags.thinking)
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
// spawnPiTurn
// ---------------------------------------------------------------------------

export interface SpawnedTurn {
  /** The child process (pid / exitCode inspection). */
  proc: ChildProcessWithoutNullStreams
  /** The exact argv the child was spawned with. */
  args: string[]
  /** Wall clock immediately before spawn — the floor for the transcript reconcile. */
  startedAtMs: number
  /** Parsed print/JSON lines. Non-JSON lines are skipped. Iterate once. */
  events: () => AsyncIterable<PiJsonEvent>
  /** Capped stderr captured so far. */
  stderrText: () => string
  /** SIGTERM, then SIGKILL after the grace period. Idempotent; no-op once exited. */
  kill: () => void
  /** Resolves with the exit code (null when the child died on a signal). */
  waitExit: () => Promise<number | null>
}

/**
 * Spawn one `pi --print --mode json` turn. Throws synchronously only if
 * `spawn()` itself throws; ENOENT and friends arrive as an async `error`
 * event on `proc`, which the caller must handle (its `result` contract must
 * never reject).
 */
export function spawnPiTurn(
  flags: PiSpawnFlags,
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

  // Nothing is written on stdin — the prompt is argv. Close it so a pi build
  // that ever reads stdin sees EOF instead of hanging.
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

  async function* events(): AsyncIterable<PiJsonEvent> {
    for await (const line of iterateLines(proc.stdout)) {
      const parsed = parsePiJsonLine(line)
      if (parsed) yield parsed
    }
  }

  const waitExit = (): Promise<number | null> =>
    exitCode === undefined
      ? new Promise((resolve) => exitWaiters.push(resolve))
      : Promise.resolve(exitCode)

  return { proc, args, startedAtMs, events, stderrText: () => stderr, kill, waitExit }
}
