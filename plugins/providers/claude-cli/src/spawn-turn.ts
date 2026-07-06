/**
 * spawn-turn — the shared claude-cli spawn / flag-assembly / stream-json
 * parsing layer.
 *
 * Extracted from claude-cli-model.ts (pure refactor, phase 1 step (b)) so it
 * can be consumed by BOTH:
 *   - `ClaudeCliModel` — the LanguageModelV3 wrapper the AI SDK loop drives
 *   - `ClaudeCliExecutor` — the HarnessExecutor driving `claude -p` per task
 *
 * One `spawnClaudeTurn()` call is one `claude -p` spawn: it assembles the
 * flag set, spawns the binary with a scrubbed env, writes the single user
 * turn as stream-json on stdin, and exposes the parsed stream-json event
 * iterator plus idempotent kill (SIGTERM → SIGKILL after a grace period)
 * and capped stderr capture.
 *
 * Constraint (locked per migration plan): no RivetOS-side max-output-tokens
 * or per-spawn timeouts. Claude Code owns those. Callers forward abort
 * signals to `kill()` when a turn must die early.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Grace period between SIGTERM and SIGKILL when terminating the child. */
export const KILL_GRACE_MS = 2_000

/** Max bytes of child stderr we retain (only the first 500 chars are surfaced). */
export const STDERR_CAP = 64 * 1024

export type ClaudeCliEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// ---------------------------------------------------------------------------
// CLI stream-json event shapes (partial — only the bits we consume)
// ---------------------------------------------------------------------------

export interface CliSystemInit {
  type: 'system'
  subtype: 'init'
  session_id: string
  model: string
  apiKeySource?: string
  tools: string[]
}

export interface CliStreamEvent {
  type: 'stream_event'
  event: {
    type: string
    index?: number
    content_block?: { type?: string }
    delta?: {
      type?: string
      text?: string
      thinking?: string
    }
  }
  session_id: string
}

export interface CliResult {
  type: 'result'
  subtype: string
  is_error: boolean
  result?: string
  stop_reason?: string
  session_id: string
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export type CliEvent =
  CliSystemInit | CliStreamEvent | CliResult | { type: string; [key: string]: unknown }

/**
 * Anthropic Messages API content-block shape, which Claude Code's
 * `--input-format stream-json` accepts on the user-turn `content` field.
 * We only emit `text` and `image` blocks (the only shapes the CLI needs
 * from us for now).
 */
export type CliImageSource =
  { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }

export type CliContentBlock =
  { type: 'text'; text: string } | { type: 'image'; source: CliImageSource }

// ---------------------------------------------------------------------------
// Helpers — env + args
// ---------------------------------------------------------------------------

/**
 * CRITICAL: scrub OAuth-impersonating env vars. If ANTHROPIC_API_KEY is set,
 * the CLI uses API-key auth and bills the console — defeating the entire
 * point of this provider. Strip both vars so the CLI falls back to its
 * OAuth keychain. Callers may layer extra env vars on top (e.g. the task
 * executor's RIVETOS_SESSION_KEY / RIVETOS_DEN_HOOK_DISABLED hook plumbing).
 */
export function buildChildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

/** Flag set for one `claude -p` spawn. */
export interface SpawnTurnFlags {
  /** Path to the `claude` binary. */
  binary: string
  /** Resolved model identifier passed via --model (empty = CLI default). */
  modelId: string
  /** Built-in tool list passed via --tools ('default' = all, '' = none). */
  toolsArg: string
  /** Reasoning effort passed via --effort. */
  effort: ClaudeCliEffort
  /** Permission mode passed via --permission-mode. */
  permissionMode: string
  /** When true, append --exclude-dynamic-system-prompt-sections. */
  excludeDynamicSections: boolean
  /** System text for --append-system-prompt ('' = omit the flag). */
  systemText: string
  /** Embedded MCP bridge config path for --mcp-config (omit when absent). */
  mcpConfigPath?: string
  /** Working directory for the spawned process. */
  cwd?: string
}

export function buildArgs(flags: SpawnTurnFlags): string[] {
  const args: string[] = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    flags.permissionMode,
    '--effort',
    flags.effort,
    '--tools',
    flags.toolsArg,
  ]

