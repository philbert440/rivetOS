/**
 * spawn-turn — one headless `kimi -p` spawn, its flag set, its child env, and
 * the stream-json line parser.
 *
 * Verified against kimi-code 0.34.0 (`~/.local/lib/node_modules/@moonshot-ai/
 * kimi-code/dist/main.mjs`, `src/cli/v2/run-v2-print.ts` + `PromptJsonWriter`
 * in `src/cli/prompt-render.ts`). What that runner actually gives us:
 *
 *   - The prompt is an ARGV value (`-p <text>`), not stdin. Linux caps a single
 *     argv element at 128 KiB (MAX_ARG_STRLEN), so the prompt is clamped —
 *     see `clampPrompt`.
 *   - `--output-format stream-json` writes one JSON object per line to stdout,
 *     each via a plain `stdout.write(JSON.stringify(msg) + '\n')`, flushed at
 *     step boundaries (`flushAssistant`), so the stream is live over a pipe:
 *       {"role":"meta","type":"system.version","version":"0.34.0"}      ← always first
 *       {"role":"assistant","content":"…","tool_calls":[…]}             ← one line MAY carry both
 *       {"role":"tool","tool_call_id":"Bash_0","content":"…"}
 *       {"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>",…}
 *     `session.resume_hint` is the ONLY stdout carrier of the session id, and
 *     it is written AFTER the turn — a failed turn throws before it, so the id
 *     has to be recovered from disk (see wire.ts).
 *   - There is NO usage, NO result event and NO error event on stdout. Errors
 *     are stderr text plus a non-zero exit; usage lives in wire.jsonl.
 *   - Prompt mode forces permission mode `auto` internally and REJECTS
 *     `--auto`/`--yolo`/`--plan` ("Cannot combine --prompt with --auto"), so
 *     this never passes a permission flag.
 *   - `-S <id> -p <text>` resumes an existing session headlessly, keeps the
 *     same session id, and appends to the same wire.jsonl. The resume is
 *     cwd-scoped: kimi throws `Session "<id>" was created under a different
 *     directory.` when `process.cwd()` differs from the session's workDir, so
 *     every turn of a task MUST spawn with the same cwd.
 *
 * Locked constraint (same as the claude-cli executor): no RivetOS-side
 * per-turn timeout. The runner enforces budgets between turns via the abort
 * signal; `kill()` here only bounds how long a kill can hang.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Grace period between SIGTERM and SIGKILL.
 *
 * Deliberately longer than the claude-cli executor's 2s: kimi's
 * `installPromptTerminationCleanup` runs an async cleanup bounded by
 * `PROMPT_CLEANUP_TIMEOUT_MS = 8_000` (plus `HEADLESS_FORCE_EXIT_GRACE_MS =
 * 2_000`), and the last wire.jsonl batch — the turn's `usage.record`s and its
 * `turn.ended` — is only durable if that cleanup gets to run. SIGKILLing at 2s
 * would throw away the usage of every killed turn.
 */
export const KILL_GRACE_MS = 10_000

/** Max bytes of child stderr retained (only the first 500 chars are surfaced). */
export const STDERR_CAP = 64 * 1024

/**
 * Prompt clamp, in BYTES. Linux `MAX_ARG_STRLEN` is 128 KiB per argv element
 * and kimi takes the whole prompt as one, so an oversized task scaffold would
 * fail the spawn with E2BIG rather than the model saying anything. Clamp with
 * a visible marker instead: a truncated prompt is recoverable, a dead spawn is
 * not.
 *
 * Bytes, not characters, because the kernel counts bytes: 96k CHARACTERS of
 * CJK or emoji is ~288 KiB of UTF-8 and still blows the limit — failing safe,
 * but with a spawn error instead of a truncation notice.
 */
export const PROMPT_MAX_BYTES = 96_000

/** `kimi -p` rejects an empty prompt outright ("Prompt cannot be empty."). */
export const EMPTY_PROMPT_PLACEHOLDER = '(no instruction was provided for this turn)'

// ---------------------------------------------------------------------------
// stream-json line shapes (only the fields consumed here)
// ---------------------------------------------------------------------------

export interface KimiToolCall {
  type?: string
  id?: string
  function?: { name?: string; arguments?: string }
}

export interface KimiAssistantLine {
  role: 'assistant'
  /** Absent when the step produced tool calls only. */
  content?: string
  /** Absent when the step produced text only. */
  tool_calls?: KimiToolCall[]
}

export interface KimiToolLine {
  role: 'tool'
  tool_call_id?: string
  content?: string
}

export interface KimiMetaLine {
  role: 'meta'
  type: string
  [key: string]: unknown
}

export type KimiStreamLine =
  | KimiAssistantLine
  | KimiToolLine
  | KimiMetaLine
  | { role?: string; type?: string; [key: string]: unknown }

