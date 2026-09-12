import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  createGetFullTool,
  extractCodexFromLine,
  extractFullFromLine,
  extractPiFromLine,
  formatMissingJsonlMessage,
  isCaptureTranscriptPath,
  readJsonlLine,
} from './get-full-tool.js'
import { isCodexSessionKey, truncationHint } from './helpers.js'

describe('formatMissingJsonlMessage', () => {
  it('never claims the tail is unrecoverable for a multi-host miss', () => {
    const msg = formatMissingJsonlMessage(
      '/home/rivet/.grok/sessions/%2Fhome%2Frivet/019fcf25/updates.jsonl',
      { agent: 'rivet-claude' },
    )
    expect(msg).toContain('not readable from this host')
    expect(msg).toContain('agent=rivet-claude')
    expect(msg).toContain('/home/rivet/')
    expect(msg).toContain('Next steps')
    expect(msg).toContain('16K capture cap')
    expect(msg).not.toMatch(/unrecoverable/i)
    expect(msg).not.toMatch(/gone or invalid/i)
  })

  it('flags desk-user home paths distinctly', () => {
    const msg = formatMissingJsonlMessage('/home/philip/.grok/sessions/foo/updates.jsonl')
    expect(msg).toContain('desk/user home')
    expect(msg).not.toMatch(/unrecoverable/i)
  })

  it('still guides when the path shape is unfamiliar', () => {
    const msg = formatMissingJsonlMessage('/var/tmp/weird/updates.jsonl')
    expect(msg).toContain('absolute paths')
    expect(msg).toContain('Next steps')
  })
})

