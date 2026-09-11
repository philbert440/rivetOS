/**
 * Fake `opencode` binaries for the executor tests.
 *
 * A Node script that records argv + env, optionally writes an opencode-shaped
 * SQLite session into a throwaway data dir, prints canned `--format json`
 * lines on stdout and exits with a chosen code. The real binary is never
 * invoked, no provider tokens are spent, and nothing touches the operator's
 * `~/.local/share/opencode`.
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
  /** Skip writing opencode.db (session-id / empty-store tests). Default true. */
  writeStore?: boolean
}

export interface FakeOpencode {
  binary: string
  dir: string
  /** Throwaway data dir the fake writes opencode.db into. */
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
  const sessionId = opts.sessionId ?? 'ses_11111111111111111111111111'
  const stdout = (opts.raw ?? (opts.lines ?? []).map((l) => JSON.stringify(l))).join('\n')
  fs.writeFileSync(path.join(dir, 'stdout.txt'), stdout === '' ? '' : stdout + '\n')

  const writeStore = opts.writeStore !== false && opts.slow !== true
  const usage = opts.usage ?? [{ inputOther: 100, output: 25, inputCacheRead: 10 }]
  const fixture = {
    sessionId,
    home,
    writeStore,
    usage,
    onResume: opts.onResume ?? null,
    stderr: opts.stderr ?? null,
    exitCode: opts.exitCode ?? 0,
    slow: opts.slow === true,
    stdoutPath: path.join(dir, 'stdout.txt'),
    argsPath: path.join(dir, 'args.txt'),
    envPath: path.join(dir, 'env.txt'),
    mark: INVOCATION_MARK,
  }
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(fixture))

  // CJS: this file is spawned from /tmp with no package.json type=module.
  const script = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const dir = path.dirname(__filename)
const fixture = JSON.parse(readFileSync(path.join(dir, 'fixture.json'), 'utf8'))
const args = process.argv.slice(2)
appendFileSync(fixture.argsPath, fixture.mark + '\\n' + args.join('\\n') + '\\n')
const envLines = Object.entries(process.env)
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => k + '=' + v)
  .join('\\n')
writeFileSync(fixture.envPath, envLines + '\\n')

if (fixture.slow) {
  setInterval(() => {}, 1 << 30)
} else {

if (fixture.onResume && args.includes('--session')) {
  if (fixture.onResume.stderr) process.stderr.write(fixture.onResume.stderr + '\\n')
  process.exit(fixture.onResume.exitCode)
}

if (fixture.writeStore) {
  const { DatabaseSync } = require('node:sqlite')
  const { mkdirSync } = require('node:fs')
  const xdg = process.env.XDG_DATA_HOME || fixture.home
  const dbDir = path.join(xdg, 'opencode')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec(\`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT
    );
  \`)
  const now = Date.now()
  const cwd = process.cwd()
  db.prepare(
    'INSERT OR REPLACE INTO session (id, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)',
  ).run(fixture.sessionId, 'fake', cwd, now, now)
  const insertMsg = db.prepare(
    'INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  )
  for (let i = 0; i < fixture.usage.length; i++) {
    const u = fixture.usage[i]
    const data = JSON.stringify({
      role: 'assistant',
      tokens: {
        input: u.inputOther,
        output: u.output,
        reasoning: 0,
        cache: { read: u.inputCacheRead ?? 0, write: 0 },
      },
      time: { created: now, completed: now },
    })
    insertMsg.run('msg_' + i, fixture.sessionId, now, now, data)
  }
  insertMsg.run(
    'msg_user',
    fixture.sessionId,
    now,
    now,
    JSON.stringify({
      role: 'user',
      tokens: { input: 99999, output: 99999, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, completed: now },
    }),
  )
  db.close()
}

if (fixture.stderr) process.stderr.write(fixture.stderr + '\\n')
process.stdout.write(readFileSync(fixture.stdoutPath))
process.exit(fixture.exitCode)
}
`

  fs.writeFileSync(binary, script, { mode: 0o755 })

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

/** `--format json` lines a healthy opencode 1.18.30 turn prints. */
export function successLines(finalText: string, sessionId?: string): unknown[] {
  const sid = sessionId ?? 'ses_11111111111111111111111111'
  return [
    { type: 'step_start', timestamp: 1, sessionID: sid, part: { type: 'step_start' } },
    {
      type: 'tool',
      timestamp: 2,
      sessionID: sid,
      part: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'running', input: { command: 'ls' } },
      },
    },
    {
      type: 'tool',
      timestamp: 3,
      sessionID: sid,
      part: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', output: 'a\nb\n', title: 'ls' },
      },
    },
    {
      type: 'text',
      timestamp: 4,
      sessionID: sid,
      part: { type: 'text', text: finalText },
    },
    {
      type: 'step_finish',
      timestamp: 5,
      sessionID: sid,
      part: { type: 'step_finish' },
    },
  ]
}
