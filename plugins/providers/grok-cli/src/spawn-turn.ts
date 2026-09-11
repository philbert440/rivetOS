/**
 * spawn-turn — one headless Grok Build call per agent turn.
 *
 * `grok -p <prompt> --output-format streaming-messages-json
 * --include-partial-messages` runs a single non-interactive session and
 * prints NDJSON on stdout: Anthropic Messages API wire events (the same
 * shape claude-cli parses), including `stream_event` lines with
 * `text_delta` / `thinking_delta` when partials are enabled, plus whole
 * assistant/user/result messages.
 *
 * Facts checked against grok 1.0.13 (2026-09-05 / 2026-09-11): the prompt
 * must be an argument (`-p -` is read literally and `-p ""` is rejected),
 * there is no stdin prompt form, `--system-prompt-override` replaces the
 * CLI's own system prompt, and a turn that hits `--max-turns` still prints
 * its result first and then `Error: max turns reached`.
 *
 * The pre-streaming `--output-format json` blob is still recognized as a
 * fallback when a turn produces no NDJSON events and exits 0.
 */
import { spawn, type ChildProcess } from 'node:child_process'

export type GrokReasoningEffort = 'low' | 'medium' | 'high'

export interface GrokSpawnFlags {
  /** Path to the grok binary. */
  binary: string
  /** `-m/--model`; omit to use the CLI's configured default. */
  modelId?: string
  /** `--permission-mode` — `dontAsk` denies every tool not covered by `--allow`. */
  permissionMode: string
  /** `--reasoning-effort`; omit to use the CLI default. */
  reasoningEffort?: GrokReasoningEffort
  /** `--max-turns` — 1 = answer only, no tool loop. */
  maxTurns: number
  /** `--no-plan` — skip plan mode (which would swallow a headless run). */
  noPlan: boolean
  /** `--system-prompt-override` text ('' = omit). */
  systemPromptOverride: string
  /** `--allow <RULE>` entries (Claude Code rule syntax), for tool-using turns. */
  allow?: string[]
  /** `--tools <TOOLS>` pass-through ('' = omit). */
  tools?: string
  /** `--cwd` for the spawned process; also used as the child's cwd. */
  cwd?: string
  /**
   * Grok Build session id. With `resume: true` this becomes `--resume <id>`;
   * otherwise `--session-id <id>`. Omit both flags when unset (replay mode).
   */
  sessionId?: string
  /** When true (and `sessionId` is set), pass `--resume` instead of `--session-id`. */
  resume?: boolean
}

export function buildArgs(flags: GrokSpawnFlags, prompt: string): string[] {
  const args: string[] = [
    '-p',
    prompt,
    '--output-format',
    'streaming-messages-json',
    '--include-partial-messages',
    '--permission-mode',
    flags.permissionMode,
    '--max-turns',
    String(flags.maxTurns),
  ]
  if (flags.noPlan) args.push('--no-plan')
  if (flags.modelId) args.push('-m', flags.modelId)
  if (flags.reasoningEffort) args.push('--reasoning-effort', flags.reasoningEffort)
  if (flags.systemPromptOverride) args.push('--system-prompt-override', flags.systemPromptOverride)
  if (flags.tools) args.push('--tools', flags.tools)
  for (const rule of flags.allow ?? []) args.push('--allow', rule)
  if (flags.cwd) args.push('--cwd', flags.cwd)
  if (flags.sessionId) {
    if (flags.resume) args.push('--resume', flags.sessionId)
    else args.push('--session-id', flags.sessionId)
  }
  return args
}

/** Child env: inherit, make sure HOME is set (grok reads ~/.grok), no TTY hints. */
export function buildChildEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  if (!env.HOME) env.HOME = process.env.HOME
  delete env.TERM_PROGRAM
  return env
}

export interface GrokUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  reasoning_tokens?: number
  total_tokens?: number
}

export interface GrokJsonResult {
  text?: string
  thought?: string
  stopReason?: string
  sessionId?: string
  requestId?: string
  usage?: GrokUsage
  num_turns?: number
  total_cost_usd?: number
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }>
}

/**
 * One NDJSON object from grok's streaming-messages-json stdout. Shapes we
 * consume (mirroring claude-cli):
 *
 *   { type: "stream_event", event: { type: "content_block_delta",
 *     delta: { type: "text_delta"|"thinking_delta", text|thinking } },
 *     session_id? }
 *   { type: "assistant"|"user"|"result"|"error"|"system"|"message", ... }
 *
 * Unwrapped Anthropic events (`content_block_delta`, `message_delta`, …)
 * are also accepted. Unknown objects are still yielded so callers can
 * inspect them; the model ignores unrecognized types.
 */
export type GrokCliEvent = {
  type?: string
  [key: string]: unknown
}