describe('extractFullFromLine', () => {
  it('extracts full Bash output from a session update line', () => {
    const line = JSON.stringify({
      method: 'session/update',
      params: {
        _meta: { promptId: 'p1' },
        update: {
          sessionUpdate: 'tool_call_update',
          rawOutput: {
            type: 'Bash',
            output_for_prompt: 'x'.repeat(20000),
            exit_code: 0,
          },
        },
      },
    })
    const { toolResult } = extractFullFromLine(line)
    expect(toolResult).not.toBeNull()
    expect(toolResult!.length).toBeGreaterThan(20000 - 1)
    expect(toolResult).toContain('[exit_code=0]')
  })

  it('extracts MCP envelope output', () => {
    const line = JSON.stringify({
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          rawOutput: {
            type: 'MCP',
            server_name: 'rivetos',
            tool_name: 'memory_browse',
            output: { OkayOutput: 'big payload here' },
          },
        },
      },
    })
    const { toolResult } = extractFullFromLine(line)
    expect(toolResult).toBe('[mcp rivetos/memory_browse]\nbig payload here')
  })

  it('extracts message text and prefixes thinking', () => {
    const msg = JSON.stringify({
      params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hello world' } },
      },
    })
    expect(extractFullFromLine(msg).content).toBe('hello world')
    const thought = JSON.stringify({
      params: {
        update: { sessionUpdate: 'agent_thought_chunk', content: [{ type: 'text', text: 'hmm' }] },
      },
    })
    expect(extractFullFromLine(thought).content).toBe('[thinking] hmm')
  })

  it('never throws on malformed lines', () => {
    expect(extractFullFromLine('not json')).toEqual({ content: '', toolResult: null })
    expect(extractFullFromLine('{}').content).toBe('')
  })

  it('extracts dsh user/assistant/tool SessionEvents', () => {
    const user = JSON.stringify({
      type: 'user/message',
      seq: 7,
      data: { content: [{ type: 'text', text: 'hello dsh' }], id: 'u1' },
    })
    expect(extractFullFromLine(user).content).toBe('hello dsh')

    const assistant = JSON.stringify({
      type: 'assistant/message',
      seq: 21,
      data: { message: { content: [{ type: 'text', text: 'dsh ok' }] } },
    })
    expect(extractFullFromLine(assistant).content).toBe('dsh ok')

    const call = JSON.stringify({
      type: 'tool/call',
      seq: 30,
      data: { name: 'bash', arguments: '{"command":"echo hi"}' },
    })
    expect(extractFullFromLine(call)).toEqual({
      content: '[tool] bash',
      toolResult: '{"command":"echo hi"}',
    })

    const result = JSON.stringify({
      type: 'tool/result',
      seq: 31,
      data: { message: { name: 'bash', content: [{ type: 'text', text: 'hi\n' }] } },
    })
    expect(extractFullFromLine(result).content).toBe('[tool-result] bash')
    expect(extractFullFromLine(result).toolResult).toBe('hi\n')
  })

  it('extracts Codex rollout response_item user/assistant/tool/reasoning', () => {
    const user = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        id: 'rs_user1',
        content: [{ type: 'input_text', text: 'list the files' }],
      },
    })
    expect(extractFullFromLine(user).content).toBe('list the files')
    expect(extractFullFromLine(user).toolResult).toBeNull()

    const assistant = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        id: 'rs_asst1',
        content: [{ type: 'output_text', text: 'here they are' }],
      },
    })
    expect(extractFullFromLine(assistant).content).toBe('here they are')

    const think = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'reasoning',
        id: 'rs_think1',
        summary: [{ type: 'summary_text', text: 'I should list' }],
      },
    })
    expect(extractFullFromLine(think).content).toBe('[thinking] I should list')

    const call = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        id: 'ctc_1',
        name: 'shell',
        input: JSON.stringify({ command: 'ls' }),
      },
    })
    expect(extractFullFromLine(call)).toEqual({
      content: '[tool] shell',
      toolResult: JSON.stringify({ command: 'ls' }),
    })

    const result = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        id: 'ctco_1',
        call_id: 'ctc_1',
        output: 'a.txt\n' + 'z'.repeat(100),
      },
    })
    expect(extractFullFromLine(result).content).toBe('[tool-result]')
    expect(extractFullFromLine(result).toolResult).toContain('a.txt')
    expect(extractFullFromLine(call.replace('custom_tool_call', 'function_call'))).toEqual(
      extractFullFromLine(call),
    )
    expect(
      extractFullFromLine(result.replace('custom_tool_call_output', 'function_call_output')),
    ).toEqual(extractFullFromLine(result))
    expect(extractCodexFromLine({ type: 'session_meta' })).toBeNull()
  })

  it('extracts pi v3 user/assistant/toolResult message lines', () => {
    const user = JSON.stringify({
      type: 'message',
      id: 'aa11bb22',
      message: { role: 'user', content: [{ type: 'text', text: 'list the files' }] },
    })
    expect(extractFullFromLine(user).content).toBe('list the files')
    expect(extractFullFromLine(user).toolResult).toBeNull()
    expect(extractPiFromLine(JSON.parse(user))?.content).toBe('list the files')

    const assistant = JSON.stringify({
      type: 'message',
      id: 'cc33dd44',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should list' },
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } },
          { type: 'text', text: 'here they are' },
        ],
      },
    })
    const asst = extractFullFromLine(assistant)
    expect(asst.content).toBe('here they are')
    expect(asst.reasoning).toBe('I should list')
    expect(asst.toolResult).toBe(JSON.stringify({ command: 'ls' }))

    const result = JSON.stringify({
      type: 'message',
      id: 'ee55ff66',
      message: {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'a.txt\n' }],
      },
    })
    expect(extractFullFromLine(result).content).toBe('[tool-result] bash')
    expect(extractFullFromLine(result).toolResult).toBe('a.txt')

    expect(extractPiFromLine({ type: 'session' })).toBeNull()
    expect(extractPiFromLine({ type: 'response_item' })).toBeNull()
    expect(
      extractFullFromLine(user, { source: 'pi-session', sourceEvent: 'message:user' }).content,
    ).toBe('list the files')
  })
})

describe('isCaptureTranscriptPath', () => {
  it('accepts grok jsonl and dsh zstd transcripts', () => {
    expect(isCaptureTranscriptPath('/home/rivet/.grok/sessions/x/updates.jsonl')).toBe(true)
    expect(
      isCaptureTranscriptPath('/home/rivet/.dsh/sessions/ws/session-abc/session.jsonl.zstd'),
    ).toBe(true)
    expect(isCaptureTranscriptPath('/tmp/session.jsonl.zst')).toBe(true)
    expect(
      isCaptureTranscriptPath(
        '/home/rivet/.codex/sessions/2026/09/07/rollout-2026-09-07T12-00-00-89965427-b96f-4d5e-8ad5-c3dd138e33dc.jsonl',
      ),
    ).toBe(true)
    expect(isCaptureTranscriptPath('/tmp/notes.txt')).toBe(false)
  })
})

