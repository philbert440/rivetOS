/**
 * spawn-turn — one headless Grok Build call per agent turn.
 *
 * `grok -p <prompt> --output-format json` runs a single non-interactive
 * session and prints ONE JSON object on stdout when it finishes:
 *
 *   { "text": "...", "thought": "...", "stopReason": "end_turn",
 *     "sessionId": "...", "usage": { input_tokens, output_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens },
 *     "num_turns": 1, "total_cost_usd": 0.004, "modelUsage": { "<model>": {...} } }
 *
 * Facts checked against grok 1.0.13 (2026-09-05): the prompt must be an
 * argument (`-p -` is read literally and `-p ""` is rejected), there is no
 * stdin prompt form, `--system-prompt-override` replaces the CLI's own system
 * prompt, and a turn that hits `--max-turns` still prints the JSON first and
 * then `Error: max turns reached`.
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
}

export function buildArgs(flags: GrokSpawnFlags, prompt: string): string[] {
  const args: string[] = [
    '-p',
    prompt,
    '--output-format',
    'json',
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
 * Extract the result object from grok's stdout. The CLI prints exactly one
 * pretty-printed JSON object; anything after it (e.g. "Error: max turns
 * reached") is trailing noise, anything before it is ignored.
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
  // stdio is ['ignore', 'pipe', 'pipe'] so both streams exist.
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d: string) => (stdout += d))
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (d: string) => (stderr += d))

  let exited = false
  const exit = new Promise<number | null>((resolve) => {
    proc.once('exit', (code) => {
      exited = true
      resolve(code)
    })
    // spawn() failures (ENOENT, EACCES) surface as async 'error' events
    proc.once('error', (err) => {
      exited = true
      stderr += `spawn error: ${err.message}\n`
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

  return {
    proc,
    args,
    kill,
    waitExit: () => exit,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  }
}