/**
 * Parse one stdout line. Empty / non-JSON lines return null (they stay in
 * the raw stdout buffer for the blob fallback).
 */
export function parseGrokStreamLine(line: string): GrokCliEvent | null {
  const s = line.trim()
  if (!s) return null
  try {
    const parsed: unknown = JSON.parse(s)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as GrokCliEvent
  } catch {
    return null
  }
}

/**
 * Extract the result object from grok's stdout. Used as a defensive
 * fallback when streaming produced no events and the process exited 0
 * (pretty-printed `--output-format json` blob, or a single-line blob).
 * Anything after the object (e.g. "Error: max turns reached") is trailing
 * noise; anything before it is ignored.
 */
export function parseGrokJson(stdout: string): GrokJsonResult | null {
  const s = stdout.trim()
  if (!s) return null
  try {
    return JSON.parse(s) as GrokJsonResult
  } catch {
    /* fall through to the bracket scan */
  }
  const start = s.indexOf('{')
  if (start < 0) return null
  // Walk forward tracking brace depth (strings aware) to the matching close.
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1)) as GrokJsonResult
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export interface GrokTurn {
  proc: ChildProcess
  args: string[]
  /** SIGTERM now, SIGKILL if still alive 3 s later. Idempotent. */
  kill(): void
  /** Resolves with the exit code (null when killed by signal). */
  waitExit(): Promise<number | null>
  stdoutText(): string
  stderrText(): string
  /**
   * Parsed NDJSON objects from stdout, yielded as lines arrive.
   * Completes on stdout `end`/`close`, not process `exit`, so a trailing
   * line still buffered after the child exits is yielded.
   * Single-consumer: iterate exactly once. Non-JSON lines are skipped.
   */
  events(): AsyncIterable<GrokCliEvent>
}

export function spawnGrokTurn(
  flags: GrokSpawnFlags,
  prompt: string,
  opts?: { env?: Record<string, string | undefined> },
): GrokTurn {
  const args = buildArgs(flags, prompt)
  const proc = spawn(flags.binary, args, {
    cwd: flags.cwd,
    env: buildChildEnv(opts?.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const parsedEvents: GrokCliEvent[] = []
  const eventWaiters: Array<() => void> = []
  let stdoutClosed = false

  const notifyEvents = (): void => {
    for (const w of eventWaiters.splice(0)) w()
  }
  const closeStdout = (): void => {
    if (stdoutClosed) return
    stdoutClosed = true
    notifyEvents()
  }

  // stdio is ['ignore', 'pipe', 'pipe'] so both streams exist.
  proc.stdout.setEncoding('utf8')
  let lineBuf = ''
  const flushLineBuf = (): void => {
    if (!lineBuf) return
    const ev = parseGrokStreamLine(lineBuf)
    if (ev) {
      parsedEvents.push(ev)
      notifyEvents()
    }
    lineBuf = ''
  }
  proc.stdout.on('data', (d: string) => {
    stdout += d
    lineBuf += d
    let nl = lineBuf.indexOf('\n')
    while (nl !== -1) {
      const raw = lineBuf.slice(0, nl)
      lineBuf = lineBuf.slice(nl + 1)
      const ev = parseGrokStreamLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
      if (ev) {
        parsedEvents.push(ev)
        notifyEvents()
      }
      nl = lineBuf.indexOf('\n')
    }
  })
  proc.stdout.on('end', () => {
    flushLineBuf()
    closeStdout()
  })
  proc.stdout.on('close', closeStdout)
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (d: string) => (stderr += d))

  let exited = false
  const exit = new Promise<number | null>((resolve) => {
    // Process exit can fire while stdout still has buffered data. Do not
    // flush or close the event latch here — a trailing `result` line would
    // be dropped. `events()` completes on stdout `end`/`close` instead.
    proc.once('exit', (code) => {
      exited = true
      resolve(code)
    })
    // spawn() failures (ENOENT, EACCES) surface as async 'error' events.
    // There will be no stdout EOF, so close the latch or `events()` hangs.
    proc.once('error', (err) => {
      exited = true
      stderr += `spawn error: ${err.message}\n`
      flushLineBuf()
      closeStdout()
      resolve(null)
    })
  })

  let killed = false
  const kill = (): void => {
    if (killed || exited) return
    killed = true
    try {
      proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    const t = setTimeout(() => {
      if (!exited) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, 3000)
    t.unref()
  }

  async function* events(): AsyncIterable<GrokCliEvent> {
    let i = 0
    for (;;) {
      while (i < parsedEvents.length) {
        yield parsedEvents[i++]
      }
      if (stdoutClosed) return
      await new Promise<void>((resolve) => {
        eventWaiters.push(resolve)
      })
    }
  }

  return {
    proc,
    args,
    kill,
    waitExit: () => exit,
    stdoutText: () => stdout,
    stderrText: () => stderr,
    events,
  }
}
