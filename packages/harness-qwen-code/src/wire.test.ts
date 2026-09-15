/**
 * wire tests — session-directory resolution, stream-json line parsing /
 * HarnessEvent mapping, and the post-hoc usage reconcile against session
 * jsonl written to a temp data dir.
 *
 * Fixtures are the REAL line shapes from samples/headless-stream-json-partial.ndjson,
 * samples/headless-tool-turn-stream-json.ndjson, and samples/*.jsonl, with
 * cwd rewritten to `/home/example`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  encodeQwenCwd,
  findSessionFile,
  isFatalQwenResult,
  listSessionIds,
  parseQwenJsonLine,
  qwenHome,
  qwenProjectsRoot,
  reconcileTurn,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-wire-'))
  tmpDirs.push(dir)
  return dir
}

const SID = '857b4b7d-3d13-4281-a648-11947cf530ed'
const TOOL_SID = '22222222-2222-4222-8222-222222222222'
const CWD = '/home/example'

interface WriteOpts {
  home: string
  sessionId: string
  cwd?: string
  lines: unknown[]
}

function writeSession(opts: WriteOpts): string {
  const cwd = opts.cwd ?? CWD
  const chats = path.join(qwenProjectsRoot(opts.home), encodeQwenCwd(cwd), 'chats')
  fs.mkdirSync(chats, { recursive: true })
  const file = path.join(chats, `${opts.sessionId}.jsonl`)
  fs.writeFileSync(
    file,
    opts.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  )
  return file
}

describe('home + session resolution', () => {
  it('uses ~/.qwen and ignores QWEN_HOME', () => {
    expect(qwenHome({ QWEN_HOME: '/somewhere/else' })).toBe(path.join(os.homedir(), '.qwen'))
    expect(qwenHome({})).toBe(path.join(os.homedir(), '.qwen'))
  })

  it('encodes cwd buckets the way qwen does (no wrapping dashes)', () => {
    expect(encodeQwenCwd('/home/rivet')).toBe('-home-rivet')
    expect(encodeQwenCwd('/home/rivet/')).toBe('-home-rivet')
    expect(encodeQwenCwd('/home/rivet/x')).toBe('-home-rivet-x')
  })

  it('resolves a session jsonl that exists', () => {
    const home = tmpHome()
    const file = writeSession({ home, sessionId: SID, lines: [] })
    expect(findSessionFile({ home, cwd: CWD, sessionId: SID })).toBe(file)
  })

  it('skips *.runtime.json sidecars when listing', () => {
    const home = tmpHome()
    const file = writeSession({ home, sessionId: SID, lines: [] })
    const chats = path.dirname(file)
    fs.writeFileSync(path.join(chats, `${SID}.runtime.json`), '{"schema_version":1}\n')
    expect([...listSessionIds(home, CWD)]).toEqual([SID])
    expect(findSessionFile({ home, cwd: CWD, sessionId: SID })).toBe(file)
  })

  it('returns undefined for a session that is not on disk', () => {
    const home = tmpHome()
    expect(
      findSessionFile({ home, cwd: CWD, sessionId: '00000000-0000-4000-8000-000000000000' }),
    ).toBeUndefined()
  })
})

describe('listSessionIds', () => {
  it('walks every project chats dir for <uuid>.jsonl files', () => {
    const home = tmpHome()
    writeSession({ home, sessionId: SID, cwd: '/home/example', lines: [] })
    writeSession({ home, sessionId: TOOL_SID, cwd: '/srv/work', lines: [] })

    expect([...listSessionIds(home, '/home/example')].sort()).toEqual([SID, TOOL_SID].sort())
  })
})

describe('parseQwenJsonLine', () => {
  it('parses a typed object and skips junk', () => {
    expect(
      parseQwenJsonLine(
        `{"type":"system","subtype":"init","uuid":"${SID}","session_id":"${SID}","cwd":"/home/example","model":"qwen-27b","permission_mode":"yolo","qwen_code_version":"0.23.4"}`,
      ),
    ).toMatchObject({ type: 'system', subtype: 'init', session_id: SID })
    expect(parseQwenJsonLine('not json')).toBeUndefined()
    expect(parseQwenJsonLine('{"role":"assistant"}')).toBeUndefined()
    expect(parseQwenJsonLine('')).toBeUndefined()
    expect(parseQwenJsonLine('[1,2]')).toBeUndefined()
  })
})

describe('toHarnessEvents (runtime stdout)', () => {
  const sid = `qwen-code:${SID}`

  it('maps system/init + thinking/text deltas + tool_use + tool_result', () => {
    expect(
      toHarnessEvents(
        {
          type: 'system',
          subtype: 'init',
          uuid: SID,
          session_id: SID,
          cwd: '/home/example',
          model: 'qwen-27b',
          permission_mode: 'yolo',
          qwen_code_version: '0.23.4',
        },
        sid,
      ),
    ).toEqual([{ type: 'session-updated', sessionId: sid, status: 'active' }])
    expect(
      toHarnessEvents(
        {
          type: 'stream_event',
          uuid: '8eab0e7f-9a9a-4275-945a-f332aea8ef2c',
          session_id: SID,
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'The' },
          },
        },
        sid,
      ),
    ).toEqual([{ type: 'reasoning-delta', sessionId: sid, text: 'The' }])
    expect(
      toHarnessEvents(
        {
          type: 'stream_event',
          uuid: '6a05e9cf-d29b-4bc4-8d7a-a64b5f8a8185',
          session_id: SID,
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '\n\npong' },
          },
        },
        sid,
      ),
    ).toEqual([{ type: 'assistant-delta', sessionId: sid, text: '\n\npong' }])
    expect(
      toHarnessEvents(
        {
          type: 'assistant',
          uuid: 'ac4e1e91-b4e5-4a25-b238-35b8071f0dfa',
          session_id: TOOL_SID,
          parent_tool_use_id: null,
          message: {
            id: 'ac4e1e91-b4e5-4a25-b238-35b8071f0dfa',
            type: 'message',
            role: 'assistant',
            model: 'qwen-27b',
            content: [
              {
                type: 'tool_use',
                id: 'call_6ef8c237955540faabb31812',
                name: 'run_shell_command',
                input: { command: 'echo tool-sample-ok' },
              },
            ],
            stop_reason: 'tool_use',
            usage: {
              input_tokens: 26222,
              output_tokens: 101,
              cache_read_input_tokens: 0,
              total_tokens: 26323,
            },
          },
        },
        sid,
      ),
    ).toEqual([
      {
        type: 'tool-use',
        sessionId: sid,
        toolCallId: 'call_6ef8c237955540faabb31812',
        name: 'run_shell_command',
        input: { command: 'echo tool-sample-ok' },
      },
    ])
    expect(
      toHarnessEvents(
        {
          type: 'user',
          uuid: 'f4b72359-349a-4ba5-b7e3-3cf0967cb8cf',
          session_id: TOOL_SID,
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_6ef8c237955540faabb31812',
                is_error: false,
                content: 'tool-sample-ok',
              },
            ],
          },
        },
        sid,
      ),
    ).toEqual([
      {
        type: 'tool-result',
        sessionId: sid,
        toolCallId: 'call_6ef8c237955540faabb31812',
        name: '',
        output: 'tool-sample-ok',
        isError: false,
      },
    ])
  })

  it('does not replay assistant snapshot text (deltas already streamed)', () => {
    expect(
      toHarnessEvents(
        {
          type: 'assistant',
          uuid: '1323af5d-03d7-4986-8936-f4aa04df7f05',
          session_id: SID,
          parent_tool_use_id: null,
          message: {
            id: '1323af5d-03d7-4986-8936-f4aa04df7f05',
            type: 'message',
            role: 'assistant',
            model: 'qwen-27b',
            content: [{ type: 'text', text: '\n\npong' }],
            stop_reason: null,
            usage: {
              input_tokens: 24319,
              output_tokens: 39,
              cache_read_input_tokens: 0,
              total_tokens: 24358,
            },
          },
        },
        sid,
      ),
    ).toEqual([])
  })

  it('propagates result.is_error / non-success subtype and turn-complete', () => {
    expect(isFatalQwenResult({ is_error: true, subtype: 'error' })).toBe(true)
    expect(isFatalQwenResult({ is_error: false, subtype: 'error_max_turns' })).toBe(true)
    expect(isFatalQwenResult({ is_error: false, subtype: 'success' })).toBe(false)
    expect(
      toHarnessEvents(
        {
          type: 'result',
          subtype: 'success',
          uuid: 'ca5a15ad-638b-4be8-becd-a268b0d266bd',
          session_id: SID,
          is_error: false,
          duration_ms: 49029,
          num_turns: 1,
          result: '\n\npong',
          usage: {
            input_tokens: 34751,
            output_tokens: 208,
            cache_read_input_tokens: 0,
            total_tokens: 34959,
          },
          permission_denials: [],
        },
        sid,
      ),
    ).toEqual([{ type: 'turn-complete', sessionId: sid, stopReason: 'success' }])
    expect(
      toHarnessEvents(
        {
          type: 'result',
          subtype: 'error_max_turns',
          uuid: 'ca5a15ad-638b-4be8-becd-a268b0d266bd',
          session_id: SID,
          is_error: true,
          result: '',
          usage: { input_tokens: 1, output_tokens: 0 },
        },
        sid,
      ),
    ).toEqual([
      {
        type: 'error',
        sessionId: sid,
        code: 'error_max_turns',
        message: 'qwen result: error_max_turns',
      },
      { type: 'turn-complete', sessionId: sid, stopReason: 'error_max_turns' },
    ])
  })

  it('returns nothing without a session id to attribute', () => {
    expect(
      toHarnessEvents(
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
        },
        '',
      ),
    ).toEqual([])
  })
})

describe('toHarnessEventsFromDisk (session jsonl)', () => {
  const sid = `qwen-code:${SID}`

  it('maps assistant parts thought/text/functionCall and tool_result functionResponse', () => {
    expect(
      toHarnessEventsFromDisk(
        {
          type: 'assistant',
          uuid: '8135b5a6-0277-4cc5-87b8-780fd52d0f3e',
          sessionId: TOOL_SID,
          timestamp: '2026-09-15T20:26:32.134Z',
          provenance: 'assistant_output',
          cwd: '/home/example',
          version: '0.23.4',
          model: 'qwen-27b',
          message: {
            role: 'model',
            parts: [
              { text: 'plan', thought: true },
              { text: '\n\n' },
              {
                functionCall: {
                  id: 'call_6ef8c237955540faabb31812',
                  name: 'run_shell_command',
                  args: { command: 'echo tool-sample-ok' },
                },
              },
            ],
          },
          usageMetadata: {
            promptTokenCount: 26222,
            candidatesTokenCount: 101,
            thoughtsTokenCount: 61,
            totalTokenCount: 26323,
            cachedContentTokenCount: 0,
          },
          contextWindowSize: 262144,
        },
        sid,
      ),
    ).toEqual([
      { type: 'reasoning-delta', sessionId: sid, text: 'plan' },
      { type: 'assistant-delta', sessionId: sid, text: '\n\n' },
      {
        type: 'tool-use',
        sessionId: sid,
        toolCallId: 'call_6ef8c237955540faabb31812',
        name: 'run_shell_command',
        input: { command: 'echo tool-sample-ok' },
      },
    ])
    expect(
      toHarnessEventsFromDisk(
        {
          type: 'tool_result',
          uuid: 'a7339e8d-239e-42db-8a8f-7bbb41a8a494',
          sessionId: TOOL_SID,
          timestamp: '2026-09-15T20:26:32.341Z',
          provenance: 'tool_result',
          cwd: '/home/example',
          version: '0.23.4',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_6ef8c237955540faabb31812',
                  name: 'run_shell_command',
                  response: { output: 'tool-sample-ok' },
                },
              },
            ],
          },
        },
        sid,
      ),
    ).toEqual([
      {
        type: 'tool-result',
        sessionId: sid,
        toolCallId: 'call_6ef8c237955540faabb31812',
        name: 'run_shell_command',
        output: 'tool-sample-ok',
      },
    ])
  })

  it('skips type:system lines', () => {
    expect(
      toHarnessEventsFromDisk(
        {
          type: 'system',
          subtype: 'ui_telemetry',
          systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_response' } },
        },
        sid,
      ),
    ).toEqual([])
  })
})

describe('usageFromEvent / tokensFromUsage', () => {
  it('reads runtime assistant usage and ignores the zero-usage thinking block', () => {
    expect(
      tokensFromUsage({
        input_tokens: 24319,
        output_tokens: 39,
        cache_read_input_tokens: 0,
        total_tokens: 24358,
      }),
    ).toEqual({ inputTokens: 24319, outputTokens: 39, cacheRead: 0 })
    expect(
      usageFromEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'plan' }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ).toBeUndefined()
    expect(
      usageFromEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '\n\npong' }],
          usage: {
            input_tokens: 24319,
            output_tokens: 39,
            cache_read_input_tokens: 10,
            total_tokens: 24368,
          },
        },
      }),
    ).toEqual({ inputTokens: 24319, outputTokens: 39, cacheRead: 10 })
    expect(
      usageFromEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: {
          input_tokens: 34751,
          output_tokens: 208,
          cache_read_input_tokens: 0,
          total_tokens: 34959,
        },
      }),
    ).toEqual({ inputTokens: 34751, outputTokens: 208, cacheRead: 0 })
  })

  it('reads disk usageMetadata and ui_telemetry api_response', () => {
    expect(
      usageFromEvent({
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'pong' }] },
        usageMetadata: {
          promptTokenCount: 24319,
          candidatesTokenCount: 39,
          thoughtsTokenCount: 36,
          totalTokenCount: 24358,
          cachedContentTokenCount: 0,
        },
      } as never),
    ).toEqual({ inputTokens: 24319, outputTokens: 39, cacheRead: 0 })
    expect(
      usageFromEvent({
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            input_token_count: 24319,
            output_token_count: 39,
            cached_content_token_count: 0,
            total_token_count: 24358,
          },
        },
      }),
    ).toEqual({ inputTokens: 24319, outputTokens: 39, cacheRead: 0 })
  })
})

describe('reconcileTurn', () => {
  it('sums assistant usageMetadata at or after the floor', () => {
    const home = tmpHome()
    const file = writeSession({
      home,
      sessionId: SID,
      lines: [
        {
          uuid: '88038e15-95b1-4c70-9058-837a5ea716db',
          sessionId: SID,
          timestamp: '2026-09-15T20:21:15.392Z',
          type: 'user',
          provenance: 'real_user',
          cwd: CWD,
          version: '0.23.4',
          message: {
            role: 'user',
            parts: [{ text: 'Reply with exactly the word pong and nothing else.' }],
          },
        },
        {
          uuid: '8acca8ca-ac64-47a4-a889-848e35724829',
          sessionId: SID,
          timestamp: '2026-09-15T20:21:45.793Z',
          type: 'assistant',
          provenance: 'assistant_output',
          cwd: CWD,
          version: '0.23.4',
          model: 'qwen-27b',
          message: {
            role: 'model',
            parts: [{ text: 'plan', thought: true }, { text: '\n\npong' }],
          },
          usageMetadata: {
            promptTokenCount: 24319,
            candidatesTokenCount: 39,
            thoughtsTokenCount: 36,
            totalTokenCount: 24358,
            cachedContentTokenCount: 0,
          },
          contextWindowSize: 262144,
        },
      ],
    })

    const facts = reconcileTurn({
      sessionDir: file,
      sinceMs: Date.parse('2026-09-15T20:21:30.000Z'),
    })
    expect(facts.usage).toEqual({
      inputTokens: 24319,
      outputTokens: 39,
      totalTokens: 24358,
      cacheRead: 0,
    })
    expect(facts.usageRecords).toBe(1)
    expect(facts.files).toBe(1)
  })

  it('falls back to ui_telemetry api_response when assistant usage is missing', () => {
    const home = tmpHome()
    const file = writeSession({
      home,
      sessionId: SID,
      lines: [
        {
          type: 'system',
          subtype: 'ui_telemetry',
          timestamp: '2026-09-15T20:21:45.788Z',
          systemPayload: {
            uiEvent: {
              'event.name': 'qwen-code.api_response',
              input_token_count: 100,
              output_token_count: 25,
              cached_content_token_count: 10,
            },
          },
        },
      ],
    })
    const facts = reconcileTurn({ sessionDir: file, sinceMs: 0 })
    expect(facts.usage).toEqual({
      inputTokens: 110,
      outputTokens: 25,
      totalTokens: 135,
      cacheRead: 10,
    })
    expect(facts.usageRecords).toBe(1)
  })

  it('tolerates a torn final line', () => {
    const home = tmpHome()
    const file = writeSession({
      home,
      sessionId: SID,
      lines: [
        {
          type: 'assistant',
          timestamp: '2026-09-15T20:21:45.793Z',
          message: { role: 'model', parts: [{ text: 'ok' }] },
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 10,
            cachedContentTokenCount: 5,
          },
        },
        '{"type":"assistant","message":{"role":"model"',
      ],
    })
    const facts = reconcileTurn({ sessionDir: file, sinceMs: 0 })
    expect(facts.malformed).toBe(1)
    expect(facts.usage.totalTokens).toBe(115)
  })

  it('reports zero rather than throwing when there is no transcript', () => {
    const facts = reconcileTurn({ sessionDir: '/nonexistent/session.jsonl', sinceMs: 0 })
    expect(facts.usage.totalTokens).toBe(0)
    expect(facts.files).toBe(0)
    expect(transcriptFilesFor('/nonexistent/session.jsonl')).toEqual([])
  })
})