  if (flags.modelId) {
    args.push('--model', flags.modelId)
  }

  if (flags.excludeDynamicSections) {
    args.push('--exclude-dynamic-system-prompt-sections')
  }

  if (flags.systemText) {
    args.push('--append-system-prompt', flags.systemText)
  }

  if (flags.mcpConfigPath) {
    args.push('--mcp-config', flags.mcpConfigPath)
  }

  // No --session-id stitching: each spawn is a one-shot. Multi-turn state
  // lives caller-side (loop message history / task memory conversation),
  // not in claude's session store.
  args.push('--no-session-persistence')

  return args
}

// ---------------------------------------------------------------------------
// Line iterator over a Readable stream
// ---------------------------------------------------------------------------

export async function* iterateLines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buffer = ''
  for await (const chunk of stream) {
    const str: string = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    buffer += str
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      yield line
      idx = buffer.indexOf('\n')
    }
  }
  if (buffer.length > 0) yield buffer
}

// ---------------------------------------------------------------------------
// spawnClaudeTurn — one spawn, wired for stream-json in/out
// ---------------------------------------------------------------------------

export interface SpawnedTurn {
  /** The child process (pid, exitCode inspection). */
  proc: ChildProcessWithoutNullStreams
  /** The exact argv the child was spawned with (for logging / errors). */
  args: string[]
  /**
   * Parsed stream-json events from stdout. Non-JSON lines are skipped.
   * Single-consumer: iterate exactly once.
   */
  events: () => AsyncIterable<CliEvent>
  /** Capped stderr captured so far. */
  stderrText: () => string
  /**
   * Terminate the child idempotently: SIGTERM, then SIGKILL if it ignores
   * us for KILL_GRACE_MS. Safe to call on every exit path — no-op once the
   * child has exited.
   */
  kill: () => void
  /** Resolves with the exit code once the child closes. */
  waitExit: () => Promise<number | null>
}

/**
 * Spawn one `claude -p` turn: build args, spawn with a scrubbed env, write
 * the single user turn as stream-json on stdin, and return the handle.
 *
 * Throws synchronously if the spawn itself fails (bad binary path etc.) —
 * callers wrap per their error contract.
 */
export function spawnClaudeTurn(
  flags: SpawnTurnFlags,
  userContent: string | CliContentBlock[],
  opts?: { env?: Record<string, string> },
): SpawnedTurn {
  const args = buildArgs(flags)

  const proc = spawn(flags.binary, args, {
    env: buildChildEnv(opts?.env),
    cwd: flags.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Wire stdin: one user turn as stream-json input, then close.
  const inputLine =
    JSON.stringify({ type: 'user', message: { role: 'user', content: userContent } }) + '\n'
  proc.stdin.write(inputLine)
  proc.stdin.end()

  // Terminate the child idempotently: SIGTERM, then SIGKILL if it ignores us.
  // No internal *runtime* timeout — Claude Code owns max-output-tokens and
  // runtime limits — this only bounds how long a *kill* can hang.
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const kill = (): void => {
    if (proc.exitCode !== null) return // already exited — nothing to do
    if (!proc.killed) proc.kill('SIGTERM')
    if (!killTimer) {
      killTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }, KILL_GRACE_MS)
      killTimer.unref()
    }
  }
  proc.once('exit', () => {
    if (killTimer) clearTimeout(killTimer)
  })

  // Cap stderr accumulation — callers only ever surface the first 500 chars,
  // so an unbounded child writing to stderr for the whole run can't grow
  // this string without limit.
  let stderr = ''
  proc.stderr.on('data', (d: Buffer) => {
    if (stderr.length < STDERR_CAP) stderr += d.toString()
  })

  async function* events(): AsyncIterable<CliEvent> {
    for await (const line of iterateLines(proc.stdout)) {
      if (!line.trim()) continue
      let event: CliEvent
      try {
        event = JSON.parse(line) as CliEvent
      } catch {
        continue
      }
      yield event
    }
  }

  const waitExit = (): Promise<number | null> =>
    new Promise((resolve) => {
      if (proc.exitCode !== null) {
        resolve(proc.exitCode)
        return
      }
      proc.once('close', (code) => {
        resolve(code)
      })
    })

  return { proc, args, events, stderrText: () => stderr, kill, waitExit }
}