describe('isCodexSessionKey', () => {
  it('accepts codex:<uuid> and rejects other schemes', () => {
    expect(isCodexSessionKey('codex:89965427-b96f-4d5e-8ad5-c3dd138e33dc')).toBe(true)
    expect(isCodexSessionKey('kimi-code:abc')).toBe(false)
    expect(isCodexSessionKey('codex:not-a-uuid')).toBe(false)
    expect(isCodexSessionKey(null)).toBe(false)
  })
})

describe('truncationHint', () => {
  it('is empty for complete rows', () => {
    expect(truncationHint(null, 'x')).toBe('')
    expect(truncationHint({}, 'x')).toBe('')
    expect(truncationHint({ truncated: false }, 'x')).toBe('')
  })

  it('carries length and the get_full handle', () => {
    const hint = truncationHint({ truncated: true, full_tool_result_length: 52340 }, 'row-9')
    expect(hint).toContain('52340 chars')
    expect(hint).toContain('memory_get_full id=row-9')
  })
})

describe('readJsonlLine', () => {
  const writeJsonl = (lines: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'getfull-'))
    const file = join(dir, 'updates.jsonl')
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    return file
  }

  it('recovers a matched line (regression: close-event race resolved null on every hit)', async () => {
    const file = writeJsonl(['{"a":1}', '{"b":2}', '{"c":3}'])
    expect(await readJsonlLine(file, 1)).toBe('{"b":2}')
  })

  it('recovers the first and last lines', async () => {
    const file = writeJsonl(['first', 'mid', 'last'])
    expect(await readJsonlLine(file, 0)).toBe('first')
    expect(await readJsonlLine(file, 2)).toBe('last')
  })

  it('returns null past the end of the file', async () => {
    const file = writeJsonl(['only'])
    expect(await readJsonlLine(file, 5)).toBeNull()
  })
})