/** `meta.type` of the line carrying the native session id (last line of a turn). */
export const RESUME_HINT_TYPE = 'session.resume_hint'
/** `meta.type` of the provider-retry telemetry line. */
export const RETRYING_TYPE = 'turn.step.retrying'
/** `meta.type` of the opening version line. */
export const VERSION_TYPE = 'system.version'

/**
 * kimi rejects a resumed session it cannot use, by message rather than by exit
 * code. Both shapes mean the same thing for us: this native session is gone,
 * start a fresh one.
 */
export const RESUME_REJECTED_RE =
  /Session "[^"]*" (?:not found|was created under a different directory)/i

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

export interface KimiSpawnFlags {
  /** Path to the `kimi` binary. */
  binary: string
  /** Model alias for `-m` (empty/undefined = the CLI's configured default). */
  modelId?: string
  /** Native session id for `-S` — turns ≥2 of a task. Omit for a fresh session. */
  resumeSessionId?: string
  /** Working directory. Pins the wire bucket AND scopes `-S` resume. */
  cwd?: string
}

/**
 * Assemble one `kimi -p` argv.
 *
 * No permission flag: prompt mode forces `auto` internally and rejects
 * `--auto`/`--yolo`. No `--mcp-config`, `--append-system-prompt` or
 * `--json-schema`: kimi 0.34.0 has none of them (verified against the bundle),
 * which is why the task scaffold rides inside the prompt and MCP servers come
 * from `mcp.json` in KIMI_CODE_HOME.
 */
export function buildArgs(flags: KimiSpawnFlags, prompt: string): string[] {
  const args: string[] = []
  if (flags.resumeSessionId) args.push('-S', flags.resumeSessionId)
  if (flags.modelId) args.push('-m', flags.modelId)
  args.push('--output-format', 'stream-json')
  // -p last: its value is the prompt, and keeping it terminal makes the argv
  // readable in logs and in the fake-binary test fixtures.
  args.push('-p', clampPrompt(prompt))
  return args
}

/**
 * Child env: inherit, then apply overrides where `undefined` DELETES an
 * inherited var (the task executor uses that to drop a surrounding den
 * terminal's RIVETOS_SESSION_KEY).
 *
 * Two vars are always scrubbed so the spawn is deterministic regardless of what
 * the operator's shell carries:
 *   - `KIMI_MODEL_OUTPUT_FORMAT` — the env FALLBACK for `--output-format`.
 *     kimi's `resolveOutputFormat` returns the explicit flag first and only
 *     reads the env when the flag is absent, so with the flag always passed
 *     this var can never win today. Scrubbed belt-and-braces: it is the one
 *     inherited value that could silently change the output PROTOCOL — the
 *     thing this whole parser is written against — if a future path ever omits
 *     the flag.
 *   - `KIMI_CODE_LEGACY_FLAG` — selects the retired v1 print runner, whose
 *     stream-json vocabulary is not the one parsed here. This one has no flag
 *     in front of it, so scrubbing it is load-bearing rather than defensive.
 */
export function buildChildEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined) Reflect.deleteProperty(env, k)
    else env[k] = v
  }
  delete env.KIMI_MODEL_OUTPUT_FORMAT
  delete env.KIMI_CODE_LEGACY_FLAG
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
// spawnKimiTurn
// ---------------------------------------------------------------------------

export interface SpawnedTurn {
  /** The child process (pid / exitCode inspection). */
  proc: ChildProcessWithoutNullStreams
  /** The exact argv the child was spawned with. */
  args: string[]
  /** Wall clock immediately before spawn — the floor for the wire reconcile. */
  startedAtMs: number
  /** Parsed stream-json lines. Non-JSON lines are skipped. Iterate once. */
  events: () => AsyncIterable<KimiStreamLine>
  /** Capped stderr captured so far. */
  stderrText: () => string
  /** SIGTERM, then SIGKILL after the grace period. Idempotent; no-op once exited. */
  kill: () => void
  /** Resolves with the exit code (null when the child died on a signal). */
  waitExit: () => Promise<number | null>
}

/**
 * Spawn one `kimi -p` turn. Throws synchronously only if `spawn()` itself
 * throws; ENOENT and friends arrive as an async `error` event on `proc`, which
 * the caller must handle (its `result` contract must never reject).
 */
export function spawnKimiTurn(
  flags: KimiSpawnFlags,
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

  // Nothing is written on stdin — the prompt is argv. Close it so a kimi build
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
  // waitExit() reads the latch. Two ways the old attach-on-demand version
  // could hang forever, both on paths this executor leans on:
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

  async function* events(): AsyncIterable<KimiStreamLine> {
    for await (const line of iterateLines(proc.stdout)) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      yield parsed as KimiStreamLine
    }
  }

  const waitExit = (): Promise<number | null> =>
    exitCode === undefined
      ? new Promise((resolve) => exitWaiters.push(resolve))
      : Promise.resolve(exitCode)

  return { proc, args, startedAtMs, events, stderrText: () => stderr, kill, waitExit }
}
