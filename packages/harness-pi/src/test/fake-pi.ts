/**
 * Fake `pi` binaries for the executor tests.
 *
 * A shell script that records argv + env, optionally writes a pi-shaped
 * session jsonl into a throwaway data dir, prints canned print/JSON on
 * stdout and exits with a chosen code. The real binary is never invoked, no
 * provider tokens are spent, and nothing touches the operator's `~/.pi`.
 *
 * Lives under `src/test/` rather than a top-level `test/` so the package's
 * tsconfig picks it up as ordinary source — same placement as core's
 * `domain/task/test/executor-conformance.ts`. It is a fixture BUILDER, not a
 * suite, so it is not collected by vitest.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const INVOCATION_MARK = '--invocation--'

export interface FakePiOptions {
  /** print/JSON lines printed on stdout (objects are JSON-stringified). */
  lines?: unknown[]
  /** Raw stdout lines, bypassing JSON encoding (malformed-stream tests). */
  raw?: string[]
  /** Exit code. Default 0. */
  exitCode?: number
  /** Text written to stderr before exiting. */
  stderr?: string
  /** Native session id the fake writes a session jsonl for. */
  sessionId?: string
  /** Per-request usage stamped on the on-disk assistant message (real keys). */
  usage?: Array<{
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    input_tokens?: number
    output_tokens?: number
    cache_read_tokens?: number
  }>
  /** Behave differently when spawned with `--session` (resume-rejection tests). */
  onResume?: { stderr: string; exitCode: number }
  /** Hang until signalled instead of doing anything else. */
  slow?: boolean
}

export interface FakePi {
  binary: string
  dir: string
  /** Throwaway data dir the fake writes session jsonl into (`~/.pi/agent` layout). */
  home: string
  /** Working directory to spawn in (a throwaway too). */
  cwd: string
  /** argv of the LAST invocation, one element per entry. */
  args: () => string[]
  /** argv of every invocation, oldest first. */
  invocations: () => string[][]
  /**
   * Raw recorded text per invocation, oldest first. The prompt is a MULTI-LINE
   * argv value, so the line-split `invocations()` view can only be trusted for
   * flags — assert prompt content against this.
   */
  invocationTexts: () => string[]
  /** env of the last invocation as a name→value map. */
  env: () => Record<string, string>
}

const tmpDirs: string[] = []

/** Remove every directory `makeFakePi` created. Call from `afterAll`. */
export function cleanupFakePi(): void {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

export function makeFakePi(opts: FakePiOptions = {}): FakePi {
  const dir = mkTmp('fake-pi-')
  const home = path.join(dir, 'pi-home')
  const cwd = path.join(dir, 'work')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })

  const binary = path.join(dir, 'pi')
  const sessionId = opts.sessionId ?? '019090db-c402-71cb-a954-6066b9493630'
  const stdout = (opts.raw ?? (opts.lines ?? []).map((l) => JSON.stringify(l))).join('\n')
  fs.writeFileSync(path.join(dir, 'stdout.txt'), stdout === '' ? '' : stdout + '\n')

  const script: string[] = [
    '#!/usr/bin/env bash',
    // pi 0.85.1 print mode blocks when stdin is an open pipe. The executor
    // must spawn with stdin ignored; a pipe (even closed) fails this check.
    'if [ -p /dev/stdin ]; then',
    "  printf '%s\\n' 'stdin was a pipe' >&2",
    '  exit 99',
    'fi',
    `printf '%s\\n' "${INVOCATION_MARK}" "$@" >> "${dir}/args.txt"`,
    `env > "${dir}/env.txt"`,
  ]

  if (opts.slow === true) {
    script.push('exec sleep 60')
  } else {
    if (opts.onResume) {
      script.push(
        'for a in "$@"; do',
        '  if [ "$a" = "--session" ]; then',
        `    printf '%s\\n' ${shellQuote(opts.onResume.stderr)} >&2`,
        `    exit ${String(opts.onResume.exitCode)}`,
        '  fi',
        'done',
      )
    }
    const usage = opts.usage ?? [{ input: 100, output: 25, cacheRead: 10 }]
    // Custom `--session-dir` is flat: <dir>/<ts>_<id>.jsonl (no cwd bucket).
    const sessionsDir = path.join(home, 'sessions')
    const wire = path.join(sessionsDir, `2026-09-11T14-25-16-803Z_${sessionId}.jsonl`)
    script.push(
      'NOW=$(date +%s%3N)',
      `mkdir -p ${shellQuote(sessionsDir)}`,
      `printf '%s\\n' '{"type":"session","version":3,"id":"${sessionId}","timestamp":"2026-09-11T14:25:16.803Z","cwd":${JSON.stringify(cwd)}}' >> ${shellQuote(wire)}`,
    )
    let inTokens = 0
    let outTokens = 0
    let cacheRead = 0
    let cacheWrite = 0
    for (const u of usage) {
      inTokens += u.input ?? u.input_tokens ?? 0
      outTokens += u.output ?? u.output_tokens ?? 0
      cacheRead += u.cacheRead ?? u.cache_read_tokens ?? 0
      cacheWrite += u.cacheWrite ?? 0
    }
    script.push(
      `printf '%s\\n' '{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","timestamp":"2026-09-11T14:25:17.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"timestamp":'"$NOW"',"usage":{"input":${String(inTokens)},"output":${String(outTokens)},"cacheRead":${String(cacheRead)},"cacheWrite":${String(cacheWrite)},"reasoning":0,"totalTokens":${String(inTokens + outTokens)}}}}' >> ${shellQuote(wire)}`,
    )
    if (opts.stderr !== undefined) {
      script.push(`printf '%s\\n' ${shellQuote(opts.stderr)} >&2`)
    }
    script.push(`cat "${dir}/stdout.txt"`, `exit ${String(opts.exitCode ?? 0)}`)
  }

  fs.writeFileSync(binary, script.join('\n') + '\n', { mode: 0o755 })

  const readInvocations = (): string[][] => {
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8')
    } catch {
      return []
    }
    const out: string[][] = []
    for (const line of text.split('\n')) {
      if (line === INVOCATION_MARK) out.push([])
      else if (line !== '' && out.length > 0) out[out.length - 1].push(line)
    }
    return out
  }

  const readInvocationTexts = (): string[] => {
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8')
    } catch {
      return []
    }
    return text
      .split(`${INVOCATION_MARK}\n`)
      .slice(1)
      .map((chunk) => chunk.replace(/\n$/, ''))
  }

  return {
    binary,
    dir,
    home,
    cwd,
    invocations: readInvocations,
    invocationTexts: readInvocationTexts,
    args: () => {
      const all = readInvocations()
      return all.length > 0 ? all[all.length - 1] : []
    },
    env: () => {
      const out: Record<string, string> = {}
      let text: string
      try {
        text = fs.readFileSync(path.join(dir, 'env.txt'), 'utf8')
      } catch {
        return out
      }
      for (const line of text.split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1)
      }
      return out
    },
  }
}

