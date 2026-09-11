/**
 * wire tests — session-directory resolution, the post-hoc usage reconcile,
 * and parseOpencodeEvent against the assumed `--format json` schema.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  listSessionIds,
  messageFilesFor,
  opencodeHome,
  parseOpencodeEvent,
  readSessionIndex,
  reconcileTurn,
  resolveSessionDir,
  sessionsRoot,
} from './wire.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-wire-'))
  tmpDirs.push(dir)
  return dir
}

interface WriteOpts {
  home: string
  cwd: string
  sessionId: string
  messages: unknown[]
}

function writeSession(opts: WriteOpts): void {
  const sessionDir = path.join(sessionsRoot(opts.home), 'proj_test')
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionDir, `${opts.sessionId}.json`),
    JSON.stringify({ id: opts.sessionId, directory: opts.cwd, title: 'test' }),
  )
  const msgDir = path.join(opts.home, 'storage', 'message', opts.sessionId)
  fs.mkdirSync(msgDir, { recursive: true })
  opts.messages.forEach((m, i) => {
    const body = typeof m === 'string' ? m : JSON.stringify(m)
    fs.writeFileSync(path.join(msgDir, `msg_${String(i)}.json`), body)
  })
}

const assistant = (
  time: number,
  over: { input?: number; output?: number; cacheRead?: number } = {},
): unknown => ({
  id: `msg_${String(time)}`,
  sessionID: 'ses_x',
  role: 'assistant',
  tokens: {
    input: over.input ?? 100,
    output: over.output ?? 10,
    reasoning: 0,
    cache: { read: over.cacheRead ?? 5, write: 0 },
  },
  time: { created: time, completed: time },
})

describe('home resolution', () => {
  it('honours OPENCODE_DATA_DIR, else XDG_DATA_HOME/opencode, else ~/.local/share/opencode', () => {
    expect(opencodeHome({ OPENCODE_DATA_DIR: '/somewhere/else' })).toBe('/somewhere/else')
    expect(opencodeHome({ XDG_DATA_HOME: '/xdg' })).toBe(path.join('/xdg', 'opencode'))
    expect(opencodeHome({})).toBe(path.join(os.homedir(), '.local', 'share', 'opencode'))
  })
})

describe('resolveSessionDir', () => {
  it('finds a session JSON under storage/session/<project>/', () => {
    const home = tmpHome()
    const cwd = '/work/a'
    writeSession({ home, cwd, sessionId: 'ses_a', messages: [] })
    expect(resolveSessionDir({ home, cwd, sessionId: 'ses_a' })).toBe(
      path.join(sessionsRoot(home), 'proj_test'),
    )
  })

  it('returns undefined for a session that is not on disk', () => {
    const home = tmpHome()
    expect(resolveSessionDir({ home, cwd: '/work/c', sessionId: 'ses_nope' })).toBeUndefined()
  })
})

describe('listSessionIds', () => {
  it('is scoped to the working directory via session.directory', () => {
    const home = tmpHome()
    writeSession({ home, cwd: '/work/d', sessionId: 'ses_d1', messages: [] })
    writeSession({ home, cwd: '/work/d', sessionId: 'ses_d2', messages: [] })
    writeSession({ home, cwd: '/work/other', sessionId: 'ses_o', messages: [] })

    expect([...listSessionIds(home, '/work/d')].sort()).toEqual(['ses_d1', 'ses_d2'])
  })
})

describe('readSessionIndex', () => {
  it('walks storage/session as the index', () => {
    const home = tmpHome()
    writeSession({ home, cwd: '/work/i', sessionId: 'ses_i', messages: [] })
    const index = readSessionIndex(home)
    expect(index).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'ses_i', workDir: '/work/i' }),
      ]),
    )
  })
})

describe('reconcileTurn', () => {
  it('sums assistant tokens at or after the floor and ignores user rows', () => {
    const home = tmpHome()
    const cwd = '/work/e'
    writeSession({
      home,
      cwd,
      sessionId: 'ses_e',
      messages: [
        assistant(1000), // before the floor — a previous turn
        assistant(2000, { input: 200, output: 20, cacheRead: 0 }),
        {
          id: 'msg_user',
          role: 'user',
          tokens: { input: 9999, output: 9999, cache: { read: 0, write: 0 } },
          time: { created: 2000, completed: 2000 },
        },
        assistant(2050, { input: 50, output: 5, cacheRead: 0 }),
      ],
    })

    const facts = reconcileTurn({ home, sessionId: 'ses_e', sinceMs: 1500 })
    expect(facts.usage).toEqual({ inputTokens: 250, outputTokens: 25, totalTokens: 275 })
    expect(facts.usageRecords).toBe(2)
    expect(facts.turnEnded).toMatchObject({ reason: 'completed' })
    expect(facts.files).toBe(4)
  })

  it('tolerates a torn message file', () => {
    const home = tmpHome()
    writeSession({
      home,
      cwd: '/work/f',
      sessionId: 'ses_f',
      messages: [assistant(3000), '{"id":"torn","role":"assistant","tokens":'],
    })
    const facts = reconcileTurn({ home, sessionId: 'ses_f', sinceMs: 0 })
    expect(facts.malformed).toBe(1)
    expect(facts.usage.totalTokens).toBe(115)
  })

  it('reports zero rather than throwing when there is no transcript', () => {
    const facts = reconcileTurn({ home: '/nonexistent/home', sessionId: 'ses_nope', sinceMs: 0 })
    expect(facts.usage.totalTokens).toBe(0)
    expect(facts.files).toBe(0)
    expect(messageFilesFor('/nonexistent/home', 'ses_nope')).toEqual([])
  })
})

describe('parseOpencodeEvent', () => {
  it('maps text parts', () => {
    const ev = parseOpencodeEvent({
      type: 'text',
      part: { type: 'text', text: 'hello', sessionID: 'ses_1' },
    })
    expect(ev).toMatchObject({ kind: 'text', text: 'hello', sessionId: 'ses_1' })
  })

  it('maps running tool_use to tool-start and completed to tool-end', () => {
    const start = parseOpencodeEvent({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'c1',
        sessionID: 'ses_1',
        state: { status: 'running' },
      },
    })
    const end = parseOpencodeEvent({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'c1',
        sessionID: 'ses_1',
        state: { status: 'completed' },
      },
    })
    expect(start).toMatchObject({ kind: 'tool-start', tool: 'bash', toolCallId: 'c1' })
    expect(end).toMatchObject({ kind: 'tool-end', tool: 'bash', toolCallId: 'c1' })
  })

  it('maps step_finish tokens including cache read', () => {
    const ev = parseOpencodeEvent({
      type: 'step_finish',
      sessionID: 'ses_1',
      tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 10, write: 2 } },
    })
    expect(ev).toMatchObject({
      kind: 'usage',
      sessionId: 'ses_1',
      usage: { inputTokens: 112, outputTokens: 23 },
    })
  })

  it('maps error events', () => {
    const ev = parseOpencodeEvent({ type: 'error', error: { message: 'boom' } })
    expect(ev).toMatchObject({ kind: 'error', error: 'boom' })
  })

  it('returns undefined for non-objects', () => {
    expect(parseOpencodeEvent(null)).toBeUndefined()
    expect(parseOpencodeEvent('x')).toBeUndefined()
  })
})
