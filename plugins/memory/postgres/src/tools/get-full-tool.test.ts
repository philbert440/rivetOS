import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  createGetFullTool,
  extractFullFromLine,
  formatMissingJsonlMessage,
  readJsonlLine,
} from './get-full-tool.js'
import { truncationHint } from './helpers.js'

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
    const msg = formatMissingJsonlMessage(
      '/home/philip/.grok/sessions/foo/updates.jsonl',
    )
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
})