describe('createGetFullTool end-to-end (stub pool + real temp JSONL)', () => {
  it('recovers the full elided payload from disk', async () => {
    const big = 'y'.repeat(30_000)
    const dir = mkdtempSync(join(tmpdir(), 'getfull-e2e-'))
    const file = join(dir, 'updates.jsonl')
    const lines = [
      JSON.stringify({ params: { update: { sessionUpdate: 'noise' } } }),
      JSON.stringify({
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            rawOutput: { type: 'Bash', output_for_prompt: big, exit_code: 0 },
          },
        },
      }),
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const row = {
      id: 'row-1',
      content: 'preview…',
      tool_name: 'Bash',
      tool_result: 'preview…',
      agent: 'rivet-grok',
      metadata: {
        truncated: true,
        session_jsonl_path: file,
        session_jsonl_line: 1,
        full_tool_result_length: big.length,
      },
    }
    const pool = { query: async () => ({ rows: [row] }) } as unknown as pg.Pool

    const out = await createGetFullTool(pool).execute({ id: 'row-1' })
    expect(out).toContain('## Full payload for row-1')
    expect(out).toContain(big)
    expect(out).toContain('[exit_code=0]')
  })

  it('guides multi-host recovery when the JSONL is not on this host', async () => {
    const row = {
      id: 'row-remote',
      content: 'preview…',
      tool_name: 'Bash',
      tool_result: 'preview…',
      agent: 'rivet-claude',
      metadata: {
        truncated: true,
        session_jsonl_path: '/home/rivet/.grok/sessions/remote-node/updates.jsonl',
        session_jsonl_line: 12,
        full_tool_result_length: 40_000,
      },
    }
    const pool = { query: async () => ({ rows: [row] }) } as unknown as pg.Pool
    const out = await createGetFullTool(pool).execute({ id: 'row-remote' })
    expect(out).toContain('not readable from this host')
    expect(out).toContain('agent=rivet-claude')
    expect(out).toContain('Next steps')
    expect(out).not.toMatch(/unrecoverable/i)
  })

  it('recovers a truncated Codex rollout line from disk', async () => {
    const big = 'z'.repeat(30_000)
    const dir = mkdtempSync(join(tmpdir(), 'getfull-codex-'))
    const file = join(dir, 'rollout-2026-09-07T12-00-00-89965427-b96f-4d5e-8ad5-c3dd138e33dc.jsonl')
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: '89965427-b96f-4d5e-8ad5-c3dd138e33dc' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          id: 'ctco_1',
          call_id: 'ctc_1',
          output: big,
        },
      }),
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const row = {
      id: 'row-codex',
      content: '[tool-result] shell',
      tool_name: 'shell',
      tool_result: 'preview…',
      agent: 'rivet-gpt',
      metadata: {
        truncated: true,
        session_jsonl_path: file,
        session_jsonl_line: 1,
        full_tool_result_length: big.length,
      },
    }
    const pool = { query: async () => ({ rows: [row] }) } as unknown as pg.Pool
    const out = await createGetFullTool(pool).execute({ id: 'row-codex' })
    expect(out).toContain('## Full payload for row-codex')
    expect(out).toContain(big)
  })

  it('recovers truncated pi v3 content, reasoning, and tool result from disk', async () => {
    const bigUser = 'u'.repeat(30_000)
    const bigThink = 'r'.repeat(20_000)
    const bigResult = 't'.repeat(25_000)
    const dir = mkdtempSync(join(tmpdir(), 'getfull-pi-'))
    const file = join(dir, '2026-09-11T14-25-16-803Z_01a091f5-6deb-723d-8737-eb83070c9154.jsonl')
    const lines = [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: '01a091f5-6deb-723d-8737-eb83070c9154',
      }),
      JSON.stringify({
        type: 'message',
        id: 'aa11bb22',
        message: { role: 'user', content: [{ type: 'text', text: bigUser }] },
      }),
      JSON.stringify({
        type: 'message',
        id: 'cc33dd44',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: bigThink },
            { type: 'text', text: 'ok' },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'ee55ff66',
        message: {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'bash',
          content: [{ type: 'text', text: bigResult }],
        },
      }),
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const piMeta = (line: number, extra: Record<string, unknown>) => ({
      truncated: true,
      source: 'pi-session',
      session_jsonl_path: file,
      session_jsonl_line: line,
      ...extra,
    })

    const userRow = {
      id: 'row-pi-user',
      content: 'preview…',
      tool_name: null,
      tool_result: null,
      agent: 'rivet-deepseek',
      metadata: piMeta(1, { full_content_length: bigUser.length, sourceEvent: 'message:user' }),
    }
    const thinkRow = {
      id: 'row-pi-think',
      content: 'ok',
      tool_name: null,
      tool_result: null,
      agent: 'rivet-deepseek',
      metadata: piMeta(2, {
        full_reasoning_length: bigThink.length,
        sourceEvent: 'message:assistant',
      }),
    }
    const resultRow = {
      id: 'row-pi-result',
      content: '[tool-result] bash',
      tool_name: 'bash',
      tool_result: 'preview…',
      agent: 'rivet-deepseek',
      metadata: piMeta(3, {
        full_tool_result_length: bigResult.length,
        sourceEvent: 'message:toolResult',
      }),
    }
    const rows = {
      'row-pi-user': userRow,
      'row-pi-think': thinkRow,
      'row-pi-result': resultRow,
    }
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        const id = String(params[0] ?? '')
        return { rows: [rows[id as keyof typeof rows]] }
      },
    } as unknown as pg.Pool
    const tool = createGetFullTool(pool)

    const userOut = await tool.execute({ id: 'row-pi-user' })
    expect(userOut).toContain('## Full payload for row-pi-user')
    expect(userOut).toContain(bigUser)

    const thinkOut = await tool.execute({ id: 'row-pi-think' })
    expect(thinkOut).toContain('### reasoning')
    expect(thinkOut).toContain(bigThink)

    const resultOut = await tool.execute({ id: 'row-pi-result' })
    expect(resultOut).toContain('### tool_result')
    expect(resultOut).toContain(bigResult)
  })
})
