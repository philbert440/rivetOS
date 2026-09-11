/**
 * Fake `pi` binaries for the executor tests.
 *
 * A shell script that records argv + env, optionally writes a pi-shaped
 * `transcript.jsonl` into a throwaway PI_HOME, prints canned print/JSON on
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
  /** Native session id the fake writes a transcript for. */
  sessionId?: string
  /** Per-request usage rows written to transcript.jsonl (scope 'turn'). */
  usage?: Array<{ input_tokens: number; output_tokens: number; cache_read_tokens?: number }>
  /** Write a `turn_end` record. Default true when a transcript is written. */
  turnEnded?: string | false
  /** Behave differently when spawned with `--session` (resume-rejection tests). */
  onResume?: { stderr: string; exitCode: number }
  /** Hang until signalled instead of doing anything else. */
  slow?: boolean
}

export interface FakePi {
  binary: string
  dir: string
  /** Throwaway PI_HOME the fake writes transcripts into. */
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
  const sessionId = opts.sessionId ?? 'session_11111111-2222-3333-4444-555555555555'
  const stdout = (opts.raw ?? (opts.lines ?? []).map((l) => JSON.stringify(l))).join('\n')
  fs.writeFileSync(path.join(dir, 'stdout.txt'), stdout === '' ? '' : stdout + '\n')

  const script: string[] = [
    '#!/usr/bin/env bash',
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
    // A pi-shaped transcript for the reconcile to read, with the clock set to
    // now so it lands at or after the executor's spawn timestamp.
    const usage = opts.usage ?? [{ input_tokens: 100, output_tokens: 25, cache_read_tokens: 10 }]
    const sessionDir = path.join(home, 'sessions', sessionId)
    const wire = path.join(sessionDir, 'transcript.jsonl')
    script.push(
      'NOW=$(date +%s%3N)',
      `mkdir -p ${shellQuote(path.dirname(wire))}`,
      `printf '%s\\n' '{"type":"session","session_id":"${sessionId}"}' >> ${shellQuote(wire)}`,
    )
    for (const u of usage) {
      const record = {
        type: 'usage',
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_tokens ?? 0,
        cache_write_tokens: 0,
        usage_scope: 'turn',
      }
      script.push(
        `printf '%s\\n' '${JSON.stringify(record).slice(0, -1)},"time":'"$NOW"'}' >> ${shellQuote(wire)}`,
      )
    }
    // A session-scoped rollup the reconcile must NOT add to the turn.
    script.push(
      `printf '%s\\n' '{"type":"usage","input_tokens":99999,"output_tokens":99999,"cache_read_tokens":0,"cache_write_tokens":0,"usage_scope":"session","time":'"$NOW"'}' >> ${shellQuote(wire)}`,
    )
    if (opts.turnEnded !== false) {
      const reason = typeof opts.turnEnded === 'string' ? opts.turnEnded : 'completed'
      script.push(
        `printf '%s\\n' '{"type":"turn_end","turn_id":0,"reason":"${reason}","duration_ms":42,"time":'"$NOW"'}' >> ${shellQuote(wire)}`,
      )
    }
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

/** print/JSON lines a healthy pi turn prints. */
export function successLines(finalText: string, sessionId: string): unknown[] {
  return [
    { type: 'session', session_id: sessionId },
    {
      type: 'tool_start',
      id: 'Bash_0',
      name: 'Bash',
      input: { command: 'ls' },
    },
    { type: 'tool_end', id: 'Bash_0', output: 'a\nb\n' },
    { type: 'assistant', content: finalText },
    { type: 'result', session_id: sessionId, text: finalText },
  ]
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
