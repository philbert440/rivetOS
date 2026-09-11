/**
 * Fake `opencode` binaries for the executor tests.
 *
 * A shell script that records argv + env, optionally writes an opencode-shaped
 * session JSON + message records into a throwaway OPENCODE_DATA_DIR, prints
 * canned `--format json` lines on stdout and exits with a chosen code. The
 * real binary is never invoked, no provider tokens are spent, and nothing
 * touches the operator's `~/.local/share/opencode`.
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

export interface FakeOpencodeOptions {
  /** JSON lines printed on stdout (objects are JSON-stringified). */
  lines?: unknown[]
  /** Raw stdout lines, bypassing JSON encoding (malformed-stream tests). */
  raw?: string[]
  /** Exit code. Default 0. */
  exitCode?: number
  /** Text written to stderr before exiting. */
  stderr?: string
  /** Native session id the fake writes a transcript for. */
  sessionId?: string
  /** Per-request usage rows written as assistant message JSON. */
  usage?: Array<{ inputOther: number; output: number; inputCacheRead?: number }>
  /** Behave differently when spawned with `--session` (resume-rejection tests). */
  onResume?: { stderr: string; exitCode: number }
  /** Hang until signalled instead of doing anything else. */
  slow?: boolean
}

export interface FakeOpencode {
  binary: string
  dir: string
  /** Throwaway OPENCODE_DATA_DIR the fake writes transcripts into. */
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

/** Remove every directory `makeFakeOpencode` created. Call from `afterAll`. */
export function cleanupFakeOpencode(): void {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

export function makeFakeOpencode(opts: FakeOpencodeOptions = {}): FakeOpencode {
  const dir = mkTmp('fake-opencode-')
  const home = path.join(dir, 'opencode-home')
  const cwd = path.join(dir, 'work')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })

  const binary = path.join(dir, 'opencode')
  const sessionId = opts.sessionId ?? 'ses_11111111-2222-3333-4444-555555555555'
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
    const usage = opts.usage ?? [{ inputOther: 100, output: 25, inputCacheRead: 10 }]
    const sessionFile = path.join(home, 'storage', 'session', 'proj_fake', `${sessionId}.json`)
    const messageDir = path.join(home, 'storage', 'message', sessionId)
    script.push(
      'NOW=$(date +%s%3N)',
      `mkdir -p ${shellQuote(path.dirname(sessionFile))}`,
      `mkdir -p ${shellQuote(messageDir)}`,
      `printf '%s\\n' '{"id":"${sessionId}","directory":"'"$PWD"'","title":"fake"}' > ${shellQuote(sessionFile)}`,
    )
    usage.forEach((u, i) => {
      const tokens = {
        input: u.inputOther,
        output: u.output,
        reasoning: 0,
        cache: { read: u.inputCacheRead ?? 0, write: 0 },
      }
      script.push(
        `printf '%s\\n' '{"id":"msg_${String(i)}","sessionID":"${sessionId}","role":"assistant","tokens":${JSON.stringify(
          tokens,
        )},"time":{"created":'"$NOW"',"completed":'"$NOW"'}}' > ${shellQuote(
          path.join(messageDir, `msg_${String(i)}.json`),
        )}`,
      )
    })
    // A user-role row the reconcile must NOT add to the turn.
    script.push(
      `printf '%s\\n' '{"id":"msg_user","sessionID":"${sessionId}","role":"user","tokens":{"input":99999,"output":99999,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":'"$NOW"',"completed":'"$NOW"'}}' > ${shellQuote(
        path.join(messageDir, 'msg_user.json'),
      )}`,
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

/** `--format json` lines a healthy opencode turn prints. */
export function successLines(finalText: string, sessionId: string): unknown[] {
  return [
    { type: 'step_start', sessionID: sessionId },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'bash_0',
        sessionID: sessionId,
        state: { status: 'running', input: { command: 'ls' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'bash_0',
        sessionID: sessionId,
        state: { status: 'completed', output: 'a\nb\n' },
      },
    },
    {
      type: 'text',
      part: { type: 'text', text: finalText, sessionID: sessionId },
    },
    {
      type: 'step_finish',
      sessionID: sessionId,
      reason: 'stop',
    },
  ]
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