const PENDING_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** Default assistant usage on the runtime stream (real pi keys). */
export const SUCCESS_USAGE = {
  input: 100,
  output: 25,
  cacheRead: 10,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 125,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * Runtime print/JSON stdout for a healthy pi 0.85.1 turn — shape copied from
 * the captured `pi -p --mode json` stream (session, agent_start, turn_start,
 * message_start/update/end, turn_end, agent_end, agent_settled). Text is
 * split into two `text_delta`s like the real sample (`"p"` + `"ong"`).
 */
export function successLines(
  finalText: string,
  sessionId: string,
  usage: typeof SUCCESS_USAGE = SUCCESS_USAGE,
): unknown[] {
  const head = finalText.slice(0, 1)
  const rest = finalText.slice(1)
  const userMsg = {
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    timestamp: 1_700_000_000_000,
  }
  const assistantPending = {
    role: 'assistant',
    content: [] as unknown[],
    api: 'openai-completions',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: PENDING_USAGE,
    stopReason: 'pending',
    timestamp: 1_700_000_001_000,
  }
  const toolAssistantEnd = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'plan' },
      { type: 'toolCall', id: 'Bash_0', name: 'Bash', arguments: { command: 'ls' } },
    ],
    api: 'openai-completions',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: PENDING_USAGE,
    stopReason: 'toolUse',
    timestamp: 1_700_000_001_000,
  }
  const toolResultMsg = {
    role: 'toolResult',
    toolCallId: 'Bash_0',
    toolName: 'Bash',
    content: [{ type: 'text', text: 'a\nb\n' }],
  }
  const finalAssistant = {
    role: 'assistant',
    content: [{ type: 'text', text: finalText }],
    api: 'openai-completions',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage,
    stopReason: 'stop',
    timestamp: 1_700_000_001_200,
  }
  const textDeltas: unknown[] = []
  if (head) {
    textDeltas.push({
      type: 'message_update',
      usage: PENDING_USAGE,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: head },
    })
  }
  if (rest) {
    textDeltas.push({
      type: 'message_update',
      usage,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: rest },
    })
  }
  return [
    {
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-09-11T14:25:16.803Z',
      cwd: '/home/rivet',
    },
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: userMsg },
    { type: 'message_end', message: userMsg },
    { type: 'message_start', message: assistantPending },
    {
      type: 'message_update',
      usage: PENDING_USAGE,
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
    },
    {
      type: 'message_update',
      usage: PENDING_USAGE,
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'plan' },
    },
    {
      type: 'message_update',
      usage: PENDING_USAGE,
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'plan' },
    },
    {
      type: 'message_update',
      usage: PENDING_USAGE,
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'Bash_0', name: 'Bash' },
    },
    {
      type: 'message_update',
      usage: PENDING_USAGE,
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"command":"ls"}' },
    },
    {
      type: 'message_update',
      usage: PENDING_USAGE,
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 1,
        id: 'Bash_0',
        name: 'Bash',
        arguments: { command: 'ls' },
      },
    },
    { type: 'message_end', message: toolAssistantEnd },
    { type: 'message_start', message: toolResultMsg },
    { type: 'message_end', message: toolResultMsg },
    { type: 'message_start', message: { ...assistantPending, timestamp: 1_700_000_001_200 } },
    {
      type: 'message_update',
      usage: PENDING_USAGE,
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    },
    ...textDeltas,
    {
      type: 'message_update',
      usage,
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: finalText },
    },
    { type: 'message_end', message: finalAssistant },
    { type: 'turn_end', message: finalAssistant },
    { type: 'agent_end', messages: [userMsg, toolAssistantEnd, toolResultMsg, finalAssistant] },
    { type: 'agent_settled' },
  ]
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
