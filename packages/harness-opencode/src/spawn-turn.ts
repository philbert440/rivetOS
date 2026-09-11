/**
 * spawn-turn — one headless `opencode run` spawn, its flag set, its child env,
 * and the JSON-line parser.
 *
 * Drive contract (spec + README): non-interactive `opencode run "<prompt>"`.
 * There is also an ACP nd-JSON server over stdin/stdout; this executor does
 * not speak ACP. JSON session export/import is a session-create candidate,
 * not the turn protocol.
 *
 * REVIEWER-CONFIRM: exact argv vs installed opencode 1.18.25 (`opencode run
 * --help`). Assumed shape, mirroring kimi's `-p --output-format stream-json`:
 *
 *   opencode run [--session <id>] [--model <provider/model>] --format json <prompt>
 *
 * What that assumption gives us:
 *   - The prompt is an ARGV value, not stdin. Linux caps a single argv
 *     element at 128 KiB (MAX_ARG_STRLEN), so the prompt is clamped — see
 *     `clampPrompt`.
 *   - `--format json` writes one JSON object per line to stdout. Parsed
 *     objects are yielded as `OpencodeStreamLine`; `wire.parseOpencodeEvent`
 *     interprets the schema.
 *   - `--session <id>` resumes an existing session. Omit for a fresh session.
 *   - `--model` is `provider/model` (e.g. `zai/glm-5.3-flash`).
 *
 * REVIEWER-CONFIRM: session-create path. Known headless bug class: `run`
 * reports "Session not found" when no session exists yet. A resume that
 * hits `RESUME_REJECTED_RE` retries once without `--session` (fresh). A
 * FRESH spawn that hits it is a failed turn — retrying fresh would loop.
 * Confirm against v1.18.25 how a session is minted non-interactively
 * (HTTP `POST /session` on `opencode serve`, JSON import, a minting flag
 * such as `--title`, or ACP initialize) and wire that in front of the
 * first `run` if needed.
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
 * REVIEWER-CONFIRM: opencode's headless cleanup budget is unknown. 10s
 * matches kimi-code so a SIGKILL does not race the last storage write.
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
 * REVIEWER-CONFIRM: exact event schema vs installed opencode 1.18.25. The
 * interpreter lives in `wire.parseOpencodeEvent`; this type is the raw line.
 */
export interface OpencodeStreamLine {
  type?: string
  sessionID?: string
  sessionId?: string
  session_id?: string
  text?: string
  part?: Record<string, unknown>
  tokens?: Record<string, unknown>
  error?: unknown
  [key: string]: unknown
}

/**
 * opencode rejects a session it cannot use, by message rather than (only) by
 * exit code. Both a missing-session fresh `run` and a stale `--session` hit
 * this class.
 *
 * REVIEWER-CONFIRM: exact stderr/stdout wording on v1.18.25.
 */
export const RESUME_REJECTED_RE = /session not found/i

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
}

/**
 * Assemble one `opencode run` argv.
 *
 * REVIEWER-CONFIRM: flag names and prompt position vs `opencode run --help`
 * on v1.18.25. Assumed:
 *   - subcommand `run` first
 *   - `--session <id>` to resume (not `--continue`, which is "last session")
 *   - `--model <provider/model>`
 *   - `--format json` always, so the stream parser has a contract
 *   - prompt as the terminal positional (readable in logs and fake-binary fixtures)
 * No ACP flags. No permission/`--yolo` analog (unknown on this CLI).
 */
export function buildArgs(flags: OpencodeSpawnFlags, prompt: string): string[] {
  const args: string[] = ['run']
  if (flags.resumeSessionId) args.push('--session', flags.resumeSessionId)
  if (flags.modelId) args.push('--model', flags.modelId)
  args.push('--format', 'json')
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
