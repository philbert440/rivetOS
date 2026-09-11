/**
 * wire tests — session-directory resolution, print/JSON line parsing /
 * HarnessEvent mapping, and the post-hoc usage reconcile against transcripts
 * written to a temp PI_HOME.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  listSessionIds,
  parsePiJsonLine,
  piHome,
  reconcileTurn,
  resolveSessionDir,
  sessionsRoot,
  toHarnessEvents,
  tokensFromUsage,
  transcriptFilesFor,
  usageFromEvent,
} from './wire.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wire-'))
  tmpDirs.push(dir)
  return dir
}

interface WriteOpts {
  home: string
  sessionId: string
  lines: unknown[]
}

function writeSession(opts: WriteOpts): string {
  const sessionDir = path.join(sessionsRoot(opts.home), opts.sessionId)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionDir, 'transcript.jsonl'),
    opts.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  )
  return sessionDir
}

const usage = (time: number, over: Partial<Record<string, number>> = {}): unknown => ({
  type: 'usage',
  input_tokens: over.input_tokens ?? 100,
  output_tokens: over.output_tokens ?? 10,
  cache_read_tokens: over.cache_read_tokens ?? 5,
  cache_write_tokens: over.cache_write_tokens ?? 0,
  usage_scope: 'turn',
  time,
})

describe('home + session resolution', () => {
  it('honours PI_HOME, else ~/.pi/agent', () => {
    expect(piHome({ PI_HOME: '/somewhere/else' })).toBe('/somewhere/else')
    expect(piHome({})).toBe(path.join(os.homedir(), '.pi', 'agent'))
  })

  it('resolves a session directory that exists', () => {
    const home = tmpHome()
    const dir = writeSession({ home, sessionId: 'session_a', lines: [] })
    expect(resolveSessionDir({ home, cwd: '/work/a', sessionId: 'session_a' })).toBe(dir)
  })

  it('returns undefined for a session that is not on disk', () => {
    const home = tmpHome()
    expect(resolveSessionDir({ home, cwd: '/work/c', sessionId: 'session_nope' })).toBeUndefined()
  })
})

describe('listSessionIds', () => {
  it('lists session directories (and bare .jsonl files) under sessions/', () => {
    const home = tmpHome()
    writeSession({ home, sessionId: 'session_d1', lines: [] })
    writeSession({ home, sessionId: 'session_d2', lines: [] })
    const root = sessionsRoot(home)
    fs.writeFileSync(path.join(root, 'session_file.jsonl'), '{}\n')

    expect([...listSessionIds(home, '/work/d')].sort()).toEqual([
      'session_d1',
      'session_d2',
      'session_file',
    ])
  })
})

describe('parsePiJsonLine', () => {
  it('parses a typed object and skips junk', () => {
    expect(parsePiJsonLine('{"type":"assistant","content":"hi"}')).toEqual({
      type: 'assistant',
      content: 'hi',
    })
    expect(parsePiJsonLine('not json')).toBeUndefined()
    expect(parsePiJsonLine('{"role":"assistant"}')).toBeUndefined()
    expect(parsePiJsonLine('')).toBeUndefined()
    expect(parsePiJsonLine('[1,2]')).toBeUndefined()
  })
})

describe('toHarnessEvents', () => {
  const sid = 'pi:session_x'

  it('maps assistant / thinking / tools / result / error', () => {
    expect(toHarnessEvents({ type: 'assistant', content: 'hello' }, sid)).toEqual([
      { type: 'assistant-delta', sessionId: sid, text: 'hello' },
    ])
    expect(toHarnessEvents({ type: 'thinking', content: 'hmm' }, sid)).toEqual([
      { type: 'reasoning-delta', sessionId: sid, text: 'hmm' },
    ])
    expect(
      toHarnessEvents({ type: 'tool_start', id: 't1', name: 'Bash', input: { command: 'ls' } }, sid),
    ).toEqual([
      {
        type: 'tool-use',
        sessionId: sid,
        toolCallId: 't1',
        name: 'Bash',
        input: { command: 'ls' },
      },
    ])
    expect(toHarnessEvents({ type: 'tool_end', id: 't1', output: 'ok' }, sid)).toEqual([
      {
        type: 'tool-result',
        sessionId: sid,
        toolCallId: 't1',
        name: '',
        output: 'ok',
      },
    ])
    expect(toHarnessEvents({ type: 'result', session_id: 'session_x', text: 'done' }, sid)).toEqual([
      { type: 'turn-complete', sessionId: sid, stopReason: 'end-turn' },
    ])
    expect(toHarnessEvents({ type: 'error', message: 'boom' }, sid)).toEqual([
      { type: 'error', sessionId: sid, code: 'pi_error', message: 'boom' },
    ])
  })

  it('returns nothing without a session id to attribute', () => {
    expect(toHarnessEvents({ type: 'assistant', content: 'x' }, '')).toEqual([])
  })
})

describe('usageFromEvent / tokensFromUsage', () => {
  it('sums input + cache into inputTokens and ignores session rollups', () => {
    expect(
      tokensFromUsage({ input_tokens: 100, output_tokens: 25, cache_read_tokens: 10 }),
    ).toEqual({ inputTokens: 110, outputTokens: 25 })
    expect(
      usageFromEvent({
        type: 'usage',
        input_tokens: 40,
        output_tokens: 5,
        usage_scope: 'turn',
      }),
    ).toEqual({ inputTokens: 40, outputTokens: 5 })
    expect(
      usageFromEvent({
        type: 'usage',
        input_tokens: 999,
        output_tokens: 999,
        usage_scope: 'session',
      }),
    ).toBeUndefined()
    expect(
      usageFromEvent({
        type: 'result',
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    ).toEqual({ inputTokens: 7, outputTokens: 3 })
  })
})

describe('reconcileTurn', () => {
  it('sums turn-scoped usage at or after the floor', () => {
    const home = tmpHome()
    const dir = writeSession({
      home,
      sessionId: 'session_e',
      lines: [
        { type: 'session', session_id: 'session_e' },
        usage(1000), // before the floor — a previous turn on a resumed session
        usage(2000, { input_tokens: 200, output_tokens: 20, cache_read_tokens: 0 }),
        {
          type: 'usage',
          input_tokens: 9999,
          output_tokens: 9999,
          usage_scope: 'session',
          time: 2000,
        },
        { type: 'turn_end', reason: 'completed', turn_id: 1, duration_ms: 1234, time: 2100 },
      ],
    })

    const facts = reconcileTurn({ sessionDir: dir, sinceMs: 1500 })
    expect(facts.usage).toEqual({ inputTokens: 200, outputTokens: 20, totalTokens: 220 })
    expect(facts.usageRecords).toBe(1)
    expect(facts.turnEnded).toMatchObject({ reason: 'completed', turnId: 1, durationMs: 1234 })
    expect(facts.files).toBe(1)
  })

  it('tolerates a torn final line', () => {
    const home = tmpHome()
    const dir = writeSession({
      home,
      sessionId: 'session_f',
      lines: [usage(3000), '{"type":"turn_end","reason":"cancel'],
    })
    const facts = reconcileTurn({ sessionDir: dir, sinceMs: 0 })
    expect(facts.malformed).toBe(1)
    expect(facts.usage.totalTokens).toBe(115)
    expect(facts.turnEnded).toBeUndefined()
  })

  it('reports zero rather than throwing when there is no transcript', () => {
    const facts = reconcileTurn({ sessionDir: '/nonexistent/session', sinceMs: 0 })
    expect(facts.usage.totalTokens).toBe(0)
    expect(facts.files).toBe(0)
    expect(transcriptFilesFor('/nonexistent/session')).toEqual([])
  })
})
