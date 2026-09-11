/**
 * wire tests — session-directory resolution, print/JSON line parsing /
 * HarnessEvent mapping, and the post-hoc usage reconcile against session
 * jsonl written to a temp data dir.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  encodePiCwd,
  findSessionFile,
  isFatalPiStopReason,
  listSessionIds,
  parsePiJsonLine,
  piHome,
  reconcileTurn,
  sessionsRoot,
  toHarnessEvents,
  toHarnessEventsFromDisk,
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

const SID = '01a090db-c402-71cb-a954-6066b9493630'
const CWD = '/home/rivet'

interface WriteOpts {
  home: string
  sessionId: string
  cwd?: string
  lines: unknown[]
}

function writeSession(opts: WriteOpts): string {
  const cwd = opts.cwd ?? CWD
  const bucket = path.join(sessionsRoot(opts.home), encodePiCwd(cwd))
  fs.mkdirSync(bucket, { recursive: true })
  const file = path.join(bucket, `2026-09-11T14-25-16-803Z_${opts.sessionId}.jsonl`)
  fs.writeFileSync(
    file,
    opts.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  )
  return file
}

describe('home + session resolution', () => {
  it('uses ~/.pi/agent and ignores PI_HOME', () => {
    expect(piHome({ PI_HOME: '/somewhere/else' })).toBe(path.join(os.homedir(), '.pi', 'agent'))
    expect(piHome({})).toBe(path.join(os.homedir(), '.pi', 'agent'))
  })

  it('encodes cwd buckets the way pi does', () => {
    expect(encodePiCwd('/home/rivet')).toBe('--home-rivet--')
    expect(encodePiCwd('/home/rivet/')).toBe('--home-rivet--')
  })

  it('resolves a session jsonl that exists', () => {
    const home = tmpHome()
    const file = writeSession({ home, sessionId: SID, lines: [] })
    expect(findSessionFile({ home, cwd: CWD, sessionId: SID })).toBe(file)
  })

  it('resolves a flat --session-dir file (<dir>/<ts>_<id>.jsonl, no cwd bucket)', () => {
    const home = tmpHome()
    const root = sessionsRoot(home)
    fs.mkdirSync(root, { recursive: true })
    const file = path.join(root, `2026-09-11T14-25-16-803Z_${SID}.jsonl`)
    fs.writeFileSync(file, '')
    expect(findSessionFile({ home, cwd: CWD, sessionId: SID })).toBe(file)
    expect([...listSessionIds(home, CWD)]).toEqual([SID])
  })

  it('returns undefined for a session that is not on disk', () => {
    const home = tmpHome()
    expect(
      findSessionFile({ home, cwd: CWD, sessionId: '00000000-0000-4000-8000-000000000000' }),
    ).toBeUndefined()
  })
})

describe('listSessionIds', () => {
  it('walks every cwd bucket for *_<uuid>.jsonl files', () => {
    const home = tmpHome()
    const other = '42accb06-524a-47a6-b4b3-0991552914d7'
    writeSession({ home, sessionId: SID, cwd: '/home/rivet', lines: [] })
    writeSession({ home, sessionId: other, cwd: '/srv/work', lines: [] })

    expect([...listSessionIds(home, '/home/rivet')].sort()).toEqual([other, SID].sort())
  })
})

describe('parsePiJsonLine', () => {
  it('parses a typed object and skips junk', () => {
    expect(parsePiJsonLine('{"type":"session","version":3,"id":"' + SID + '"}')).toEqual({
      type: 'session',
      version: 3,
      id: SID,
    })
    expect(parsePiJsonLine('not json')).toBeUndefined()
    expect(parsePiJsonLine('{"role":"assistant"}')).toBeUndefined()
    expect(parsePiJsonLine('')).toBeUndefined()
    expect(parsePiJsonLine('[1,2]')).toBeUndefined()
  })
})

describe('toHarnessEvents (runtime stdout)', () => {
  const sid = `pi:${SID}`

  it('maps session + text/thinking deltas + toolcall + toolResult', () => {
    expect(toHarnessEvents({ type: 'session', id: SID }, sid)).toEqual([
      { type: 'session-updated', sessionId: sid, status: 'active' },
    ])
    expect(
      toHarnessEvents(
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'p' } },
        sid,
      ),
    ).toEqual([{ type: 'assistant-delta', sessionId: sid, text: 'p' }])
    expect(
      toHarnessEvents(
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
        },
        sid,
      ),
    ).toEqual([{ type: 'reasoning-delta', sessionId: sid, text: 'hmm' }])
    expect(
      toHarnessEvents(
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_end',
            contentIndex: 1,
            id: 't1',
            name: 'Bash',
            arguments: { command: 'ls' },
          },
        },
        sid,
      ),
    ).toEqual([
      { type: 'tool-use', sessionId: sid, toolCallId: 't1', name: 'Bash', input: { command: 'ls' } },
    ])
    expect(
      toHarnessEvents(
        {
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: 't1',
            toolName: 'Bash',
            content: [{ type: 'text', text: 'ok' }],
          },
        },
        sid,
      ),
    ).toEqual([
      { type: 'tool-result', sessionId: sid, toolCallId: 't1', name: 'Bash', output: 'ok' },
    ])
  })

  it('does not replay message_end snapshot text (deltas already streamed)', () => {
    expect(
      toHarnessEvents(
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'pong' }],
            stopReason: 'stop',
          },
        },
        sid,
      ),
    ).toEqual([])
  })

  it('propagates stopReason error/aborted and turn_end', () => {
    expect(isFatalPiStopReason('error')).toBe(true)
    expect(isFatalPiStopReason('aborted')).toBe(true)
    expect(isFatalPiStopReason('stop')).toBe(false)
    expect(
      toHarnessEvents(
        { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } },
        sid,
      ),
    ).toEqual([{ type: 'error', sessionId: sid, code: 'aborted', message: 'pi stopReason: aborted' }])
    expect(toHarnessEvents({ type: 'turn_end', message: { role: 'assistant', stopReason: 'stop' } }, sid)).toEqual([
      { type: 'turn-complete', sessionId: sid, stopReason: 'stop' },
    ])
  })

  it('returns nothing without a session id to attribute', () => {
    expect(
      toHarnessEvents(
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } },
        '',
      ),
    ).toEqual([])
  })
})

describe('toHarnessEventsFromDisk (session jsonl)', () => {
  const sid = `pi:${SID}`

  it('maps assistant message text / thinking / tools', () => {
    expect(
      toHarnessEventsFromDisk(
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'toolCall', id: 't1', name: 'Bash', arguments: { command: 'ls' } },
              { type: 'text', text: 'hello' },
            ],
          },
        },
        sid,
      ),
    ).toEqual([
      { type: 'reasoning-delta', sessionId: sid, text: 'hmm' },
      {
        type: 'tool-use',
        sessionId: sid,
        toolCallId: 't1',
        name: 'Bash',
        input: { command: 'ls' },
      },
      { type: 'assistant-delta', sessionId: sid, text: 'hello' },
    ])
  })
})

describe('usageFromEvent / tokensFromUsage', () => {
  it('sums input + cache into inputTokens from assistant message.usage', () => {
    expect(
      tokensFromUsage({ input: 1516, output: 10, cacheRead: 2, cacheWrite: 3, reasoning: 0, totalTokens: 1526 }),
    ).toEqual({ inputTokens: 1521, outputTokens: 10 })
    expect(
      tokensFromUsage({ input_tokens: 100, output_tokens: 25, cache_read_tokens: 10 }),
    ).toEqual({ inputTokens: 110, outputTokens: 25 })
    expect(
      usageFromEvent({
        type: 'message',
        message: {
          role: 'assistant',
          content: [],
          usage: { input: 40, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    ).toEqual({ inputTokens: 40, outputTokens: 5 })
    expect(
      usageFromEvent({
        type: 'message',
        message: { role: 'user', content: [], usage: { input: 9, output: 1 } },
      }),
    ).toBeUndefined()
    expect(
      usageFromEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          usage: { input: 1145, output: 3, cacheRead: 384, cacheWrite: 0 },
          stopReason: 'stop',
        },
      }),
    ).toEqual({ inputTokens: 1529, outputTokens: 3 })
    expect(
      usageFromEvent({
        type: 'message_update',
        usage: { input: 1145, output: 3, cacheRead: 384 },
      }),
    ).toBeUndefined()
    expect(
      usageFromEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          usage: { input: 0, output: 0 },
          stopReason: 'pending',
        },
      }),
    ).toBeUndefined()
  })
})

describe('reconcileTurn', () => {
  it('sums assistant usage at or after the floor', () => {
    const home = tmpHome()
    const file = writeSession({
      home,
      sessionId: SID,
      lines: [
        { type: 'session', version: 3, id: SID, timestamp: '2026-09-11T14:25:16.803Z', cwd: CWD },
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'old' }],
            timestamp: 1000,
            usage: { input: 100, output: 10 },
          },
        },
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'new' }],
            timestamp: 2000,
            usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 },
            stopReason: 'end_turn',
          },
        },
      ],
    })

    const facts = reconcileTurn({ sessionDir: file, sinceMs: 1500 })
    expect(facts.usage).toEqual({ inputTokens: 200, outputTokens: 20, totalTokens: 220 })
    expect(facts.usageRecords).toBe(1)
    expect(facts.turnEnded).toMatchObject({ reason: 'end_turn' })
    expect(facts.files).toBe(1)
  })

  it('tolerates a torn final line', () => {
    const home = tmpHome()
    const file = writeSession({
      home,
      sessionId: SID,
      lines: [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [],
            timestamp: 3000,
            usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0 },
          },
        },
        '{"type":"message","message":{"role":"assistant"',
      ],
    })
    const facts = reconcileTurn({ sessionDir: file, sinceMs: 0 })
    expect(facts.malformed).toBe(1)
    expect(facts.usage.totalTokens).toBe(115)
    expect(facts.turnEnded).toBeUndefined()
  })

  it('reports zero rather than throwing when there is no transcript', () => {
    const facts = reconcileTurn({ sessionDir: '/nonexistent/session.jsonl', sinceMs: 0 })
    expect(facts.usage.totalTokens).toBe(0)
    expect(facts.files).toBe(0)
    expect(transcriptFilesFor('/nonexistent/session.jsonl')).toEqual([])
  })
})
