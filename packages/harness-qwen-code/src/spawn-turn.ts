/**
 * spawn-turn — one headless `qwen -p --output-format stream-json` spawn, its
 * flag set, its child env, and the NDJSON line iterator.
 *
 * Confirmed against Qwen Code 0.23.4 (`@qwen-code/qwen-code`, bin `qwen`):
 *
 *   qwen -p <prompt> --output-format stream-json --include-partial-messages
 *        --approval-mode yolo [--session-id id | --resume id] [-m model]
 *        [--append-system-prompt text] [--max-session-turns N]
 *
 *   - Binary name is `qwen`.
 *   - The prompt is an ARGV value after `-p`, not stdin. Linux caps a single
 *     argv element at 128 KiB (MAX_ARG_STRLEN), so the prompt is clamped —
 *     see `clampPrompt`.
 *   - `--output-format stream-json` writes a Claude-shaped runtime event
 *     stream to stdout (system/init, stream_event deltas, assistant, user
 *     tool_result, result). Parsed by `parseQwenJsonLine` in wire.ts.
 *   - stdin is appended to the prompt and the process waits if the fd is
 *     open. Spawn with stdin ignored.
 *   - `--session-id <uuid>` pins a NEW session. `--resume <uuid>` resumes an
 *     existing one. Do not pass both. Resume is cwd-scoped.
 *   - `--approval-mode yolo` auto-approves; suppress the stderr warning with
 *     `QWEN_CODE_SUPPRESS_YOLO_WARNING=1`.
 *   - `--append-system-prompt` carries the task scaffold.
 *
 * Locked constraint (same as the claude-cli / pi executors): no RivetOS-side
 * per-turn timeout. The runner enforces budgets between turns via the abort
 * signal; `kill()` here only bounds how long a kill can hang.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { parseQwenJsonLine, type QwenJsonEvent } from './wire.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Grace period between SIGTERM and SIGKILL.
 *
 * 10s matches pi / kimi-code so a killed turn still has a chance to flush
 * the session jsonl.
 */
export const KILL_GRACE_MS = 10_000

/** Max bytes of child stderr retained (only the first 500 chars are surfaced). */
export const STDERR_CAP = 64 * 1024

/** Max bytes of child stdout retained (resume-rejected text is on stdout). */
export const STDOUT_CAP = 64 * 1024

/**
 * Prompt clamp, in BYTES. Linux `MAX_ARG_STRLEN` is 128 KiB per argv element
 * and the whole prompt is one `-p` arg, so an oversized task scaffold would
 * fail the spawn with E2BIG rather than the model saying anything.
 * Clamp with a visible marker instead.
 */
export const PROMPT_MAX_BYTES = 96_000

/** Headless `-p` should not be handed an empty prompt. */
export const EMPTY_PROMPT_PLACEHOLDER = '(no instruction was provided for this turn)'

/**
 * qwen rejects a resumed session it cannot use (unknown id, or a different
 * cwd). Verified on 0.23.4: the string is printed on stdout and the process
 * exits 0 with no `system/init` line.
 */
export const RESUME_REJECTED_RE = /No saved session found with ID/

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

export interface QwenSpawnFlags {
  /** Path to the `qwen` binary. */
  binary: string
  /** Model id for `-m` (empty/undefined = the CLI's configured default). */
  modelId?: string
  /** Native session id for `--resume` — turns ≥2 of a task. Omit for a fresh session. */
  resumeSessionId?: string
  /** Pin a NEW session with `--session-id` (creates the id if missing). */
  pinSessionId?: string
  /** `--append-system-prompt` (task scaffold). Omit when empty. */
  appendSystemPrompt?: string
  /** `--max-session-turns N`. Omit when unset. */
  maxSessionTurns?: number
  /**
   * Working directory. Sessions are cwd-scoped on disk — every turn of a
   * task MUST use the same one.
   */
  cwd?: string
}

/**
 * Assemble one `qwen -p --output-format stream-json` argv. Prompt is the `-p`
 * value (clamped). `--session-id` (pin new) and `--resume` (resume existing)
 * are mutually exclusive — pin wins if both are set.
 */
export function buildArgs(flags: QwenSpawnFlags, prompt: string): string[] {
  const args: string[] = [
    '-p',
    clampPrompt(prompt),
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--approval-mode',
    'yolo',
  ]
  if (flags.pinSessionId) args.push('--session-id', flags.pinSessionId)
  else if (flags.resumeSessionId) args.push('--resume', flags.resumeSessionId)
  if (flags.modelId) args.push('-m', flags.modelId)
  if (flags.appendSystemPrompt) args.push('--append-system-prompt', flags.appendSystemPrompt)
  if (flags.maxSessionTurns !== undefined) {
    args.push('--max-session-turns', String(flags.maxSessionTurns))
  }
  return args
}

/**
 * Child env: inherit, then apply overrides where `undefined` DELETES an
 * inherited var (the task executor uses that to drop a surrounding den
 * terminal's RIVETOS_SESSION_KEY). Always sets
 * `QWEN_CODE_SUPPRESS_YOLO_WARNING=1` unless the caller overrides it.
 */
export function buildChildEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' }
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
// spawnQwenTurn
// ---------------------------------------------------------------------------

export interface SpawnedTurn {
  /** The child process (pid / exitCode inspection). stdin is ignored. */
  proc: ChildProcess
  /** The exact argv the child was spawned with. */
  args: string[]
  /** Wall clock immediately before spawn — the floor for the transcript reconcile. */
  startedAtMs: number
  /** Parsed stream-json lines. Non-JSON lines are skipped. Iterate once. */
  events: () => AsyncIterable<QwenJsonEvent>
  /** Capped stderr captured so far. */
  stderrText: () => string
  /** Capped stdout captured so far (resume-rejected text is on stdout). */
  stdoutText: () => string
  /** SIGTERM, then SIGKILL after the grace period. Idempotent; no-op once exited. */
  kill: () => void
  /** Resolves with the exit code (null when the child died on a signal). */
  waitExit: () => Promise<number | null>
}

/**
 * Spawn one `qwen -p --output-format stream-json` turn. Throws synchronously
 * only if `spawn()` itself throws; ENOENT and friends arrive as an async
 * `error` event on `proc`, which the caller must handle (its `result`
 * contract must never reject).
 */
export function spawnQwenTurn(
  flags: QwenSpawnFlags,
  prompt: string,
  opts?: { env?: Record<string, string | undefined>; killGraceMs?: number },
): SpawnedTurn {
  const args = buildArgs(flags, prompt)
  const startedAtMs = Date.now()

  const proc = spawn(flags.binary, args, {
    env: buildChildEnv(opts?.env),
    cwd: flags.cwd,
    // qwen appends stdin to the prompt and waits if the fd is open.
    stdio: ['ignore', 'pipe', 'pipe'],
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

  let stdoutCap = ''
  async function* events(): AsyncIterable<QwenJsonEvent> {
    const stdout = proc.stdout
    if (!stdout) return
    for await (const line of iterateLines(stdout)) {
      if (stdoutCap.length < STDOUT_CAP) {
        stdoutCap += (stdoutCap === '' ? '' : '\n') + line
      }
      const parsed = parseQwenJsonLine(line)
      if (parsed) yield parsed
    }
  }

  const waitExit = (): Promise<number | null> =>
    exitCode === undefined
      ? new Promise((resolve) => exitWaiters.push(resolve))
      : Promise.resolve(exitCode)

  return {
    proc,
    args,
    startedAtMs,
    events,
    stderrText: () => stderr,
    stdoutText: () => stdoutCap,
    kill,
    waitExit,
  }
}
