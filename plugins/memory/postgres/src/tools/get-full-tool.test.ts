import { describe, expect, it } from 'vitest'
import { extractFullFromLine } from './get-full-tool.js'
import { truncationHint } from './helpers.js'

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
